/**
 * Export scope: the one table that decides what goes into a package, plus the
 * traversal that turns it into entries.
 *
 * `SCOPE_RULES` is the contract: 21 include rows and 20 exclude rows, in the
 * order of the requirement doc's appendix B (docs/44-2 §5.3 + appendix B;
 * docs/45-2 §2.4). Explicit manifestations only — never iterate `APP_SUBDIRS`,
 * because a new app directory must not start being exported by accident.
 *
 * Two root families (docs/45-2 §1 "路径不一致"): everything under the home tree
 * resolves from `appHomeRoot()`, which honours `HARUYUKI_HOME`; `channels/` and
 * `transcripts/` are written through the literal `homedir()` root, and the
 * WhatsApp session credentials live inside `channels/`, so those two entries
 * follow the literal root instead. A run that relocates only `HARUYUKI_HOME`
 * therefore still reads the channels and transcripts of the real home
 * directory — that split is intentional and covered by the tests.
 */

import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_DIR_NAME, appHomeRoot } from "@/utils/app-paths";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";
import type {
  SnapshotCliDeps,
  SnapshotExclusion,
  SnapshotScope,
} from "./types";
import { snapshotError } from "./types";

/** One include/exclude rule. `include: false` wins over any include. */
export interface ScopeRule {
  /** Package-relative glob, `/`-separated. */
  pattern: string;
  scope: SnapshotScope;
  include: boolean;
  /** Why this rule exists — printed in `--verbose` and kept next to the list. */
  reason: string;
  /**
   * Sub-directories under this rule's own directory that are still excluded.
   * Only `home/mods/**` uses it: its `diagnostics/` sub-tree is derived output,
   * and appendix B folds that into the include row instead of adding a 21st
   * exclude row.
   */
  nestedExcludes?: readonly string[];
}

/**
 * The scope table. Excluded paths are neither stat-ed nor read: the walk prunes
 * them before it touches them.
 *
 * Reasons are user-visible (they end up in `manifest.excluded` and in
 * `--verbose`), so they say why the path is in or out, not just that it is.
 */
