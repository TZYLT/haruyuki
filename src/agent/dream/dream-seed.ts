/**
 * Dream run seed (F-06 / 46-6-Fix-A W5, design §5.10.4, §6.10).
 *
 * The seed is the one-time data block a dream run's first turn receives
 * through `{{run_seed}}`. It is pure data preparation: the harness gathers the
 * facts, the manual decides what to do with them. Section order is the order of
 * priority (design §6.10):
 *
 * ```text
 * layout → manifest → changes → decay top-N → core cost → deferred → notes
 * ```
 *
 * Two properties are load-bearing:
 *
 * - **Each block fails independently.** A memory repository with no git history,
 *   a broken `.memfs.config.json`, or an unreadable plan file must degrade that
 *   block to a single line and still let the run start. A seed that throws
 *   would take the whole run down for a missing convenience.
 * - **Numbers, not tables, where the manual does not need rows.** The manifest
 *   reports counts and anomaly totals; the decay table and the core cost table
 *   are the only per-file lists, and both are capped (20 rows each).
 *
 * The seed is injected once per run (W11); later turns get the tier manual and
 * the previous report excerpt instead.
 *
 * Layer: `agent/` — dream domain; imports `agent/` siblings and `utils/`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectIntervalChanges,
  computeDecayView,
  type DreamDecayView,
  readDecayIndex,
  renderDecayTable,
} from "@/agent/dream/dream-decay";
import {
  type DreamLayout,
  renderLayoutBlock,
  resolveDreamLayout,
} from "@/agent/dream/dream-layout";
import {
  DREAM_LARGE_FILE_TARGET_CHARS,
  indexCoverage,
  listMemoryFiles,
  type MemoryChangeSet,
  type MemoryDefectScan,
  type MemoryFileFact,
  recentChanges,
  scanDefects,
} from "@/agent/dream/dream-manifest";
import { type DreamNote, renderNotesSection } from "@/agent/dream/dream-notes";
import { estimateSystemPromptSize } from "@/agent/system-prompt-size";
import { debugWarn } from "@/utils/debug";

/** The deferred container the tidy workflow keeps across runs (design §6.8). */
export const DREAM_PLAN_PATH = "maintenance/dream-plan.md";

/**
 * Calibrate before release (checklist §4): the deferred plan renders at most
 * this many items; the rest are summarized as a count.
 */
export const DREAM_DEFERRED_LIMIT = 20;

/** Prompt-size guard for the change list (not a calibration knob). */
export const DREAM_SEED_CHANGE_COMMIT_LIMIT = 20;
/** Prompt-size guard: files listed per commit before collapsing to a count. */
export const DREAM_SEED_CHANGE_FILE_LIMIT = 8;

/** Numeric summary of the memory manifest; no paths, by design. */
export interface DreamSeedManifest {
  /** Distinct directories that hold Markdown (the root counts as one). */
  directories: number;
  files: number;
  markdownFiles: number;
  chars: number;
  lines: number;
  /** `withIndex / needsIndex`; `1` when nothing needs an index. */
  indexCoverage: number;
  indexNeeded: number;
  indexPresent: number;
  missingIndexes: number;
  brokenLinks: number;
  oversizedFiles: number;
  largeFiles: number;
  largeFileRatio: number;
  /** `null` when the repository sets no per-file cap. */
  maxFileCharacters: number | null;
}

export interface DreamSeedCoreCostRow {
  path: string;
  /** Character count from the manifest, or `null` when it was unavailable. */
  chars: number | null;
  /** Estimated tokens (4 bytes per token, shared estimator). */
  tokens: number;
  /** Share of the core set's estimated tokens. */
  share: number;
}

export interface DreamSeedCoreCost {
  rows: DreamSeedCoreCostRow[];
  totalTokens: number;
}

export type DreamDeferredKind = "continue" | "blocked" | "mechanical" | "other";

export interface DreamDeferredItem {
  kind: DreamDeferredKind;
  text: string;
  /** Markdown heading the item was listed under, when there was one. */
  section: string | null;
}

export interface DreamDeferredPlan {
  path: string;
  present: boolean;
  /** Items after the {@link DREAM_DEFERRED_LIMIT} cut. */
  items: DreamDeferredItem[];
  /** Item count before the cut. */
  total: number;
  truncated: boolean;
  limit: number;
}

/** The seed blocks that can fail on their own. */
export type DreamSeedBlock =
  | "layout"
  | "manifest"
  | "changes"
  | "decay"
  | "core-cost"
  | "deferred";

export interface DreamSeedDegradation {
  block: DreamSeedBlock;
  /** One line, why the block is missing from this run's seed. */
  reason: string;
}

