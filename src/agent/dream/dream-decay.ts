/**
 * Dream decay ledger (F-06 / 46-6-Fix-A W3, design §5.10.2–§5.10.3, §6.5,
 * §6.8).
 *
 * The tidy manual opens with a ranking, and the ranking is a recurrence, not a
 * fresh heuristic every night:
 *
 * ```text
 * every run start (read-only):
 *   Δstale = min((now − lastDecayUpdateAt) / 1 day, 365)
 *   churn  = clamp(changedLines / max(linesAtLastUpdate, 20), 0, 1)
 *   decay  = (1 + churn) · importance · Δstale · (1 + defect) + latestDecay
 *
 * every run end (full update, every file):
 *   rr     = 2 · sigmoid(−k · x)          x = changedLines / max(linesBefore, 1)
 *   mark   → x' = max(x, 1), clear `next`
 *   latestDecay := (increment + latestDecay) · rr
 * ```
 *
 * Two properties are load-bearing:
 *
 * - **It is a full update.** Files the run never touched get `rr = 1`, so their
 *   carried decay keeps accumulating; nothing is silently reset, and the
 *   ranking cannot be gamed by ignoring the tail.
 * - **State lives in the harness home**, never in the memory repository:
 *   `<harness home>/dream/decay/<agent-segment>.json`. A corrupt file resets
 *   the ledger (with a debug line) instead of failing the run, and writes go
 *   through temp + rename so a crash leaves a complete file.
 *
 * The decay value is only ever an ordering hint; nothing here gates work. The
 * per-file `next` (resume point) and `note` travel with the entry so a changing
 * top-1 cannot misplace the resume point (design §6.8).
 *
 * Layer: `agent/` — dream domain; imports `agent/` siblings and `utils/`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DreamLayout } from "@/agent/dream/dream-layout";
import {
  DEFECT_WEIGHTS,
  defectWeights,
  isValidGitRevision,
  type MemoryDefectScan,
  type MemoryFileChange,
  type MemoryFileFact,
} from "@/agent/dream/dream-manifest";
import { DREAM_REPORT_PATH } from "@/agent/dream/dream-report";
import {
  type DreamReviewMark,
  dreamStorageSegment,
} from "@/agent/dream/dream-review-marks";
import { runGit } from "@/agent/memory-git";
import { appHomePath } from "@/utils/app-paths";
import { debugLog, debugWarn } from "@/utils/debug";

/** The state file version; a different value is treated as a corrupt file. */
export const DREAM_DECAY_VERSION = 1;

/**
 * Calibrate before release (checklist §4). Sigmoid slope of the run-end review
 * decay: `rr = 2·sigmoid(−k·x)`, so a file changed by 1× its own length lands
 * at `rr ≈ 0.005` and a file reviewed via `DreamReviewMark` lands there
 * regardless of how much changed.
 */
export const DECAY_K = 6;

/**
 * Calibrate before release (checklist §4). Directory coefficients from design
 * §6.5, applied per file. Index files win over the core coefficient on purpose:
 * a v2 root `MEMORY.md` *is* core, and letting it carry the core weight would
 * let index churn amplify itself. `maintenance/dream-report.md` is excluded
 * entirely (the harness rewrites it every run) and has no coefficient.
 */
export const DIR_COEFFICIENTS = {
  core: 1.5,
  reference: 1.0,
  other: 0.5,
  draft: 0.3,
  archive: 0.1,
  skills: 0,
  index: 0.2,
} as const;

/**
 * Calibrate before release (checklist §4). Bounds that keep the recurrence
 * readable: a year of staleness is the ceiling (a dormant repository must not
 * grow without bound, but a 14-day ceiling would flatten monthly files), a
 * 20-line floor keeps tiny files from being over-weighted by churn, and the
 * seed renders the top 20 rows.
 */
export const DECAY_LIMITS = {
  maxStaleDays: 365,
  minChurnLines: 20,
  topN: 20,
} as const;

/**
 * All decay calibration in one place. `DEFECT_WEIGHTS` is owned by the manifest
 * module (it normalizes the three defect categories); it is referenced here so
 * one object answers "what is tunable in this ledger" without redeclaring it.
 */
export const DECAY_CALIBRATION = {
  k: DECAY_K,
  dirCoefficients: DIR_COEFFICIENTS,
  limits: DECAY_LIMITS,
  defectWeights: DEFECT_WEIGHTS,
} as const;