export const SCOPE_RULES: ScopeRule[] = [
  // A. user-level root -> `home/` (13 include rows)
  {
    pattern: "home/settings.json",
    scope: "home",
    include: true,
    reason:
      "global settings: permissions, sessionsByServer and recentModels (packaged as the sanitised copy)",
  },
  {
    pattern: "home/settings.local.json",
    scope: "home",
    include: true,
    reason:
      "root-level local settings, written when the working directory is the harness root",
  },
  {
    pattern: "home/sessions.jsonl",
    scope: "home",
    include: true,
    reason: "session start/stop ledger; /resume history depends on it",
  },
  {
    pattern: "home/crons.json",
    scope: "home",
    include: true,
    reason: "cron definitions; the scheduler lease is cleared on import",
  },
  {
    pattern: "home/runs/**",
    scope: "home",
    include: true,
    reason: "cron run logs, trimmed per task",
  },
  {
    pattern: "home/usage/**",
    scope: "home",
    include: true,
    reason: "per-turn usage ledger; it cannot be rebuilt from conversations",
  },
  {
    pattern: "home/transcripts/**",
    scope: "home",
    include: true,
    reason: "reflection and subagent transcripts, including background/",
  },
  {
    pattern: "home/channels/**",
    scope: "home",
    include: true,
    reason: "channel accounts plus the WhatsApp session credentials",
  },
  {
    pattern: "home/skills/**",
    scope: "home",
    include: true,
    reason: "global skills",
  },
  {
    pattern: "home/commands/**",
    scope: "home",
    include: true,
    reason: "custom slash commands",
  },
  {
    pattern: "home/mods/**",
    scope: "home",
    include: true,
    reason: "user mod sources; the diagnostics sub-tree is derived",
    nestedExcludes: ["diagnostics"],
  },
  {
    pattern: "home/extensions/**",
    scope: "home",
    include: true,
    reason: "legacy extensions, when present",
  },
  {
    pattern: "home/agents/**",
    scope: "home",
    include: true,
    reason: "pre-experimental memory roots and agent directories, when present",
  },

  // B. storage root -> `local-backend/` (6 include rows)
  {
    pattern: "local-backend/agents/*.json",
    scope: "local-backend",
    include: true,
    reason: "agent records: name, model, model_settings, personality",
  },
  {
    pattern: "local-backend/conversations/*/conversation.json",
    scope: "local-backend",
    include: true,
    reason: "conversation record",
  },
  {
    pattern: "local-backend/conversations/*/manifest.json",
    scope: "local-backend",
    include: true,
    reason: "transcript schema and format version",
  },
  {
    pattern: "local-backend/conversations/*/messages.jsonl",
    scope: "local-backend",
    include: true,
    reason: "the only real message log",
  },
  {
    pattern: "local-backend/memfs/*/memory/**",
    scope: "local-backend",
    include: true,
    reason: "memory repository including .git and its full history",
  },
  {
    pattern: "local-backend/providers/auth.json",
    scope: "local-backend",
    include: true,
    reason: "provider API keys and OAuth tokens",
  },

  // C. project tree (1 include row, only with --with-project)
  {
    pattern: "project/**",
    scope: "project",
    include: true,
    reason: "project-level data; only exported when --with-project is passed",
  },

  // D. generated at pack time (1 include row, never walked from disk)
  {
    pattern: "secrets.json",
    scope: "secrets",
    include: true,
    reason: "settings tokens, agent secrets and channel credentials",
  },

  // E. exclusions (20 rows)
  {
    pattern: "home/logs/**",
    scope: "home",
    include: false,
    reason:
      "debug, feedback and boundary-error logs: voluminous and useless elsewhere",
  },
  {
    pattern: "home/cache/**",
    scope: "home",
    include: false,
    reason: "derived cache, rebuilt on demand",
  },
  {
    pattern: "home/mod-cache/**",
    scope: "home",
    include: false,
    reason: "compiled mod cache, derived",
  },
  {
    pattern: "home/bin/**",
    scope: "home",
    include: false,
    reason: "downloaded tool binaries, platform specific",
  },
  {
    pattern: "home/viewers/**",
    scope: "home",
    include: false,
    reason: "generated HTML viewers",
  },
  {
    pattern: "home/artifacts/**",
    scope: "home",
    include: false,
    reason: "generated artifact files",
  },
  {
    pattern: "home/workflows/**",
    scope: "home",
    include: false,
    reason: "workflow execution output: scripts, parameters and journal",
  },
  {
    pattern: "home/notifications/**",
    scope: "home",
    include: false,
    reason: "toast history, capped and disposable",
  },
  {
    pattern: "home/projects/**",
    scope: "home",
    include: false,
    reason:
      "per-project agent-tools spill and derived state; appendix B excludes the whole tree",
  },
  {
    pattern: "home/plans/**",
    scope: "home",
    include: false,
    reason: "declared but unconsumed",
  },
  {
    pattern: "home/worktrees/**",
    scope: "home",
    include: false,
    reason: "git-bound managed worktrees",
  },
  {
    pattern: "home/backups/**",
    scope: "home",
    include: false,
    reason:
      "our own pre-import backups; excluding them keeps a package from nesting inside the next",
  },
  {
    pattern: "local-backend/conversations/*/system-prompt.json",
    scope: "local-backend",
    include: false,
    reason: "compiled snapshot, derived",
  },
  {
    pattern: "local-backend/conversations/*/recall-index.json",
    scope: "local-backend",
    include: false,
    reason: "recall index, derived",
  },
  {
    pattern: "local-backend/conversations/*/messages.jsonl.pre-pi-backup-*",
    scope: "local-backend",
    include: false,
    reason: "one-off migration backup",
  },
  {
    pattern: "local-backend/memfs/*/memory-worktrees/**",
    scope: "local-backend",
    include: false,
    reason: "temporary git worktrees",
  },
  {
    pattern: "local-backend/secrets/local-agent-secrets.json",
    scope: "local-backend",
    include: false,
    reason:
      "agent secret values travel in secrets.json; shipping the file too would create two copies",
  },
  {
    pattern: "project/.haruyuki/worktrees/**",
    scope: "project",
    include: false,
    reason: "git-bound managed worktrees",
  },
  {
    pattern: "project/.git/**",
    scope: "project",
    include: false,
    reason: "git metadata belongs to the project, not to the snapshot",
  },
  {
    pattern: "project/node_modules/**",
    scope: "project",
    include: false,
    reason: "dependencies are reinstalled, not shipped",
  },
];

/**
 * SHA-256 of zero bytes. A directory entry in `manifest.entries` carries
 * `bytes: 0` and this digest, so the archive writer and the verifier agree on
 * what "the content of a directory" hashes to.
 */
