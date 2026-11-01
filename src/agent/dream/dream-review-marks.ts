/**
 * Dream review marks — the per-run record of "this file was actually reviewed"
 * (F-06 / 46-6-Fix-A W3, design §5.10.3).
 *
 * The decay recurrence in {@link "@/agent/dream/dream-decay"} has one failure
 * mode: a clean file that nobody touches keeps `rr = 1`, so its carried decay
 * never falls and it stays at the top of the ranking forever. A review mark is
 * the only way the agent can say "I looked at this file properly, it is not
 * rotting" and let the ledger drop it. The mark must carry `evidence` so the
 * report can show *what* was reviewed — a mark without evidence would be a way
 * to silence the ranking, not a review.
 *
 * Storage follows the same rule as the note queue: the harness home, never the
 * memory repository. One JSONL file per run:
 *
 *   `<harness home>/dream/runs/<run-segment>/marks.jsonl`
 *
 * A mark is written by the `DreamReviewMark` tool during the run (W6) and read
 * once at the end, when the run's ledger update applies it. `clearReviewMarks`
 * then deletes the file best-effort: marks are per-run state, not history.
 *
 * Layer: `agent/` — dream domain, imports only `utils/`.
 */

import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { appHomePath } from "@/utils/app-paths";
import { debugWarn } from "@/utils/debug";

/** How much of the file the run claims to have reviewed. */
export const DREAM_REVIEW_COVERAGES = ["skim", "structure", "content"] as const;

export type DreamReviewCoverage = (typeof DREAM_REVIEW_COVERAGES)[number];

/**
 * Longest accepted evidence line. The tool schema (W6) enforces the same cap;
 * this module re-checks it because the ledger must never take a multi-line
 * "evidence" that would break the JSONL one-line-per-mark contract.
 */
export const DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS = 200;

/** One line of `marks.jsonl`: the mark a run left for one memory file. */
export interface DreamReviewMark {
  version: 1;
  /** The dream run that made the mark. */
  runId: string;
  /** Memory-repository-relative POSIX path. */
  path: string;
  coverage: DreamReviewCoverage;
  /** One line: which links/index/paragraphs were actually checked. */
  evidence: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface AppendDreamReviewMarkInput {
  runId: string;
  path: string;
  coverage: DreamReviewCoverage;
  evidence: string;
  /** Epoch ms; defaults to the clock. Pinned by tests. */
  now?: number;
}

export type AppendDreamReviewMarkResult =
  | { ok: true; mark: DreamReviewMark }
  | { ok: false; error: string };

/**
 * One file-system-safe path segment.
 *
 * Run ids are usually opaque harness-generated strings, but nothing promises
 * that, and a slash or colon in one would either create directories or fail on
 * Windows. The same sanitization as the note queue keeps `<runId>` a single
 * segment; the `marks.jsonl` filename is fixed, so even a `..` id cannot escape
 * the runs directory.
 *
 * Exported because the decay ledger stores its per-agent file next to the run
 * directory and must sanitize agent ids the same way; it lives here so the two
 * modules do not import each other in a cycle.
 */
export function dreamStorageSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") return "unknown";
  return safe;
}

/** `<harness home>/dream/runs/<run>/marks.jsonl` — resolved per call. */
export function getDreamReviewMarksPath(runId: string): string {
  return appHomePath([
    "dream",
    "runs",
    dreamStorageSegment(runId),
    "marks.jsonl",
  ]);
}

function isDreamReviewCoverage(value: unknown): value is DreamReviewCoverage {
  return (
    typeof value === "string" &&
    (DREAM_REVIEW_COVERAGES as readonly string[]).includes(value)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalize a memory path to the repository-relative POSIX form the ledger
 * uses. Returns `null` for paths that could escape the repository: absolute
 * paths, `..` segments, `.git`, and empty values. The `DreamReviewMark` tool
 * (W6) performs the full existence/validation check; this is defense in depth
 * for anything else that appends a mark.
 */
export function normalizeDreamReviewPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.length === 0) return null;
  if (normalized.startsWith("/")) return null;
  if (/^[A-Za-z]:\//u.test(normalized)) return null;
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === ".." || segment === ".git") return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

function normalizeEvidence(value: string): string | null {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length === 0) return null;
  if (singleLine.length > DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS) return null;
  return singleLine;
}

