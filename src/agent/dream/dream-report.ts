/**
 * Dream report writer (F-06 M3, route §2.3.5 S4; requirement R-5.6.1–R-5.6.3,
 * Q-54 / Q-41).
 *
 * The agent writes the report **body**; the harness adds the v2 frontmatter,
 * makes sure the report directory has its `MEMORY.md` index, and commits the
 * report on its own. Three reasons this is not the agent's job:
 *
 * - the memory pre-commit hook validates frontmatter for the **whole staged
 *   tree**, so a malformed report would take the run's other memory writes down
 *   with it (route C-22);
 * - the report directory needs an index file, and an agent that forgets it
 *   turns its own report into a rejected commit;
 * - "the report is what the user reads when they come back" must hold even
 *   when the run's own commits are imperfect.
 *
 * The path is fixed and single-file (`R-5.6.3`): each run overwrites it, and git
 * history is the archive. `reportPath` is memory-repository-relative, so the
 * hidden-session viewer and the run record can point at it.
 *
 * The agent never commits this path (`dream-task.md` says so): committing it
 * here, alone, is the whole point of the split.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentAgentName } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { commitMemoryWrite } from "@/agent/memory-git";
import {
  DEFAULT_MEMORY_CONSTRAINTS_CONFIG,
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  parseMemoryConstraintsConfig,
} from "@/memory-constraints";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

/** First-level directory the report lives in (`R-5.6.2`, Q-41). */
export const DREAM_REPORT_DIR = "maintenance";
/** Fixed report filename: one file, overwritten each run (`R-5.6.3`). */
export const DREAM_REPORT_FILENAME = "dream-report.md";
/** Memory-repository-relative report path; also the frozen `reportPath` value. */
export const DREAM_REPORT_PATH = `${DREAM_REPORT_DIR}/${DREAM_REPORT_FILENAME}`;
/** The index file the report directory must carry to pass memory validation. */
export const DREAM_REPORT_INDEX_PATH = `${DREAM_REPORT_DIR}/MEMORY.md`;
/**
 * Body cap. The memory constraints limit a projected file to 20,000 characters
 * by default (including frontmatter), so the body is cut below that with a
 * visible notice rather than letting the whole commit fail. The effective limit
 * is read from the repository's `.memfs.config.json` when present — see
 * {@link resolveDreamReportFileLimit}.
 */
export const DREAM_REPORT_MAX_BODY_CHARS = 16_000;
/** Room for the two newlines around the body plus the trailing newline. */
const REPORT_FILE_FRAMING_CHARS = 8;

/** Content of the directory index when the harness has to create it. */
export const DREAM_REPORT_INDEX_CONTENT = `# Maintenance

- [Dream report](./${DREAM_REPORT_FILENAME}) — what the last dream run did, why, and what is left for next time.
`;

export interface DreamReportInput {
  agentId: string;
  conversationId: string;
  /** The run record at finishing time (handoff, tiers, budget, status). */
  metadata: DreamRunMetadata;
  /** Body the agent produced, when it produced one. */
  body?: string;
}

export interface DreamReportResult {
  /** Repo-relative path of the committed report, or `null` when none was written. */
  reportPath: string | null;
  committed: boolean;
}

/**
 * Frontmatter for the report.
 *
 * Only `name` and `description` are allowed in MemFS v2 and both must be
 * non-empty (`memory-frontmatter.ts`). The date keeps the projection readable
 * while the filename stays fixed.
 */
export function buildDreamReportFrontmatter(
  metadata: DreamRunMetadata,
  now: number,
): string {
  const endedAt = metadata.endedAt ?? now;
  const date = new Date(endedAt).toISOString().slice(0, 10);
  const description = `What the ${date} dream run changed, why, and what is left unfinished.`;
  return [
    "---",
    `name: Dream report ${date}`,
    `description: ${description}`,
    "---",
  ].join("\n");
}

/**
 * Body when the agent produced none.
 *
 * `R-5.6.5`: a failed, timed-out or budget-exhausted run still leaves a report,
 * otherwise the user cannot tell why nothing happened overnight. A one-line
 * status report is the minimum honest answer.
 */
export function buildFallbackDreamReportBody(
  metadata: DreamRunMetadata,
): string {
  const tiers =
    metadata.tierPlan.length > 0 ? metadata.tierPlan.join(" → ") : "(none)";
  const lines = [
    "No report body was produced by this run.",
    "",
    `- status: ${metadata.status}`,
    `- tiers planned: ${tiers}`,
    `- tier reached: ${metadata.tierReached ?? "none"}`,
    `- budget: ${metadata.spentTokens} of ${metadata.budgetTokens} tokens spent`,
  ];
  if (metadata.handoff !== null && metadata.handoff.trim().length > 0) {
    lines.push("", "## Where to continue", "", metadata.handoff.trim());
  }
  return lines.join("\n");
}