export const DIRECTORY_ENTRY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * The `home/` entries that resolve from the literal `homedir()` root instead of
 * `appHomeRoot()` (docs/45-2 §1 "路径不一致"). Anything not listed here — and
 * every future entry by default — resolves from the app home root.
 */
const HOME_ROOT_FAMILY: Readonly<Record<string, "homedir">> = {
  channels: "homedir",
  transcripts: "homedir",
};

/**
 * The two families of source root. `channels/`, `transcripts/` and the WhatsApp
 * auth files resolve from the literal home directory and do NOT honour
 * `HARUYUKI_HOME`; everything else resolves from the app home root. A test that
 * relocates only `HARUYUKI_HOME` must expect that split.
 */
export interface ScopeRoots {
  /** `appHomeRoot()` — honours `HARUYUKI_HOME`. */
  appHome: string;
  /** Local backend storage root (`LETTA_LOCAL_BACKEND_DIR`). */
  storageDir: string;
  /** Literal `homedir()` root for the paths that ignore `HARUYUKI_HOME`. */
  homedirRoot: string;
}

/** One collected source path, before it becomes a `SnapshotEntry`. */
export interface ScopeEntry {
  /** Package-relative path. */
  path: string;
  /** Absolute source path on this machine. */
  absolutePath: string;
  scope: SnapshotScope;
  kind: "file" | "dir";
  bytes: number;
}

export interface CollectEntriesOptions {
  /** Absolute project directory to include, when the caller passed one. */
  project?: string;
  /** Non-fatal observations (symlink followed, case collision…) for the manifest. */
  onWarning?: (message: string) => void;
  /**
   * Called once per excluded path that actually exists on disk — never for a
   * path that was not visited, and never once per descendant. `manifest.excluded`
   * defaults to the rule table itself; this callback is the evidence of what the
   * walk really skipped.
   */
  onExcluded?: (exclusion: SnapshotExclusion) => void;
}

/**
 * The exclude rows, in table order, as manifest-shaped exclusions. This is what
 * `buildManifest` uses when the caller has nothing better: the rule table is the
 * contract, so it is recorded in full (20 entries) whether or not each path
 * exists on this machine.
 */
export function scopeExclusions(): SnapshotExclusion[] {
  return SCOPE_RULES.filter((rule) => !rule.include).map((rule) => ({
    path: rule.pattern,
    reason: rule.reason,
  }));
}

/** Resolve the roots for this invocation, honouring the injected deps. */
export function resolveHomeRoots(deps?: SnapshotCliDeps): ScopeRoots {
  return {
    appHome: deps?.homeRoot ?? appHomeRoot(),
    // The storage root keeps its own resolution (env override first, then the
    // app home root); `deps.homeRoot` deliberately does not move it, because a
    // caller that relocates the harness root would otherwise silently relocate
    // the local backend too.
    storageDir: deps?.storageDir ?? getLocalBackendStorageDir(),
    // Literal `homedir()` on purpose: this is the root that ignores HARUYUKI_HOME.
    homedirRoot: homedir(),
  };
}

/* ------------------------------------------------------------------ */
/* Pattern matching                                                     */
/* ------------------------------------------------------------------ */

const matcherCache = new Map<string, RegExp>();

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "^";
  for (const [index, segment] of segments.entries()) {
    if (segment === "**") {
      // Zero or more path segments, so the directory itself matches too.
      source += "(?:/[^/]+)*";
      continue;
    }
    const body = segment.includes("*")
      ? segment.split("*").map(escapeRegExp).join("[^/]*")
      : escapeRegExp(segment);
    source += index === 0 ? body : `/${body}`;
  }
  return new RegExp(`${source}$`);
}

function scopeMatcher(pattern: string): RegExp {
  const cached = matcherCache.get(pattern);
  if (cached) return cached;
  const compiled = compilePattern(pattern);
  matcherCache.set(pattern, compiled);
  return compiled;
}

/** True when a package-relative path falls under `pattern` (appendices A/B). */
export function matchesScopePattern(
  pattern: string,
  archivePath: string,
): boolean {
  return scopeMatcher(pattern).test(archivePath);
}

/**
 * Windows and macOS are case-insensitive: two names that differ only in case in
 * one directory cannot both be restored, so the export aborts (`path_conflict`).
 * Exported because a case-insensitive test filesystem cannot create the
 * colliding pair to exercise it through the walk.
 */
