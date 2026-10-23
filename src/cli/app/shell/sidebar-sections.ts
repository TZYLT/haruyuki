// src/cli/app/shell/sidebar-sections.ts

import type { TurnStatsSnapshot } from "@/agent/stats";
import { truncateToWidth } from "@/cli/display/statusline/formatting";
import { formatCompact } from "@/cli/helpers/format";
import { formatCost } from "@/cli/helpers/usage-format";
import type { UsageContextBreakdown } from "@/utils/usage-context";

/**
 * The sidebar's geometry, and the rule that keeps it inside the band.
 *
 * The sidebar is **not scrollable** (`《38》§6.2`): it has to be bounded, so it
 * carries a priority instead. When the band is shorter than the content, whole
 * sections give way — first to a one-line summary, then entirely — from the
 * lowest priority upward. Nothing is ever cut inside a line, because a clipped
 * word reads as a bug and a missing section reads as a missing section.
 *
 * All of the arithmetic is pure so it can be answered without mounting Ink: the
 * width table in `《38》§6.3` is a table, and a table is a test.
 *
 * Geometry, at 100 columns (the sketch in `《38》§2.2`):
 *
 * ```
 *  69 columns transcript | 1 gutter | │ + space | 28 columns of content
 *                       = 30-column sidebar block (`《38》§6.3`)
 * ```
 *
 * The widths in that table always sum to `columns - 1`: the transcript, the
 * gutter, and the sidebar. The two columns after the divider are the sidebar's
 * own chrome (`│` and one space), which is why the content is `width - 2`.
 */

/** Narrowest sidebar the design allows, in columns. */
export const SIDEBAR_MIN_COLUMNS = 24;

/** Widest sidebar, so a 200-column terminal does not get a 60-column rail. */
export const SIDEBAR_MAX_COLUMNS = 32;

/**
 * Below this many terminal columns the sidebar folds.
 *
 * It is the width where the proportional share would fall under the 24-column
 * floor, so folding is what the floor does to a terminal that cannot afford it.
 */
export const SIDEBAR_FOLD_COLUMNS = 80;

/**
 * Below this many terminal rows the sidebar folds.
 *
 * 26 is the height where the strip, one content row, the input, and the two
 * bottom rows still leave a band worth reading. `《38》§6.3` folds on the
 * *terminal* rows, not on the band: the band is measured a frame late, and a rail
 * that appears and disappears as the composer grows would be worse than a rail
 * that folds once, at a size the user can reason about.
 */
export const SIDEBAR_FOLD_ROWS = 26;

/** The divider and the space after it: `│ `, drawn inside the sidebar block. */
export const SIDEBAR_CHROME_COLUMNS = 2;

/** One spacer column between the transcript and the divider. */
export const SIDEBAR_GUTTER_COLUMNS = 1;

/**
 * The sidebar's column count at this terminal size, or `0` when it folds.
 *
 * `clamp(24, floor(30%), 32)` per `《38》§6.3`. The proportional share is
 * computed as `columns * 3 / 10`, not `columns * 0.3`, so `90` answers `27` and
 * not `26.999999999999996` floored to `26`.
 */
export function sidebarWidth(columns: number, rows: number): number {
  if (columns < SIDEBAR_FOLD_COLUMNS || rows < SIDEBAR_FOLD_ROWS) return 0;
  const share = Math.floor((Math.max(0, Math.floor(columns)) * 3) / 10);
  const clamped = Math.min(
    SIDEBAR_MAX_COLUMNS,
    Math.max(SIDEBAR_MIN_COLUMNS, share),
  );
  // A sidebar wider than the terminal has no transcript left to sit beside.
  return Math.min(
    clamped,
    Math.max(0, Math.floor(columns) - SIDEBAR_GUTTER_COLUMNS - 1),
  );
}

/** Columns left for the transcript beside a `width` sidebar (0 when folded). */
export function transcriptColumns(columns: number, width: number): number {
  if (width <= 0) return Math.max(0, Math.floor(columns));
  return Math.max(1, Math.floor(columns) - width - SIDEBAR_GUTTER_COLUMNS);
}

/** Columns a sidebar's text may occupy: its block less `│ ` and nothing else. */
export function sidebarContentColumns(width: number): number {
  return Math.max(0, Math.floor(width) - SIDEBAR_CHROME_COLUMNS);
}

