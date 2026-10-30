/**
 * `DreamAuthorization` — look up a user authorization entry (F-06 R-5.4.5,
 * Q-18, route §2.3 M3).
 *
 * The task tier may only do things the user explicitly authorized, and the
 * requirement is blunt about the failure mode: "no entry" means "not
 * authorized", and a run may **never** infer authorization from something the
 * user said earlier in a conversation. This tool is the only read path, so the
 * answer is either an entry (with its scope, expiry, source conversation and the
 * user's own words) or an explicit "no authorization".
 *
 * ## The entry carrier (minimal, reviewable convention)
 *
 * Entries live in one Markdown file in the agent's memory repository:
 *
 * - `<memory>/authorization.md`, or
 * - `<memory>/system/authorization.md` for legacy layouts (`system/` is the
 *   only projected directory there).
 *
 * The first existing file wins; the two are not merged. The file is ordinary
 * memory Markdown, so the normal pre-commit validation applies. Structure:
 *
 * ```markdown
 * ---
 * name: Authorizations
 * description: Tasks the user explicitly authorized for unattended runs
 * ---
 *
 * ## Tidy the projects folder
 * - scope: memory:projects/**
 * - expires: 2026-11-30
 * - source: local-conv-abc123
 * - quote: "整理一下 projects 下重复的笔记"
 * ```
 *
 * One entry starts at a `## ` heading and runs to the next heading. The heading
 * is the entry's title. Fields are `- key: value` lines (continuation lines are
 * appended to the previous field):
 *
 * - `scope` (required): what the entry covers, free text — e.g.
 *   `memory:projects/**`, `workspace:docs/notes.md`, or a short description.
 * - `expires` (required): `YYYY-MM-DD` (UTC, inclusive) or `never`.
 * - `source` (required): the conversation id the authorization came from.
 * - `quote` (required): the user's original words. Authorization is only
 *   believable when the run can quote it.
 *
 * A malformed entry is ignored and reported as malformed — never half-read,
 * because half an entry is not an authorization. The tool is read-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentAgentId } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getBackend } from "@/backend";
import { getRuntimeContext } from "@/runtime-context";

const TOOL_NAME = "DreamAuthorization";

/**
 * The task tier's discipline. The tool cannot verify a quote against a user
 * conversation, so it says out loud that unverified is not permission: writing
 * or editing an entry to authorize the agent's own work is itself a discipline
 * violation, not a way to pass the gate.
 */
const AUTHORIZATION_DISCIPLINE =
  "Entries must quote the user's own words. Writing or editing an authorization entry to cover your own work violates the task-tier discipline, and an unverified quote is not permission: do not manufacture or amend entries.";

/** The preferred carrier, relative to the memory repository root. */
export const DREAM_AUTHORIZATION_PATH = "authorization.md";
/** The legacy-layout carrier, read when the preferred file does not exist. */
export const DREAM_AUTHORIZATION_LEGACY_PATH = "system/authorization.md";

/** Required labels on every entry. */
export const DREAM_AUTHORIZATION_REQUIRED_FIELDS = [
  "scope",
  "expires",
  "source",
  "quote",
] as const;

export type DreamAuthorizationField =
  (typeof DREAM_AUTHORIZATION_REQUIRED_FIELDS)[number];

export interface DreamAuthorizationEntry {
  /** Heading text; the human name of the authorization. */
  title: string;
  /** 1-based line of the heading, for pointing at the file. */
  line: number;
  scope: string;
  /** `YYYY-MM-DD` (UTC, inclusive) or `null` for "never". */
  expires: string | null;
  source: string;
  quote: string;
}

export interface DreamAuthorizationParseResult {
  entries: DreamAuthorizationEntry[];
  /** One line per entry that was dropped, with its heading and reason. */
  problems: string[];
}

/** One entry plus the facts the tool reports about it. */
export interface ResolvedAuthorizationEntry extends DreamAuthorizationEntry {
  active: boolean;
}

export interface DreamAuthorizationArgs {
  query?: unknown;
  include_expired?: unknown;
}

/** Injection seams for tests; production callers pass nothing. */
export interface DreamAuthorizationDeps {
  agentId?: string;
  memoryDir?: string;
  /** Milliseconds since epoch; tests pin it, production reads the clock. */
  now?: number;
}

export interface DreamAuthorizationResult {
  content: string;
  status: "success" | "error";
}