/**
 * Parse one JSONL line. `null` means "corrupt, skip it" — one bad line must not
 * lose the marks a run did write, and a crash mid-append can leave a partial
 * trailing line.
 */
function parseMarkLine(line: string): DreamReviewMark | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    return null;
  }
  if (typeof record.path !== "string" || record.path.length === 0) return null;
  if (!isDreamReviewCoverage(record.coverage)) return null;
  if (typeof record.evidence !== "string" || record.evidence.length === 0) {
    return null;
  }
  if (!isFiniteNumber(record.createdAt)) return null;
  return {
    version: 1,
    runId: record.runId,
    path: record.path,
    coverage: record.coverage,
    evidence: record.evidence,
    createdAt: record.createdAt,
  };
}

/**
 * Read this run's marks in file order, skipping corrupt lines.
 *
 * A missing file means "no marks"; any other read failure is logged and also
 * treated as no marks. The ledger update is best-effort by design: a run whose
 * marks cannot be read must still finish and write its ledger, it just loses
 * the early-clear optimisation for this run.
 */
export async function readReviewMarks(
  runId: string,
): Promise<DreamReviewMark[]> {
  const path = getDreamReviewMarksPath(runId);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      debugWarn(
        "dream-review-marks",
        `could not read ${path}: ${String(error)}`,
      );
    }
    return [];
  }
  const marks: DreamReviewMark[] = [];
  let damaged = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const mark = parseMarkLine(trimmed);
    if (mark === null) {
      damaged += 1;
      continue;
    }
    marks.push(mark);
  }
  if (damaged > 0) {
    debugWarn(
      "dream-review-marks",
      `skipped ${damaged} corrupt line(s) in ${path}`,
    );
  }
  return marks;
}

/**
 * Append one mark. Refused (with the reason, never silently) when the path
 * escapes the repository, the coverage is unknown, or the evidence is empty or
 * over {@link DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS}. Whitespace inside the
 * evidence is collapsed so the mark stays one JSONL line.
 */
export async function appendReviewMark(
  input: AppendDreamReviewMarkInput,
): Promise<AppendDreamReviewMarkResult> {
  const path = normalizeDreamReviewPath(input.path);
  if (path === null) {
    return {
      ok: false,
      error: `"${input.path}" is not a memory-repository-relative path.`,
    };
  }
  if (!isDreamReviewCoverage(input.coverage)) {
    return {
      ok: false,
      error: `coverage must be one of ${DREAM_REVIEW_COVERAGES.join(", ")}.`,
    };
  }
  const evidence = normalizeEvidence(input.evidence);
  if (evidence === null) {
    return {
      ok: false,
      error: `evidence must be one non-empty line of at most ${DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS} characters.`,
    };
  }
  if (input.runId.trim().length === 0) {
    return {
      ok: false,
      error: "a review mark needs the run id it belongs to.",
    };
  }
  const mark: DreamReviewMark = {
    version: 1,
    runId: input.runId,
    path,
    coverage: input.coverage,
    evidence,
    createdAt: input.now ?? Date.now(),
  };
  const file = getDreamReviewMarksPath(input.runId);
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(mark)}\n`, "utf8");
  } catch (error) {
    debugWarn(
      "dream-review-marks",
      `could not append to ${file}: ${String(error)}`,
    );
    return {
      ok: false,
      error: `The review mark could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true, mark };
}

/**
 * Delete this run's marks file. Best-effort: the run's ledger update already
 * consumed the marks, and a leftover file is harmless (the next run has a new
 * id). A missing file is a no-op.
 */
export async function clearReviewMarks(runId: string): Promise<void> {
  const path = getDreamReviewMarksPath(runId);
  try {
    await rm(path, { force: true });
  } catch (error) {
    debugWarn(
      "dream-review-marks",
      `could not clear ${path}: ${String(error)}`,
    );
  }
}