/**
 * The band's and the rail's columns for a frame `columns` wide.
 *
 * **The last two columns of the terminal are never written.** The rest of this
 * tree already leaves that margin (the strip builds its row `ROW_SAFETY_COLUMNS`
 * short, the transcript band does the same), and the rail made it matter: a row
 * that reaches the final column leaves the terminal in the pending-wrap state, so
 * the next write wraps and the frame grows by a line. After the rail was painted
 * as full-width rows, every band row ended at the last column and the machine
 * showed exactly that — the tab strip scrolled away and the transcript looked
 * re-wrapped. The design table's numbers assume the full width; the two columns
 * are the price of not scrolling the screen.
 */
export type SidebarGeometry = {
  /** The rail's block width, or `0` when it folds. */
  railWidth: number;
  /** Columns the transcript/page body may occupy (gutter and rail excluded). */
  bandColumns: number;
  /** 1-based column the rail's divider stands in, or `0` when folded. */
  junctionColumn: number;
};

export function sidebarGeometry(
  columns: number,
  rows: number,
): SidebarGeometry {
  const total = Math.max(1, Math.floor(columns));
  // Two columns of margin, the same trade every other row in the frame makes.
  const usable = Math.max(1, total - 2);
  const railWidth = sidebarWidth(total, rows);
  if (railWidth <= 0) {
    return { railWidth: 0, bandColumns: usable, junctionColumn: 0 };
  }
  const bandColumns = transcriptColumns(usable, railWidth);
  return {
    railWidth,
    bandColumns,
    junctionColumn: bandColumns + SIDEBAR_GUTTER_COLUMNS + 1,
  };
}

/**
 * One section, as the content decides it.
 *
 * `detail` is the rows drawn when the section has room; `summary` is the single
 * row that stands in for it just before it is dropped. Both are plain strings so
 * a section's copy is testable and its priority is just its position.
 */
export type SidebarSectionSpec = {
  id: string;
  title: string;
  detail: readonly string[];
  summary: string;
};

/** How much of a section survived the fit. */
export type SidebarSectionState = "detail" | "summary";

export type FittedSidebarSection = {
  spec: SidebarSectionSpec;
  state: SidebarSectionState;
  /** The rows to draw, `title` included as the caller's own first line. */
  lines: readonly string[];
};

function costOf(spec: SidebarSectionSpec, state: SidebarSectionState): number {
  // Title row plus the content. The blank between sections is counted once, by
  // the caller, over the whole block.
  return 1 + (state === "detail" ? spec.detail.length : 1);
}

function totalRows(fitted: readonly FittedSidebarSection[]): number {
  if (fitted.length === 0) return 0;
  const bodies = fitted.reduce(
    (sum, section) => sum + costOf(section.spec, section.state),
    0,
  );
  return bodies + (fitted.length - 1);
}

/**
 * Fit sections into `availableRows`, giving way from the bottom up.
 *
 * The list is in priority order: index 0 is the one that survives longest. The
 * loop always degrades the **lowest-priority surviving** section one step
 * (`detail` → `summary` → gone), so a section is never shown half of its detail
 * while a less important one below it is still whole.
 *
 * Returns only what fits, in the original order. The caller draws a blank line
 * between consecutive results.
 */
export function fitSidebarSections(
  specs: readonly SidebarSectionSpec[],
  availableRows: number,
): FittedSidebarSection[] {
  const budget = Math.floor(availableRows);
  if (budget <= 0 || specs.length === 0) return [];

  const states: Array<SidebarSectionState | null> = specs.map((spec) =>
    spec.detail.length > 0 ? "detail" : "summary",
  );

  const build = (): FittedSidebarSection[] =>
    specs.flatMap((spec, index) => {
      const state = states[index];
      if (!state) return [];
      const lines = state === "detail" ? spec.detail : [spec.summary];
      return [{ spec, state, lines }];
    });

  const over = (): boolean => totalRows(build()) > budget;

  // Bottom-up: the last surviving section degrades, then the one before it. The
  // loop is bounded by `specs.length * 2` because every step removes one state.
  while (over()) {
    let degraded = false;
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state === "detail") {
        states[index] = "summary";
        degraded = true;
        break;
      }
      if (state === "summary") {
        states[index] = null;
        degraded = true;
        break;
      }
    }
    if (!degraded) break;
  }

  return build();
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Everything the sections read, handed in once.
 *
 * The sidebar **reads projections, it does not compute them** (`《38》§6.5`): a
 * second tally of tokens or steps in the rail would drift from the status line
 * and the Usage page with no error, which is the class of bug this whole
 * redesign is about. `null` means "the source exists but is not wired yet", and
 * the section says so rather than printing a zero that reads as a measurement.
 */