const HEADING_PATTERN = /^##\s+(.*)$/;
const FIELD_PATTERN = /^\s*[-*]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const EXPIRES_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function error(content: string): DreamAuthorizationResult {
  return { content, status: "error" };
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`")
    ) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** Whether a `YYYY-MM-DD` string is a real calendar date. */
function isValidDateString(value: string): boolean {
  const match = EXPIRES_PATTERN.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

function normalizeExpires(raw: string): string | null | undefined {
  const value = stripOuterQuotes(raw);
  if (value.toLowerCase() === "never") return null;
  if (!isValidDateString(value)) return undefined;
  return value;
}

/**
 * Parse the authorization file.
 *
 * Never throws on content: a malformed entry contributes a `problems` line and
 * is dropped whole. Frontmatter and prose before the first heading are ignored.
 */
export function parseDreamAuthorizationEntries(
  markdown: string,
): DreamAuthorizationParseResult {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex(
      (line, index) => index > 0 && line.trim() === "---",
    );
    if (close >= 0) start = close + 1;
  }

  interface Draft {
    title: string;
    line: number;
    fields: Partial<Record<DreamAuthorizationField, string>>;
    /** The field a continuation line belongs to. */
    lastField: DreamAuthorizationField | null;
  }

  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const heading = HEADING_PATTERN.exec(raw);
    if (heading !== null) {
      const title = (heading[1] ?? "").trim();
      current = { title, line: index + 1, fields: {}, lastField: null };
      drafts.push(current);
      continue;
    }
    if (current === null) continue;
    if (raw.trim().length === 0) {
      current.lastField = null;
      continue;
    }
    const field = FIELD_PATTERN.exec(raw);
    if (field !== null) {
      const key = (field[1] ?? "").toLowerCase();
      if (
        key === "scope" ||
        key === "expires" ||
        key === "source" ||
        key === "quote"
      ) {
        const previous = current.fields[key];
        current.fields[key] = previous
          ? `${previous}\n${(field[2] ?? "").trim()}`
          : (field[2] ?? "").trim();
        current.lastField = key;
        continue;
      }
      // An unknown `- key:` line may be prose inside a quote; only continuation
      // handling needs to know about the last field, so leave it alone.
      current.lastField = null;
      continue;
    }
    if (current.lastField !== null) {
      const previous = current.fields[current.lastField] ?? "";
      current.fields[current.lastField] = previous
        ? `${previous}\n${raw.trim()}`
        : raw.trim();
    }
  }

  const entries: DreamAuthorizationEntry[] = [];
  const problems: string[] = [];
  for (const draft of drafts) {
    // Normalize first, then judge: `- scope: ""` has two characters but says
    // nothing, and treating it as present would turn an empty entry into an
    // ACTIVE authorization (F-06 review finding).
    const scope = stripOuterQuotes(draft.fields.scope ?? "");
    const source = stripOuterQuotes(draft.fields.source ?? "");
    const quote = stripOuterQuotes(draft.fields.quote ?? "");
    const rawExpires = stripOuterQuotes(draft.fields.expires ?? "");
    const missing: string[] = [];
    if (scope.length === 0) missing.push("scope");
    if (rawExpires.length === 0) missing.push("expires");
    if (source.length === 0) missing.push("source");
    if (quote.length === 0) missing.push("quote");
    if (missing.length > 0) {
      problems.push(
        `line ${draft.line}: "${draft.title || "(untitled entry)"}" is missing required field${missing.length === 1 ? "" : "s"} ${missing.join(", ")} — ignored, so it authorizes nothing.`,
      );
      continue;
    }
    const expires = normalizeExpires(rawExpires);
    if (expires === undefined) {
      problems.push(
        `line ${draft.line}: "${draft.title || "(untitled entry)"}" has an invalid \`expires\` value ${JSON.stringify(draft.fields.expires)} — use YYYY-MM-DD or never; the entry is ignored.`,
      );
      continue;
    }
    entries.push({
      title: draft.title,
      line: draft.line,
      scope,
      expires,
      source,
      quote,
    });
  }
  return { entries, problems };
}