const MS_PER_DAY = 86_400_000;

/** Per-file ledger state: the only cross-run numbers the recurrence keeps. */
export interface DreamDecayFileState {
  /** Carried decay from earlier intervals; never negative. */
  latestDecay: number;
  /** Optional free-form note (design §6.8); rendered only when `next` is absent. */
  note?: string;
  /** Per-file resume point; cleared by a `DreamReviewMark`. */
  next?: string;
  /** Git blob sha at the last update (evidence that the entry matches the tree). */
  sha?: string;
  lines: number;
  chars: number;
}

export interface DreamDecayTotals {
  lines: number;
  chars: number;
}

/** The whole ledger file. */
export interface DreamDecayIndex {
  version: 1;
  /** Epoch ms of the last full update; `null` before the first tracked run. */
  lastDecayUpdateAt: number | null;
  /** HEAD at the last update; the seed's change list starts here. */
  lastRunHead: string | null;
  /**
   * Runtime format the coefficients were computed under. A change means the
   * core set changed, so the ranking is recomputed; carried `latestDecay`
   * values are kept (Lead decision, checklist §8.8).
   */
  layout: DreamLayout["format"] | null;
  totals: DreamDecayTotals;
  files: Record<string, DreamDecayFileState>;
}

/** One ranked row: everything the seed table needs, plus the inputs. */
export interface DreamDecayEntry {
  path: string;
  /** `increment + latestDecay`; the value the table sorts on. */
  decay: number;
  /** `(1 + churn) · importance · Δstale · (1 + defect)` for this interval. */
  increment: number;
  latestDecay: number;
  chars: number;
  lines: number;
  importance: number;
  churn: number;
  defect: number;
  dirModifier: number;
  deltaStaleDays: number;
  next: string | null;
  note: string | null;
}

export interface DreamDecayView {
  /** Every included file, decay descending (path ascending on ties). */
  entries: DreamDecayEntry[];
  /** The first {@link DreamDecayView.limit} entries. */
  top: DreamDecayEntry[];
  /** Full map keyed by path, for lookups that should not depend on order. */
  byPath: Record<string, DreamDecayEntry>;
  limit: number;
  totalFiles: number;
  totalLines: number;
  totalChars: number;
  deltaStaleDays: number;
  /** True when the stored layout differs from the current one. */
  layoutChanged: boolean;
  /** Paths the coefficients exclude from the ledger (the run report). */
  excludedPaths: string[];
}

export interface ComputeDecayViewInput {
  index: DreamDecayIndex;
  layout: DreamLayout;
  /** Tracked files; pass `includeUnprojected: true` so hidden files still rank. */
  manifest: readonly MemoryFileFact[];
  defects: MemoryDefectScan;
  /** Epoch ms of the run start. */
  now: number;
  /**
   * Added + deleted lines per path since the index's `lastRunHead`, from
   * {@link collectIntervalChanges}. Required (not defaulted) so a caller cannot
   * silently score every file as unchanged.
   */
  intervalChangedLines: ReadonlyMap<string, number>;
  /** Rows to copy into `top`; defaults to {@link DECAY_LIMITS.topN}. */
  limit?: number;
}

export interface ApplyRunToIndexInput {
  index: DreamDecayIndex;
  runId: string;
  layout: DreamLayout;
  /** Epoch ms of the run end. */
  now: number;
  /** HEAD after the run's commits. */
  headSha: string | null;
  /** The run-start view; supplies each file's interval increment. */
  view: DreamDecayView;
  /** End-of-run tracked files (`includeUnprojected: true`) with lines/chars. */
  manifest: readonly MemoryFileFact[];
  /** Git blob shas (`git ls-files -s`) keyed by path. */
  blobShas: ReadonlyMap<string, string>;
  /** Files changed by this run, with added/deleted line counts. */
  changedFiles: readonly MemoryFileChange[];
  /** Review marks the run wrote (`DreamReviewMark` tool). */
  marks: readonly DreamReviewMark[];
}

/** `<harness home>/dream/decay/<agent>.json` — resolved per call. */
export function getDreamDecayPath(agentId: string): string {
  return appHomePath([
    "dream",
    "decay",
    `${dreamStorageSegment(agentId)}.json`,
  ]);
}