/**
 * The repository's effective per-file character limit.
 *
 * `maxFileCharacters` is global and defaults to 20,000; a tracked
 * `.memfs.config.json` may lower it. Per-glob `fileCharacterLimits` overrides are
 * deliberately not consulted: this writer owns exactly one path, and a
 * repository that caps `maintenance/**` below its global cap is rare enough that
 * the commit rejection (which the controller surfaces as a report-write failure)
 * is the honest outcome rather than a second, drifting glob matcher here.
 *
 * A missing or unparsable config falls back to the default: the pre-commit hook
 * re-reads the real config and rejects the commit for its own reason if the file
 * is actually too large.
 */
export function resolveDreamReportFileLimit(memoryDir: string): number {
  const fallback =
    DEFAULT_MEMORY_CONSTRAINTS_CONFIG.maxFileCharacters ??
    DREAM_REPORT_MAX_BODY_CHARS + 200;
  try {
    const raw = readFileSync(
      join(memoryDir, MEMORY_CONSTRAINTS_CONFIG_PATH),
      "utf8",
    );
    const parsed = parseMemoryConstraintsConfig(raw);
    return typeof parsed.maxFileCharacters === "number"
      ? parsed.maxFileCharacters
      : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Body budget that keeps the whole report file inside the repository limit:
 * the frontmatter is measured on the real content, and the framing newlines are
 * subtracted before the 16,000-character ceiling is applied.
 */
export function resolveDreamReportBodyLimit(input: {
  memoryDir: string;
  metadata: DreamRunMetadata;
  now: number;
}): number {
  const frontmatterChars = buildDreamReportFrontmatter(
    input.metadata,
    input.now,
  ).length;
  const available =
    resolveDreamReportFileLimit(input.memoryDir) -
    frontmatterChars -
    REPORT_FILE_FRAMING_CHARS;
  return Math.max(1, Math.min(DREAM_REPORT_MAX_BODY_CHARS, available));
}

function clampReportBody(body: string, bodyLimit: number): string {
  const limit = Math.max(1, Math.min(bodyLimit, DREAM_REPORT_MAX_BODY_CHARS));
  if (body.length <= limit) return body;
  const notice = `\n\n(Report truncated at ${limit} characters by the harness.)`;
  const bodyChars = Math.max(1, limit - notice.length);
  return `${body.slice(0, bodyChars).trimEnd()}${notice}`;
}

/** Assemble the full file: v2 frontmatter plus body, in the validated order. */
export function buildDreamReportFile(
  metadata: DreamRunMetadata,
  body: string | undefined,
  now: number,
  bodyLimit: number = DREAM_REPORT_MAX_BODY_CHARS,
): string {
  const trimmed = typeof body === "string" ? body.trim() : "";
  const resolvedBody =
    trimmed.length > 0 ? trimmed : buildFallbackDreamReportBody(metadata);
  return `${buildDreamReportFrontmatter(metadata, now)}\n\n${clampReportBody(resolvedBody, bodyLimit)}\n`;
}

/**
 * Write and commit the report for a finished run.
 *
 * Returns `reportPath: null` when there is no memory git repository to commit
 * into (nothing was written). Returns `committed: false` with a path when the
 * file was already exactly this content: that is the idempotent case, not an
 * error.
 */
export async function writeDreamReport(
  input: DreamReportInput,
): Promise<DreamReportResult> {
  const memoryDir = getScopedMemoryFilesystemRoot(input.agentId);
  if (!existsSync(join(memoryDir, ".git"))) {
    return { reportPath: null, committed: false };
  }

  const reportDir = join(memoryDir, ...DREAM_REPORT_DIR.split("/"));
  const reportFile = join(memoryDir, ...DREAM_REPORT_PATH.split("/"));
  const indexFile = join(memoryDir, ...DREAM_REPORT_INDEX_PATH.split("/"));
  mkdirSync(reportDir, { recursive: true });
  // The index is created only when missing: rewriting it every run would add a
  // noisy diff to the report commit and could clobber an agent-maintained index.
  if (!existsSync(indexFile)) {
    writeFileSync(indexFile, DREAM_REPORT_INDEX_CONTENT, "utf8");
  }
  const now = Date.now();
  writeFileSync(
    reportFile,
    buildDreamReportFile(
      input.metadata,
      input.body,
      now,
      resolveDreamReportBodyLimit({ memoryDir, metadata: input.metadata, now }),
    ),
    "utf8",
  );

  // `commitMemoryWrite` commits the index, so this relies on a dream run having
  // no other index writer: the agent's own `MemoryCommit` calls commit what they
  // stage and leave the index clean, and there is no shell. The report is
  // therefore the only change in this commit, which is the isolation C-22 asks
  // for. A pre-staged index (impossible in a dream run, possible in a hand-written
  // probe) would ride along.
  const result = await commitMemoryWrite({
    memoryDir,
    pathspecs: [DREAM_REPORT_PATH, DREAM_REPORT_INDEX_PATH],
    reason: `dream: record run report (${input.metadata.runId})`,
    author: {
      agentId: input.agentId,
      authorName: getCurrentAgentName() ?? input.agentId,
    },
    // Dreams run on the local backend; the remote sync path belongs to the
    // main-session flow and is deliberately not reachable from a run.
    syncMode: "local",
  });

  return { reportPath: DREAM_REPORT_PATH, committed: result.committed };
}