/** Everything the seed carries; `null` means "block failed, see degraded". */
export interface DreamSeed {
  layout: DreamLayout | null;
  manifest: DreamSeedManifest | null;
  changes: MemoryChangeSet | null;
  decay: DreamDecayView | null;
  coreCost: DreamSeedCoreCost | null;
  deferred: DreamDeferredPlan | null;
  notes: readonly DreamNote[];
  degraded: readonly DreamSeedDegradation[];
}

export interface CollectDreamSeedInput {
  agentId: string;
  memoryDir: string;
  runId: string;
  /** Epoch ms of the run start; injected for deterministic tests. */
  now: number;
  /** Notes claimed by this run (W4); omitted means "no notes". */
  notes?: readonly DreamNote[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function singleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function escapeCell(text: string): string {
  return singleLine(text).replaceAll("|", "\\|");
}

function summarizeManifest(
  files: readonly MemoryFileFact[],
  defects: MemoryDefectScan,
  layout: DreamLayout,
): DreamSeedManifest {
  const coverage = indexCoverage(files, layout);
  let chars = 0;
  let lines = 0;
  let markdownFiles = 0;
  for (const file of files) {
    chars += file.chars;
    lines += file.lines;
    if (file.isMarkdown) markdownFiles += 1;
  }
  return {
    directories: coverage.directories.length,
    files: files.length,
    markdownFiles,
    chars,
    lines,
    indexCoverage: coverage.coverage,
    indexNeeded: coverage.needsIndex,
    indexPresent: coverage.withIndex,
    missingIndexes: defects.missingIndexes.length,
    brokenLinks: defects.brokenLinks.length,
    oversizedFiles: defects.oversizedFiles.length,
    largeFiles: defects.largeFiles.length,
    largeFileRatio: defects.largeFileRatio,
    maxFileCharacters: layout.limits.maxFileCharacters,
  };
}

function classifyDeferred(
  section: string | null,
  text: string,
): DreamDeferredKind {
  const haystack = `${section ?? ""} ${text}`.toLowerCase();
  if (/blocked|blocker|阻塞|等待用户|needs? user/u.test(haystack)) {
    return "blocked";
  }
  if (/continue|resume|next|继续|待续/u.test(haystack)) return "continue";
  if (/mechanical|chore|routine|cleanup|机械/u.test(haystack)) {
    return "mechanical";
  }
  return "other";
}

/**
 * Parse the plan's top-level list items, grouped by the heading above them.
 *
 * The format is the tidy manual's (W10): a Markdown list under `## Continue`,
 * `## Blocked`, `## Mechanical` (or the Chinese equivalents). Parsing is
 * deliberately tolerant — unknown headings become `other`, `[x]` items are
 * treated as done and skipped, fenced code blocks are ignored — because a plan
 * file the run wrote by hand must never crash the seed.
 */
export function parseDeferredItems(body: string): DreamDeferredItem[] {
  const items: DreamDeferredItem[] = [];
  let section: string | null = null;
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading !== null) {
      section = (heading[1] ?? "").trim();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (item === null) continue;
    let text = (item[1] ?? "").trim();
    const checkbox = /^\[([ xX])\]\s*(.*)$/u.exec(text);
    if (checkbox !== null) {
      if ((checkbox[1] ?? "").toLowerCase() === "x") continue;
      text = (checkbox[2] ?? "").trim();
    }
    if (text.length === 0) continue;
    items.push({ kind: classifyDeferred(section, text), text, section });
  }
  return items;
}

/**
 * Read `maintenance/dream-plan.md`. A missing file is "no deferred work", not
 * an error; any other read failure is thrown so the seed can degrade the block.
 */
export async function readDeferredPlan(
  memoryDir: string,
): Promise<DreamDeferredPlan> {
  const path = join(memoryDir, DREAM_PLAN_PATH);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: DREAM_PLAN_PATH,
        present: false,
        items: [],
        total: 0,
        truncated: false,
        limit: DREAM_DEFERRED_LIMIT,
      };
    }
    throw error;
  }
  const items = parseDeferredItems(body);
  return {
    path: DREAM_PLAN_PATH,
    present: true,
    items: items.slice(0, DREAM_DEFERRED_LIMIT),
    total: items.length,
    truncated: items.length > DREAM_DEFERRED_LIMIT,
    limit: DREAM_DEFERRED_LIMIT,
  };
}

/**
 * Collect every seed block, degrading failures to one line each. The blocks are
 * independent on purpose: a git failure removes the change list and the decay
 * ranking but the run still starts with the layout facts and the manual.
 */