export function assertNoCaseCollision(
  directory: string,
  names: readonly string[],
): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined && previous !== name) {
      throw snapshotError(
        "path_conflict",
        `case-only name collision in ${directory}: "${previous}" and "${name}" cannot both be restored`,
      );
    }
    seen.set(key, name);
  }
}

/* ------------------------------------------------------------------ */
/* Traversal                                                            */
/* ------------------------------------------------------------------ */

interface ExclusionMatcher {
  pattern: string;
  reason: string;
  matcher: RegExp;
}

interface DirChild {
  name: string;
  absolutePath: string;
  archivePath: string;
  kind: "file" | "dir" | "symlink" | "other";
}

interface TreeWalk {
  scope: SnapshotScope;
  entries: Map<string, ScopeEntry>;
  exclusions: ExclusionMatcher[];
  warnings: (message: string) => void;
  onExcluded?: (exclusion: SnapshotExclusion) => void;
  reportedExcluded: Set<string>;
  /** Per-rule readdir cache, keyed by absolute directory. */
  listings: Map<string, DirChild[]>;
}

async function statOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exclusionsFor(rule: ScopeRule): ExclusionMatcher[] {
  const matchers = staticExclusionMatchers();
  const ownDirectory = rule.pattern.split("/").slice(0, -1).join("/");
  for (const nested of rule.nestedExcludes ?? []) {
    const pattern = `${ownDirectory}/${nested}/**`;
    matchers.push({
      pattern,
      reason: `${nested}/ under ${ownDirectory} is derived output`,
      matcher: scopeMatcher(pattern),
    });
  }
  return matchers;
}

function staticExclusionMatchers(): ExclusionMatcher[] {
  return SCOPE_RULES.filter((rule) => !rule.include).map((rule) => ({
    pattern: rule.pattern,
    reason: rule.reason,
    matcher: scopeMatcher(rule.pattern),
  }));
}

/**
 * Name one level of a tree root so the exclusions that stop a walk before it
 * starts still produce evidence.
 *
 * The include table is explicit, so most excluded directories are never even
 * listed (their parents are literals). Listing each root once — names only, no
 * stat, no descent — is what lets `--dry-run` and `--verbose` say "logs/ was
 * skipped" instead of silently omitting it, and it also gives the root the same
 * case-collision check every walked directory gets.
 */
async function reportRootExclusions(
  base: string,
  archivePrefix: string,
  exclusions: readonly ExclusionMatcher[],
  walk: TreeWalk,
): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(base, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw snapshotError(
      "io_error",
      `cannot list ${archivePrefix}: ${(error as Error).message}`,
    );
  }
  assertNoCaseCollision(
    base,
    dirents.map((dirent) => dirent.name),
  );
  const rootWalk: TreeWalk = { ...walk, exclusions: [...exclusions] };
  for (const dirent of dirents) {
    pruneIfExcluded(`${archivePrefix}/${dirent.name}`, rootWalk);
  }
}

function pruneIfExcluded(archivePath: string, walk: TreeWalk): boolean {
  for (const exclusion of walk.exclusions) {
    if (!exclusion.matcher.test(archivePath)) continue;
    if (!walk.reportedExcluded.has(archivePath)) {
      walk.reportedExcluded.add(archivePath);
      walk.onExcluded?.({ path: archivePath, reason: exclusion.reason });
    }
    return true;
  }
  return false;
}

/**
 * One readdir of one directory for this rule walk, cached so the literal
 * segments that share a parent (`conversation.json`, `manifest.json`,
 * `messages.jsonl`) do not re-list it.
 *
 * Excluded children are dropped HERE — before any stat — which is what keeps an
 * excluded path from being touched, and what makes the skip observable: a
 * sibling of an included file is named during the listing even though no rule
 * walks into it.
 */
async function listChildren(
  directory: string,
  archivePath: string,
  walk: TreeWalk,
): Promise<DirChild[]> {
  const cached = walk.listings.get(directory);
  if (cached) return cached;
  let dirents: Dirent[];
  try {
    dirents = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      walk.listings.set(directory, []);
      return [];
    }
    throw snapshotError(
      "io_error",
      `cannot list ${archivePath}: ${(error as Error).message}`,
    );
  }
  assertNoCaseCollision(
    directory,
    dirents.map((dirent) => dirent.name),
  );
  const children: DirChild[] = [];
  for (const dirent of dirents) {
    const child: DirChild = {
      name: dirent.name,
      absolutePath: join(directory, dirent.name),
      archivePath: `${archivePath}/${dirent.name}`,
      kind: dirent.isSymbolicLink()
        ? "symlink"
        : dirent.isDirectory()
          ? "dir"
          : dirent.isFile()
            ? "file"
            : "other",
    };
    if (pruneIfExcluded(child.archivePath, walk)) continue;
    children.push(child);
  }
  walk.listings.set(directory, children);
  return children;
}