/** The UTC date `YYYY-MM-DD` for an epoch-ms time. */
export function utcDateString(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Active means "not expired": an entry expires at the end of its `expires` day
 * (UTC), and `never` never expires. String comparison is safe for `YYYY-MM-DD`.
 */
export function isAuthorizationActive(
  entry: Pick<DreamAuthorizationEntry, "expires">,
  now: number,
): boolean {
  if (entry.expires === null) return true;
  return utcDateString(now) <= entry.expires;
}

function resolveAgentId(deps: DreamAuthorizationDeps): string | null {
  if (deps.agentId) return deps.agentId;
  const runtimeAgentId = getRuntimeContext()?.agentId;
  if (typeof runtimeAgentId === "string" && runtimeAgentId.length > 0) {
    return runtimeAgentId;
  }
  try {
    return getCurrentAgentId();
  } catch {
    return null;
  }
}

function resolveMemoryDir(
  agentId: string,
  deps: DreamAuthorizationDeps,
): { memoryDir: string } | { error: string } {
  if (deps.memoryDir) return { memoryDir: deps.memoryDir };
  if (!getBackend().capabilities.localMemfs) {
    return {
      error: `${TOOL_NAME}: authorization entries live in the local backend's memory repository, and this process is not using it.`,
    };
  }
  return { memoryDir: getScopedMemoryFilesystemRoot(agentId) };
}

function findAuthorizationFile(memoryDir: string): string | null {
  for (const relative of [
    DREAM_AUTHORIZATION_PATH,
    DREAM_AUTHORIZATION_LEGACY_PATH,
  ]) {
    const absolute = join(memoryDir, ...relative.split("/"));
    if (existsSync(absolute)) return relative;
  }
  return null;
}

function formatEntry(entry: ResolvedAuthorizationEntry, index: number): string {
  const state = entry.active
    ? `ACTIVE${entry.expires === null ? " (never expires)" : ` (expires ${entry.expires})`}`
    : `EXPIRED on ${entry.expires}`;
  return [
    `${index + 1}. ${entry.title || "(untitled entry)"} — ${state}`,
    `   scope: ${entry.scope}`,
    `   source: ${entry.source}`,
    `   quote: ${entry.quote}`,
  ].join("\n");
}

/**
 * Look up authorization entries covering the current task.
 *
 * `query` filters on title, scope, quote and source, case-insensitively.
 * Without it, every active entry is reported (a model checking "am I authorized
 * to do this?" needs the entries, not a keyword search). Expired entries are
 * hidden unless `include_expired` is true, but the count is always reported so
 * "no active entries" is not confused with "the file does not exist".
 */
export async function dream_authorization(
  args: DreamAuthorizationArgs,
  deps: DreamAuthorizationDeps = {},
): Promise<DreamAuthorizationResult> {
  let query: string | undefined;
  if (args.query !== undefined) {
    if (typeof args.query !== "string") {
      return error(`${TOOL_NAME}: "query" must be a string when provided.`);
    }
    const trimmed = args.query.trim();
    if (trimmed.length > 0) query = trimmed;
  }
  const includeExpired = args.include_expired === true;

  const agentId = resolveAgentId(deps);
  if (agentId === null) {
    return error(
      `${TOOL_NAME}: no agent is available in this execution context, so there is no memory repository to read authorizations from.`,
    );
  }
  const resolved = resolveMemoryDir(agentId, deps);
  if ("error" in resolved) return error(resolved.error);

  const relativePath = findAuthorizationFile(resolved.memoryDir);
  if (relativePath === null) {
    return {
      content: [
        `${TOOL_NAME}: no authorization entries exist.`,
        `Looked for ${DREAM_AUTHORIZATION_PATH} and ${DREAM_AUTHORIZATION_LEGACY_PATH} in the memory repository; neither exists.`,
        "No authorization: do not infer one from earlier conversation, and skip anything that would need it.",
      ].join("\n"),
      status: "success",
    };
  }

  let markdown: string;
  try {
    markdown = readFileSync(
      join(resolved.memoryDir, ...relativePath.split("/")),
      "utf8",
    );
  } catch {
    return error(
      `${TOOL_NAME}: could not read ${relativePath} from the memory repository.`,
    );
  }

  const now = deps.now ?? Date.now();
  const parsed = parseDreamAuthorizationEntries(markdown);
  const resolvedEntries: ResolvedAuthorizationEntry[] = parsed.entries.map(
    (entry) => ({ ...entry, active: isAuthorizationActive(entry, now) }),
  );
  const needle = query?.toLowerCase();
  const matching = resolvedEntries.filter((entry) => {
    if (needle === undefined) return true;
    return [entry.title, entry.scope, entry.source, entry.quote]
      .join("\n")
      .toLowerCase()
      .includes(needle);
  });
  const reported = matching.filter((entry) => includeExpired || entry.active);
  const expiredHidden = matching.length - reported.length;

  const lines: string[] = [];
  if (reported.length === 0) {
    lines.push(
      needle === undefined
        ? `${TOOL_NAME}: the authorization file (${relativePath}) has no active authorization entries.`
        : `${TOOL_NAME}: no authorization entry in ${relativePath} matches "${query}".`,
    );
    lines.push(
      "No authorization: do not infer one from earlier conversation, and skip anything that would need it.",
    );
    lines.push(AUTHORIZATION_DISCIPLINE);
  } else {
    lines.push(
      `${TOOL_NAME}: ${reported.length} matching authorization entr${reported.length === 1 ? "y" : "ies"} in ${relativePath} (read-only).`,
    );
    reported.forEach((entry, index) => {
      lines.push(formatEntry(entry, index));
    });
    lines.push(
      "An entry authorizes only what its scope and quote say, and only until it expires. A task not covered by one of these entries is not authorized.",
    );
    lines.push(AUTHORIZATION_DISCIPLINE);
  }
  if (expiredHidden > 0) {
    lines.push(
      `(${expiredHidden} expired entr${expiredHidden === 1 ? "y is" : "ies are"} not shown; pass include_expired: true to see them.)`,
    );
  }
  for (const problem of parsed.problems) {
    lines.push(`(malformed entry ignored — ${problem})`);
  }
  return { content: lines.join("\n"), status: "success" };
}