export async function collectDreamSeed(
  input: CollectDreamSeedInput,
): Promise<DreamSeed> {
  const degraded: DreamSeedDegradation[] = [];
  const degradedBlocks = new Set<DreamSeedBlock>();
  const degrade = (block: DreamSeedBlock, error: unknown): void => {
    if (degradedBlocks.has(block)) return;
    degradedBlocks.add(block);
    const reason = singleLine(errorMessage(error)).slice(0, 300);
    degraded.push({ block, reason });
    debugWarn("dream-seed", `${block} block unavailable: ${reason}`);
  };

  const index = await readDecayIndex(input.agentId);

  let layout: DreamLayout | null = null;
  try {
    layout = resolveDreamLayout(input.memoryDir);
  } catch (error) {
    degrade("layout", error);
  }

  let files: MemoryFileFact[] | null = null;
  try {
    // Unprojected files matter here: a v2 directory without its index hides
    // its files from the runtime, and the missing-index defect must see them.
    files = await listMemoryFiles(input.memoryDir, {
      includeUnprojected: true,
    });
  } catch (error) {
    degrade("manifest", error);
  }

  let defects: MemoryDefectScan | null = null;
  if (layout !== null && files !== null) {
    try {
      defects = scanDefects(files, layout, {
        maxFileCharacters: layout.limits.maxFileCharacters,
      });
    } catch (error) {
      degrade("manifest", error);
    }
  }

  const manifest =
    layout !== null && files !== null && defects !== null
      ? summarizeManifest(files, defects, layout)
      : null;
  if (manifest === null) {
    degrade("manifest", "the layout facts or the file scan were unavailable");
  }

  let changes: MemoryChangeSet | null = null;
  try {
    changes = await recentChanges(input.memoryDir, index.lastRunHead);
  } catch (error) {
    degrade("changes", error);
  }

  let decay: DreamDecayView | null = null;
  if (layout !== null && files !== null && defects !== null) {
    try {
      const intervalChangedLines = await collectIntervalChanges(
        input.memoryDir,
        index.lastRunHead,
      );
      decay = computeDecayView({
        index,
        layout,
        manifest: files,
        defects,
        now: input.now,
        intervalChangedLines,
      });
    } catch (error) {
      degrade("decay", error);
    }
  }
  if (decay === null) {
    degrade("decay", "the manifest or layout facts were unavailable");
  }

  let coreCost: DreamSeedCoreCost | null = null;
  try {
    const estimate = estimateSystemPromptSize(input.memoryDir, true);
    const charsByPath = new Map<string, number>();
    for (const file of files ?? []) charsByPath.set(file.path, file.chars);
    const rows: DreamSeedCoreCostRow[] = estimate.files.map((file) => ({
      path: file.path,
      chars: charsByPath.get(file.path) ?? null,
      tokens: file.tokens,
      share: estimate.total === 0 ? 0 : file.tokens / estimate.total,
    }));
    coreCost = { rows, totalTokens: estimate.total };
  } catch (error) {
    degrade("core-cost", error);
  }

  let deferred: DreamDeferredPlan | null = null;
  try {
    deferred = await readDeferredPlan(input.memoryDir);
  } catch (error) {
    degrade("deferred", error);
  }

  return {
    layout,
    manifest,
    changes,
    decay,
    coreCost,
    deferred,
    notes: input.notes ?? [],
    degraded,
  };
}

function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function shortSha(sha: string | null): string {
  if (sha === null) return "none";
  return sha.slice(0, 7);
}

export function renderManifestSection(manifest: DreamSeedManifest): string {
  const cap =
    manifest.maxFileCharacters === null
      ? "no per-file character cap"
      : `files over the ${manifest.maxFileCharacters}-character cap: ${manifest.oversizedFiles}`;
  return [
    "## Memory manifest",
    "",
    `- files: ${manifest.files} tracked, ${manifest.markdownFiles} Markdown; ${manifest.chars} characters, ${manifest.lines} lines`,
    `- directories: ${manifest.directories}; index coverage: ${manifest.indexPresent}/${manifest.indexNeeded}`,
    `- missing indexes: ${manifest.missingIndexes}; broken links: ${manifest.brokenLinks}`,
    `- ${cap}; files over the ${DREAM_LARGE_FILE_TARGET_CHARS}-character target: ${manifest.largeFiles} (${formatShare(manifest.largeFileRatio)})`,
  ].join("\n");
}