/**
 * Resolve a listed child to a real kind and its byte size. Symbolic links are
 * followed (a file link is packed as its target's content, a directory link is
 * walked); an unresolvable link aborts the export rather than producing a
 * package with a hole in it.
 */
async function resolveChild(
  child: DirChild,
  walk: TreeWalk,
): Promise<{ kind: "file" | "dir"; bytes: number } | undefined> {
  if (child.kind === "dir") return { kind: "dir", bytes: 0 };
  if (child.kind === "other") {
    walk.warnings(`skipped special file ${child.archivePath}`);
    return undefined;
  }
  if (child.kind === "symlink") {
    const followed = await statOrUndefined(child.absolutePath);
    if (!followed) {
      throw snapshotError(
        "io_error",
        `symbolic link cannot be followed: ${child.archivePath}`,
      );
    }
    walk.warnings(`followed symbolic link ${child.archivePath}`);
    if (followed.isDirectory()) return { kind: "dir", bytes: 0 };
    if (followed.isFile()) return { kind: "file", bytes: followed.size };
    return undefined;
  }
  const fileStats = await statOrUndefined(child.absolutePath);
  if (!fileStats?.isFile()) {
    walk.warnings(`skipped unreadable file ${child.archivePath}`);
    return undefined;
  }
  return { kind: "file", bytes: fileStats.size };
}

function recordEntry(
  archivePath: string,
  absolutePath: string,
  kind: "file" | "dir",
  bytes: number,
  walk: TreeWalk,
): void {
  if (walk.entries.has(archivePath)) return;
  walk.entries.set(archivePath, {
    path: archivePath,
    absolutePath,
    scope: walk.scope,
    kind,
    bytes,
  });
}

/**
 * Add one path whose kind is not known yet — the zero-segment branch of a `**`
 * rule, which is how a rule's own directory (and therefore an empty directory)
 * becomes an entry. Missing paths are silently absent, not warnings: every
 * optional scope directory is allowed not to exist.
 */
async function addPathEntry(
  archivePath: string,
  absolutePath: string,
  walk: TreeWalk,
): Promise<void> {
  if (walk.entries.has(archivePath)) return;
  const target = await statOrUndefined(absolutePath);
  if (!target) return;
  if (target.isDirectory()) {
    recordEntry(archivePath, absolutePath, "dir", 0, walk);
    return;
  }
  if (!target.isFile()) {
    walk.warnings(`skipped special file ${archivePath}`);
    return;
  }
  recordEntry(archivePath, absolutePath, "file", target.size, walk);
}

async function addListedChild(child: DirChild, walk: TreeWalk): Promise<void> {
  if (walk.entries.has(child.archivePath)) return;
  const resolved = await resolveChild(child, walk);
  if (!resolved) return;
  recordEntry(
    child.archivePath,
    child.absolutePath,
    resolved.kind,
    resolved.bytes,
    walk,
  );
}

/**
 * Expand one rule pattern against one source root.
 *
 * A segment of `**` matches zero or more path segments; a segment containing
 * `*` matches within one directory; anything else is a literal. Directories
 * reached through `**` are emitted as their own entries so empty directories
 * survive the package (docs/44-2 §5.2.4), and every child is checked against
 * the exclusion rows BEFORE it is stat-ed or read.
 */