export type SidebarProjection = {
  /** Content columns available to a section (the block less `│ `). */
  width: number;
  usedContextTokens: number | null;
  contextWindowSize: number | null;
  /** What the last request was made of; `null` before the first turn. */
  contextBreakdown: UsageContextBreakdown | null;
  /**
   * The current user turn, or the one that just ended.
   *
   * A turn is one user message and its answer; its steps, tokens and clock are
   * the turn's own, not the session's. The stats snapshot hands this over
   * already projected — a second tally here would drift from the ledger and the
   * status line with no error, which is the class of bug the rail exists to
   * avoid. Zeros (not `null`) before the first message: "nothing has run yet"
   * is a real measurement, unlike a ledger read that has not finished.
   */
  turn: TurnStatsSnapshot;
  reasoningTokens: number;
  /** Running subagents, newest first; `null` (or empty) hides the section. */
  agents: readonly { type: string; durationMs: number }[] | null;
  /**
   * Today's ledger (`《33》§12` P4), straight from `summarizeUsage`.
   *
   * The rail does not sum the file itself: `src/usage/summary.ts` is the one
   * definition of "today", and it is what the Usage page reads too. `null`
   * means the read has not finished yet.
   */
  today: {
    tokens: number;
    turns: number;
    /** Input billed at the cache-read (hit) rate. */
    cacheReadTokens: number;
    /** Input billed at the miss rate. */
    uncachedTokens: number;
    /** Output tokens — `completion` in the ledger's own words. */
    outputTokens: number;
    /** `cachedInput / (prompt + cachedInput)` for today; absent with no input. */
    hitRate?: number;
    /** Absent when nothing today carried a price. */
    costUsd?: number;
  } | null;
  /** Memory activity. Absent until its reader lands. */
  memfs: {
    commits7d: number;
    changedLines7d: number;
    totalBytes: number;
  } | null;
};

function contextPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function clock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function bytesLabel(bytes: number): string {
  // Bytes, not MB: a rail that rounds 1,176,320 to "1.1 MB" hides the only digit
  // that changes from turn to turn. The separator is the locale's, so the number
  // stays readable at seven digits.
  return `${Math.max(0, Math.round(bytes)).toLocaleString("en-US")} B`;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * One section: its identity, its title, and how it draws itself.
 *
 * **The registry below is the extension seam.** A new rail section is one entry
 * plus one field on `SidebarProjection`; ordering is array order, so priority is
 * visible where the sections are. User control (hiding or reordering a section)
 * is a later settings key that filters this list — the shape already supports it,
 * and `《38》§6.5`'s "no mod panels in the rail" is unaffected: these are host
 * sections, not mod-rendered ones.
 */
export type SidebarSectionDefinition = {
  id: string;
  title: string;
  /** `null` hides the section for this frame (an empty Agents list, say). */
  build: (projection: SidebarProjection) => {
    detail: readonly string[];
    summary: string;
  } | null;
};

function contextSection(projection: SidebarProjection) {
  const used = projection.usedContextTokens;
  const limit = projection.contextWindowSize;
  const hasUsage = used !== null && limit !== null && limit > 0;
  const percent = hasUsage
    ? contextPercent(used as number, limit as number)
    : null;
  // The split the section exists for: what stands in front of the conversation
  // (system prompt and tool definitions) versus the transcript itself. It comes
  // from the last request the backend assembled, so every part is a measurement
  // of that request, not a subtraction of the live number. The two leader parts
  // get a row each: `sys 31k · tools 4k` on 22 content columns of a folded rail
  // reads as one number, and the split is the whole point of the row.
  const breakdown = projection.contextBreakdown;
  // Plain text, no bar: the rail's job is the numbers, and a glyph bar on a
  // 28-column line would spend a third of the width saying what `62%` says.
  return {
    detail: [
      `ctx ${percent === null ? "—" : `${percent}%`} · ${hasUsage ? formatCompact(used as number) : "—"} / ${limit === null ? "—" : formatCompact(limit)}`,
      `sys ${breakdown ? formatCompact(breakdown.system) : "—"}`,
      `tools ${breakdown ? formatCompact(breakdown.tools) : "—"}`,
      `chat ${breakdown ? formatCompact(breakdown.messages) : "—"}`,
      `reasoning ${formatCompact(projection.reasoningTokens)}`,
    ],
    summary: `ctx ${percent === null ? "—" : `${percent}%`}`,
  };
}

function turnSection(projection: SidebarProjection) {
  const turn = projection.turn;
  const head = `${turn.steps} steps · ${clock(turn.wallMs)}`;
  return {
    detail: [
      head,
      `${formatCompact(turn.outputTokens)} out · ${formatCompact(turn.inputTokens)} in`,
    ],
    summary: head,
  };
}

/** ` (95.4%)`, or nothing when the day had no input to divide by. */
function hitRateLabel(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return "";
  return ` (${(rate * 100).toFixed(1)}%)`;
}

function usageSection(projection: SidebarProjection) {
  const today = projection.today;
  if (!today) {
    return { detail: ["today — (ledger pending)"], summary: "today —" };
  }
  // The rows are the day's four numbers in the words the page uses: `hit` and
  // `miss` are the two input prices (hit first, with its share of input), `out`
  // is what the model produced, `cost` the day's total. A `—` cost is "nothing
  // priced today", which is not the same statement as free.
  return {
    detail: [
      `today ${formatCompact(today.tokens)} tok`,
      `hit ${formatCompact(today.cacheReadTokens)}${hitRateLabel(today.hitRate)}`,
      `miss ${formatCompact(today.uncachedTokens)}`,
      `out ${formatCompact(today.outputTokens)}`,
      `cost ${formatCost(today.costUsd)}`,
    ],
    summary: `today ${formatCompact(today.tokens)} tok`,
  };
}

function agentsSection(projection: SidebarProjection) {
  const agents = projection.agents ?? [];
  if (agents.length === 0) return null;
  const shown = agents.slice(0, 3);
  const hidden = agents.length - shown.length;
  const detail = shown.map(
    (agent) =>
      `• ${agent.type} ${Math.max(0, Math.round(agent.durationMs / 1000))}s`,
  );
  if (hidden > 0) detail.push(`+${hidden}`);
  return {
    detail,
    summary: `${agents.length} running`,
  };
}

function memfsSection(projection: SidebarProjection) {
  const memfs = projection.memfs;
  if (!memfs) {
    return {
      detail: ["7d — commits", "— lines", "total —"],
      summary: "7d — commits",
    };
  }
  return {
    detail: [
      `7d ${memfs.commits7d} commits`,
      `${signed(memfs.changedLines7d)} lines`,
      `total ${bytesLabel(memfs.totalBytes)}`,
    ],
    summary: `7d ${memfs.commits7d} commits`,
  };
}

/**
 * The rail's sections, highest priority first.
 *
 * `Context` first because it is the one number that can page the user out.
 * `Agents` before `MemFS` because it is transient — it is hidden when nothing
 * runs, so its rank only decides who gives way in the first frame of a turn.
 */
export const SIDEBAR_SECTIONS: readonly SidebarSectionDefinition[] = [
  { id: "context", title: "Context", build: contextSection },
  // `Turn`, not `Session`: the rows are the current user message's own steps,
  // tokens and clock — they reset when the next message starts a new turn. The
  // title also avoids colliding with the conversation tab of the same name.
  { id: "turn", title: "Turn", build: turnSection },
  { id: "usage", title: "Usage", build: usageSection },
  { id: "agents", title: "Agents", build: agentsSection },
  { id: "memfs", title: "MemFS", build: memfsSection },
];

/**
 * The sections this frame would draw, already trimmed to the rail's width.
 *
 * Trimming happens here, not in the component: every line a caller gets is
 * paintable, so the fit and the paint cannot disagree about a row's width.
 */
export function buildSidebarSections(
  projection: SidebarProjection,
  sections: readonly SidebarSectionDefinition[] = SIDEBAR_SECTIONS,
): SidebarSectionSpec[] {
  const width = Math.max(1, Math.floor(projection.width));
  return sections.flatMap((section) => {
    const content = section.build(projection);
    if (!content) return [];
    return [
      {
        id: section.id,
        title: truncateToWidth(section.title, width),
        detail: content.detail.map((line) => truncateToWidth(line, width)),
        summary: truncateToWidth(content.summary, width),
      },
    ];
  });
}