export function renderChangesSection(changes: MemoryChangeSet): string {
  const lines: string[] = ["## Changes since the last run", ""];
  if (changes.firstTracked) {
    lines.push(
      "first tracked run — no previous run head is recorded, so there is no change list.",
    );
    return lines.join("\n");
  }
  if (changes.commits.length === 0) {
    lines.push(
      `no commits since ${shortSha(changes.sinceSha)} (HEAD ${shortSha(changes.headSha)}).`,
    );
    return lines.join("\n");
  }
  lines.push(
    `range ${shortSha(changes.sinceSha)}..${shortSha(changes.headSha)}; the harness's own report churn is filtered out.`,
  );
  lines.push("");
  const commits = changes.commits.slice(0, DREAM_SEED_CHANGE_COMMIT_LIMIT);
  for (const commit of commits) {
    lines.push(`- ${commit.sha.slice(0, 7)} ${singleLine(commit.subject)}`);
    const shownFiles = commit.files.slice(0, DREAM_SEED_CHANGE_FILE_LIMIT);
    for (const file of shownFiles) {
      lines.push(
        `  - ${file.path} (${file.status}, +${file.added}/-${file.deleted})`,
      );
    }
    if (commit.files.length > shownFiles.length) {
      lines.push(
        `  - ... and ${commit.files.length - shownFiles.length} more files`,
      );
    }
  }
  if (changes.commits.length > commits.length) {
    lines.push(
      "",
      `... and ${changes.commits.length - commits.length} more commits not shown.`,
    );
  }
  return lines.join("\n");
}

export function renderCoreCostSection(cost: DreamSeedCoreCost): string {
  const lines: string[] = [
    "## Core context cost",
    "",
    "Core files are always in the system prompt (v1: `system/**`; v2: root `*.md`). Tokens are estimated at 4 bytes per token.",
  ];
  if (cost.rows.length === 0) {
    lines.push("", "No core files.");
    return lines.join("\n");
  }
  lines.push(
    "",
    "| path | chars | tokens | share |",
    "| --- | --- | --- | --- |",
  );
  for (const row of cost.rows) {
    lines.push(
      `| ${escapeCell(row.path)} | ${row.chars ?? "-"} | ${row.tokens} | ${formatShare(row.share)} |`,
    );
  }
  lines.push("", `total: ${cost.totalTokens} tokens`);
  return lines.join("\n");
}

export function renderDeferredSection(plan: DreamDeferredPlan): string {
  const lines: string[] = [`## Deferred items (${plan.path})`, ""];
  if (!plan.present) {
    lines.push("none — the file does not exist.");
    return lines.join("\n");
  }
  if (plan.items.length === 0) {
    lines.push("none — the file lists no open items.");
    return lines.join("\n");
  }
  for (const item of plan.items) {
    lines.push(`- [${item.kind}] ${singleLine(item.text)}`);
  }
  if (plan.truncated) {
    lines.push(
      "",
      `(${plan.total - plan.items.length} more items are not shown; the plan holds ${plan.total}.)`,
    );
  }
  return lines.join("\n");
}

function degradedSection(title: string, reason: string | undefined): string {
  return `## ${title}\n\nUnavailable in this run: ${
    reason ?? "the harness could not prepare this block."
  }`;
}

/**
 * Render the seed. Section order is priority order (design §6.10); a failed
 * block keeps its position and is replaced by a one-line explanation, so the
 * model can tell "nothing to do" from "the harness could not read it".
 */
export function renderSeed(seed: DreamSeed): string {
  const reasonFor = (block: DreamSeedBlock): string | undefined =>
    seed.degraded.find((entry) => entry.block === block)?.reason;
  const blocks: string[] = [
    "Run seed — mechanical data the harness prepared for this run. Section order is priority order.",
    seed.layout !== null
      ? renderLayoutBlock(seed.layout)
      : degradedSection(
          "Memory layout (mechanical facts)",
          reasonFor("layout"),
        ),
    seed.manifest !== null
      ? renderManifestSection(seed.manifest)
      : degradedSection("Memory manifest", reasonFor("manifest")),
    seed.changes !== null
      ? renderChangesSection(seed.changes)
      : degradedSection("Changes since the last run", reasonFor("changes")),
    seed.decay !== null
      ? renderDecayTable(seed.decay)
      : degradedSection("Decay ranking", reasonFor("decay")),
    seed.coreCost !== null
      ? renderCoreCostSection(seed.coreCost)
      : degradedSection("Core context cost", reasonFor("core-cost")),
    seed.deferred !== null
      ? renderDeferredSection(seed.deferred)
      : degradedSection(
          `Deferred items (${DREAM_PLAN_PATH})`,
          reasonFor("deferred"),
        ),
  ];
  const notes = renderNotesSection(seed.notes);
  if (notes.length > 0) blocks.push(notes);
  return blocks.join("\n\n");
}