/** A ledger with no history: the first tracked run starts from `Δstale = 365`. */
export function createEmptyDecayIndex(): DreamDecayIndex {
  return {
    version: DREAM_DECAY_VERSION,
    lastDecayUpdateAt: null,
    lastRunHead: null,
    layout: null,
    totals: { lines: 0, chars: 0 },
    files: {},
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  return Math.floor(value);
}

function parseFileState(value: unknown): DreamDecayFileState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const latestDecay = record.latestDecay;
  if (!isFiniteNumber(latestDecay) || latestDecay < 0) return null;
  const lines = nonNegativeInteger(record.lines);
  const chars = nonNegativeInteger(record.chars);
  if (lines === null || chars === null) return null;
  const state: DreamDecayFileState = { latestDecay, lines, chars };
  if (typeof record.note === "string" && record.note.length > 0) {
    state.note = record.note;
  }
  if (typeof record.next === "string" && record.next.length > 0) {
    state.next = record.next;
  }
  if (typeof record.sha === "string" && record.sha.length > 0) {
    state.sha = record.sha;
  }
  return state;
}

function parseIndex(body: string): DreamDecayIndex | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== DREAM_DECAY_VERSION) return null;
  const filesRecord = record.files;
  if (
    typeof filesRecord !== "object" ||
    filesRecord === null ||
    Array.isArray(filesRecord)
  ) {
    return null;
  }
  const totalsRecord =
    typeof record.totals === "object" && record.totals !== null
      ? (record.totals as Record<string, unknown>)
      : {};
  const files: Record<string, DreamDecayFileState> = {};
  for (const [path, value] of Object.entries(
    filesRecord as Record<string, unknown>,
  )) {
    const state = parseFileState(value);
    if (state === null) {
      debugWarn(
        "dream-decay",
        `dropped a malformed entry for "${path}" while reading the ledger`,
      );
      continue;
    }
    files[path] = state;
  }
  const layout = record.layout;
  return {
    version: DREAM_DECAY_VERSION,
    lastDecayUpdateAt: isFiniteNumber(record.lastDecayUpdateAt)
      ? record.lastDecayUpdateAt
      : null,
    lastRunHead:
      typeof record.lastRunHead === "string" && record.lastRunHead.length > 0
        ? record.lastRunHead
        : null,
    layout: layout === "memfs-v1" || layout === "memfs-v2" ? layout : null,
    totals: {
      lines: nonNegativeInteger(totalsRecord.lines) ?? 0,
      chars: nonNegativeInteger(totalsRecord.chars) ?? 0,
    },
    files,
  };
}

/**
 * Read the agent's ledger. A missing file is a fresh ledger; a corrupt or
 * foreign-version file is reset (with a debug line) instead of failing the run.
 */
export async function readDecayIndex(
  agentId: string,
): Promise<DreamDecayIndex> {
  const path = getDreamDecayPath(agentId);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      debugWarn("dream-decay", `could not read ${path}: ${String(error)}`);
    }
    return createEmptyDecayIndex();
  }
  const parsed = parseIndex(body);
  if (parsed === null) {
    debugWarn(
      "dream-decay",
      `ignoring a corrupt decay ledger at ${path}; starting a fresh one`,
    );
    return createEmptyDecayIndex();
  }
  return parsed;
}

/**
 * Replace the ledger through a temp file + rename. Windows refuses a rename
 * over an existing file in some states, so the direct write is the documented
 * fallback (the note queue and usage ledger do the same): a crash leaves either
 * the old file or a complete one.
 */