async function expandPattern(
  segments: readonly string[],
  directory: string,
  archivePath: string,
  walk: TreeWalk,
): Promise<void> {
  const segment = segments[0];
  if (segment === undefined) {
    await addPathEntry(archivePath, directory, walk);
    return;
  }
  const rest = segments.slice(1);

  if (segment === "**") {
    // Zero segments keeps the current level (this is also how the rule's own
    // directory becomes an entry); one or more walks every child. The listing
    // has already dropped the excluded children.
    await expandPattern(rest, directory, archivePath, walk);
    for (const child of await listChildren(directory, archivePath, walk)) {
      if (child.kind === "dir" || child.kind === "symlink") {
        const resolved = await resolveChild(child, walk);
        if (!resolved) continue;
        if (resolved.kind === "dir") {
          await expandPattern(
            segments,
            child.absolutePath,
            child.archivePath,
            walk,
          );
        } else if (rest.length === 0) {
          recordEntry(
            child.archivePath,
            child.absolutePath,
            "file",
            resolved.bytes,
            walk,
          );
        }
        continue;
      }
      if (rest.length === 0) await addListedChild(child, walk);
    }
    return;
  }

  if (segment.includes("*")) {
    const segmentMatcher = new RegExp(
      `^${segment.split("*").map(escapeRegExp).join("[^/]*")}$`,
    );
    for (const child of await listChildren(directory, archivePath, walk)) {
      if (!segmentMatcher.test(child.name)) continue;
      if (rest.length === 0) {
        await addListedChild(child, walk);
      } else if (child.kind === "dir") {
        await expandPattern(rest, child.absolutePath, child.archivePath, walk);
      }
    }
    return;
  }

  // A literal segment is looked up through its parent listing rather than
  // stat-ed directly, so the real on-disk casing is what gets recorded and the
  // siblings the exclusion table names are seen (and pruned) on the way through.
  const children = await listChildren(directory, archivePath, walk);
  const child = children.find((candidate) => candidate.name === segment);
  if (!child) return;
  if (rest.length === 0) {
    await addListedChild(child, walk);
    return;
  }
  const resolved = await resolveChild(child, walk);
  if (resolved?.kind !== "dir") return;
  await expandPattern(rest, child.absolutePath, child.archivePath, walk);
}

/** Which absolute directory a rule reads from (see the two root families). */
function sourceRootForRule(
  rule: ScopeRule,
  roots: ScopeRoots,
  opts: CollectEntriesOptions,
): string | undefined {
  if (rule.scope === "local-backend") return roots.storageDir;
  if (rule.scope === "project") return opts.project;
  if (rule.scope === "secrets") return undefined;
  const firstSegment = rule.pattern.split("/")[1] ?? "";
  return HOME_ROOT_FAMILY[firstSegment] === "homedir"
    ? join(roots.homedirRoot, APP_DIR_NAME)
    : roots.appHome;
}

async function collectTree(
  scope: SnapshotScope,
  roots: ScopeRoots,
  opts: CollectEntriesOptions,
): Promise<ScopeEntry[]> {
  const entries = new Map<string, ScopeEntry>();
  const reportedExcluded = new Set<string>();
  const staticExclusions = staticExclusionMatchers();
  const scannedRoots = new Set<string>();
  for (const rule of SCOPE_RULES) {
    if (!rule.include || rule.scope !== scope) continue;
    const base = sourceRootForRule(rule, roots, opts);
    if (!base) continue;
    const baseStats = await statOrUndefined(base);
    if (!baseStats?.isDirectory()) continue;
    const [prefix = ""] = rule.pattern.split("/");
    const walk: TreeWalk = {
      scope,
      entries,
      exclusions: exclusionsFor(rule),
      warnings: opts.onWarning ?? (() => {}),
      onExcluded: opts.onExcluded,
      reportedExcluded,
      listings: new Map(),
    };
    const scanKey = `${prefix}|${base}`;
    if (!scannedRoots.has(scanKey)) {
      scannedRoots.add(scanKey);
      await reportRootExclusions(base, prefix, staticExclusions, walk);
    }
    await expandPattern(rule.pattern.split("/").slice(1), base, prefix, walk);
  }
  return [...entries.values()].sort((left, right) =>
    compareUtf8(left.path, right.path),
  );
}

/**
 * Walk the explicit scope in package order:
 * `home/**` -> `local-backend/**` -> `project/**`, each sorted by UTF-8 byte
 * order so two exports of the same data produce the same entry list.
 *
 * `backups/` is always excluded, including from the pre-import backup itself,
 * so a backup can never nest inside the next one.
 */
export function collectEntries(
  roots: ScopeRoots,
  opts: CollectEntriesOptions = {},
): AsyncGenerator<ScopeEntry> {
  return walkAllTrees(roots, opts);
}

async function* walkAllTrees(
  roots: ScopeRoots,
  opts: CollectEntriesOptions,
): AsyncGenerator<ScopeEntry> {
  const treeOrder: SnapshotScope[] = ["home", "local-backend", "project"];
  for (const scope of treeOrder) {
    for (const entry of await collectTree(scope, roots, opts)) {
      yield entry;
    }
  }
}