export async function writeDecayIndex(
  agentId: string,
  index: DreamDecayIndex,
): Promise<void> {
  const path = getDreamDecayPath(agentId);
  const body = `${JSON.stringify(index, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, body, "utf8");
  try {
    await rename(tempPath, path);
  } catch {
    await writeFile(path, body, "utf8");
  }
}

/** The run report is rewritten by the harness every run, so it never ranks. */
export function isDecayExcluded(path: string): boolean {
  return path === DREAM_REPORT_PATH;
}

function lastSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Directory coefficient for one file (design §6.5). Order matters: the index
 * rule wins over core, `skills/` is deliberately 0 (procedural knowledge is
 * accepted as rotting), and the run report is excluded by
 * {@link isDecayExcluded} rather than scored.
 */
export function dreamDirectoryCoefficient(
  path: string,
  layout: Pick<DreamLayout, "corePaths">,
): number {
  const filename = lastSegment(path);
  if (filename === "MEMORY.md" || filename === "INDEX.md") {
    return DIR_COEFFICIENTS.index;
  }
  if (path.startsWith("skills/")) return DIR_COEFFICIENTS.skills;
  if (path.startsWith("archive/") || path === "ARCHIVE.md") {
    return DIR_COEFFICIENTS.archive;
  }
  if (path.startsWith("draft/")) return DIR_COEFFICIENTS.draft;
  if (path.startsWith("reference/")) return DIR_COEFFICIENTS.reference;
  if (layout.corePaths.includes(path)) return DIR_COEFFICIENTS.core;
  return DIR_COEFFICIENTS.other;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * `Δstale` in days: the interval since the last full update, capped at a year.
 * A fresh ledger starts at the cap so the first ranking begins from "most
 * stale" instead of from zero (design §5.10.2).
 *
 * The stored timestamp is epoch **milliseconds** (state shape, checklist §3
 * W3); the design writes `/ 86400` because it counts seconds, so the divisor
 * here is milliseconds per day.
 */
export function resolveDeltaStaleDays(
  lastDecayUpdateAt: number | null,
  now: number,
): number {
  if (lastDecayUpdateAt === null) return DECAY_LIMITS.maxStaleDays;
  const elapsedMs = Math.max(0, now - lastDecayUpdateAt);
  return Math.min(elapsedMs / MS_PER_DAY, DECAY_LIMITS.maxStaleDays);
}

function resolveChurn(
  path: string,
  state: DreamDecayFileState | undefined,
  intervalChangedLines: ReadonlyMap<string, number>,
): number {
  // A file the ledger has never seen was created since the last update: its
  // whole content is new, so churn is 1 by definition.
  if (state === undefined) return 1;
  const changedLines = intervalChangedLines.get(path) ?? 0;
  const denominator = Math.max(state.lines, DECAY_LIMITS.minChurnLines);
  return clamp(changedLines / denominator, 0, 1);
}

/**
 * Compute the ranking for the seed. Pure: no file system, no clock — the git
 * interval is read by {@link collectIntervalChanges} and passed in.
 *
 * A layout change does not reset anything: every entry is recomputed under the
 * current layout (so coefficients follow the new core set) while its carried
 * `latestDecay` is kept, then the whole table is re-sorted. That is the Lead
 * decision recorded in checklist §8.8.
 */
export function computeDecayView(input: ComputeDecayViewInput): DreamDecayView {
  const { index, layout, manifest, defects, now } = input;
  const limit = input.limit ?? DECAY_LIMITS.topN;
  const deltaStaleDays = resolveDeltaStaleDays(index.lastDecayUpdateAt, now);
  const included: MemoryFileFact[] = [];
  const excludedPaths: string[] = [];
  for (const file of manifest) {
    if (isDecayExcluded(file.path)) {
      excludedPaths.push(file.path);
      continue;
    }
    included.push(file);
  }
  let totalLines = 0;
  let totalChars = 0;
  for (const file of included) {
    totalLines += file.lines;
    totalChars += file.chars;
  }
  // Missing indexes are the only defect category that belongs to a directory
  // rather than a single path: the weights are distributed over that
  // directory's own files, so the category reaches the ranking instead of
  // landing on an index path that does not exist.
  const defectsByPath = defectWeights(defects, manifest);
  const entries: DreamDecayEntry[] = included.map((file) => {
    const state = index.files[file.path];
    const dirModifier = dreamDirectoryCoefficient(file.path, layout);
    const importance =
      totalLines === 0 ? 0 : dirModifier * (file.lines / totalLines);
    const churn = resolveChurn(file.path, state, input.intervalChangedLines);
    const defect = defectsByPath[file.path] ?? 0;
    const increment = (1 + churn) * importance * deltaStaleDays * (1 + defect);
    const latestDecay = state?.latestDecay ?? 0;
    return {
      path: file.path,
      decay: increment + latestDecay,
      increment,
      latestDecay,
      chars: file.chars,
      lines: file.lines,
      importance,
      churn,
      defect,
      dirModifier,
      deltaStaleDays,
      next: state?.next ?? null,
      note: state?.note ?? null,
    };
  });
  entries.sort(
    (left, right) =>
      right.decay - left.decay || left.path.localeCompare(right.path),
  );
  const byPath: Record<string, DreamDecayEntry> = {};
  for (const entry of entries) byPath[entry.path] = entry;
  return {
    entries,
    top: entries.slice(0, Math.max(0, limit)),
    byPath,
    limit,
    totalFiles: entries.length,
    totalLines,
    totalChars,
    deltaStaleDays,
    layoutChanged: index.layout !== null && index.layout !== layout.format,
    excludedPaths,
  };
}

/**
 * Added + deleted lines per path between `sinceSha` and HEAD, for the churn
 * term. One `git diff --numstat` call for the whole tree; `--no-renames` keeps
 * the paths unambiguous (a rename reads as delete + add, matching the ledger's
 * deterministic rename rule). A first run (`sinceSha === null`) has no interval
 * and returns an empty map.
 */
export async function collectIntervalChanges(
  memoryDir: string,
  sinceSha: string | null,
): Promise<Map<string, number>> {
  const changes = new Map<string, number>();
  // The ledger's `lastRunHead` is user-editable state, and an option-shaped
  // value must never reach git's argv. A non-revision means "no interval" —
  // the same shape as a first run, so the caller still gets a view.
  if (!isValidGitRevision(sinceSha)) return changes;
  const result = await runGit(memoryDir, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--numstat",
    "--no-renames",
    `${sinceSha}..HEAD`,
  ]);
  for (const line of result.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const path = parts.slice(2).join("\t").replaceAll("\\", "/");
    const added = Number.parseInt(parts[0] ?? "0", 10) || 0;
    const deleted = Number.parseInt(parts[1] ?? "0", 10) || 0;
    changes.set(path, (changes.get(path) ?? 0) + added + deleted);
  }
  return changes;
}

/**
 * Git blob shas for the tracked tree (`git ls-files -s`), keyed by path. The
 * ledger stores one so a later reader can tell whether an entry still describes
 * the file it was computed from.
 */
export async function collectTrackedBlobShas(
  memoryDir: string,
): Promise<Map<string, string>> {
  const shas = new Map<string, string>();
  const result = await runGit(memoryDir, ["ls-files", "-s", "-z"]);
  for (const record of result.stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const header = record.slice(0, tab).split(" ");
    const sha = header[1];
    if (sha === undefined || sha.length === 0) continue;
    shas.set(record.slice(tab + 1).replaceAll("\\", "/"), sha);
  }
  return shas;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/**
 * Increment for a file that did not exist at run start (created by this run).
 * It has no run-start view entry, so churn is 1 by definition, importance comes
 * from the end-of-run totals and the defect term is unknown (1).
 */
function fallbackIncrement(
  file: MemoryFileFact,
  layout: DreamLayout,
  totalLines: number,
  deltaStaleDays: number,
): number {
  const dirModifier = dreamDirectoryCoefficient(file.path, layout);
  const importance =
    totalLines === 0 ? 0 : dirModifier * (file.lines / totalLines);
  return 2 * importance * deltaStaleDays;
}

/**
 * Apply a finished run to the ledger (design §5.10.2 "run end").
 *
 * Every tracked file is updated, not only the ones the run touched:
 *
 * - unchanged and unmarked → `rr = 1`, the interval increment is added to the
 *   carried decay (natural accumulation);
 * - changed → `x = changedLines / max(linesBefore, 1)`, `rr = 2·sigmoid(−k·x)`;
 * - marked via `DreamReviewMark` → `x' = max(x, 1)` (so `rr ≈ 0`), and the
 *   file's `next` resume point is cleared;
 * - created by this run → added to the table (its whole content is new, so its
 *   decay starts near zero);
 * - deleted → removed from the table;
 * - renamed → git reports it as delete + add (`--no-renames`), so the old path
 *   is removed and the new one added; nothing is guessed.
 *
 * Returns the next ledger; the caller writes it with {@link writeDecayIndex}.
 */
export function applyRunToIndex(input: ApplyRunToIndexInput): DreamDecayIndex {
  const { index, layout, view } = input;
  const changedByPath = new Map<string, MemoryFileChange>();
  for (const change of input.changedFiles) {
    changedByPath.set(change.path, change);
  }
  const marksByPath = new Map<string, DreamReviewMark>();
  for (const mark of input.marks) marksByPath.set(mark.path, mark);
  const viewByPath = new Map<string, DreamDecayEntry>();
  for (const entry of view.entries) viewByPath.set(entry.path, entry);

  const included: MemoryFileFact[] = [];
  for (const file of input.manifest) {
    if (!isDecayExcluded(file.path)) included.push(file);
  }
  let totalLines = 0;
  let totalChars = 0;
  for (const file of included) {
    totalLines += file.lines;
    totalChars += file.chars;
  }

  const files: Record<string, DreamDecayFileState> = {};
  for (const file of included) {
    const previous = index.files[file.path];
    const change = changedByPath.get(file.path);
    const changedLines = change ? change.added + change.deleted : 0;
    const linesBefore = previous?.lines ?? 0;
    const x = change ? changedLines / Math.max(linesBefore, 1) : 0;
    const mark = marksByPath.get(file.path);
    const xFinal = mark === undefined ? x : Math.max(x, 1);
    const rr = 2 * sigmoid(-DECAY_K * xFinal);
    const viewEntry = viewByPath.get(file.path);
    const increment = viewEntry
      ? viewEntry.increment
      : fallbackIncrement(file, layout, totalLines, view.deltaStaleDays);
    const latestDecay = Math.max(
      0,
      (increment + (previous?.latestDecay ?? 0)) * rr,
    );
    const state: DreamDecayFileState = {
      latestDecay,
      lines: file.lines,
      chars: file.chars,
    };
    const sha = input.blobShas.get(file.path) ?? previous?.sha;
    if (sha !== undefined) state.sha = sha;
    if (previous?.note !== undefined) state.note = previous.note;
    // A mark means "fully reviewed", so the resume point no longer applies.
    if (mark === undefined && previous?.next !== undefined) {
      state.next = previous.next;
    }
    files[file.path] = state;
  }

  const next: DreamDecayIndex = {
    version: DREAM_DECAY_VERSION,
    lastDecayUpdateAt: input.now,
    lastRunHead: input.headSha ?? index.lastRunHead,
    layout: layout.format,
    totals: { lines: totalLines, chars: totalChars },
    files,
  };
  debugLog(
    "dream-decay",
    `run ${input.runId}: updated ${included.length} files (${changedByPath.size} changed, ${marksByPath.size} marked)`,
  );
  return next;
}

function escapeCell(text: string): string {
  return text.replace(/\s+/gu, " ").replaceAll("|", "\\|").trim();
}

function formatDecay(value: number): string {
  return value.toFixed(1);
}

/**
 * Render the seed's four-column decay table (`path | decay | size | note`).
 *
 * The header says what the table is: a ranking entry point, not a todo list.
 * `size` is the character count (the manual's workload estimate), and `note`
 * carries the per-file `next` resume point when there is one.
 */
export function renderDecayTable(
  view: DreamDecayView,
  limit: number = DECAY_LIMITS.topN,
): string {
  const shown = view.entries.slice(0, Math.max(0, limit));
  const lines: string[] = [
    `## Decay ranking (top ${shown.length} of ${view.totalFiles} files)`,
    "",
    "Sorted by decay, highest first. This is a ranking entry point, not a todo list: pick one file, finish a unit, then come back to the ranking.",
  ];
  if (view.layoutChanged) {
    lines.push(
      "The layout changed since the last ledger update, so the ranking was recomputed under the new layout; each file keeps its carried decay.",
    );
  }
  if (shown.length === 0) {
    lines.push("", "No files to rank.");
    return lines.join("\n");
  }
  lines.push("", "| path | decay | size | note |", "| --- | --- | --- | --- |");
  for (const entry of shown) {
    const note =
      entry.next !== null
        ? `next: ${escapeCell(entry.next)}`
        : entry.note !== null
          ? escapeCell(entry.note)
          : "-";
    lines.push(
      `| ${escapeCell(entry.path)} | ${formatDecay(entry.decay)} | ${entry.chars} | ${note} |`,
    );
  }
  const hidden = view.entries.length - shown.length;
  if (hidden > 0) {
    lines.push("", `... and ${hidden} more files not shown.`);
  }
  return lines.join("\n");
}
