import type { StaticItem } from "./types";

/**
 * The rows both transcript regions draw: older history in front of the core list,
 * each row once — as a **view** rather than a copy.
 *
 * Why a view: the committed list only ever grows (an item is appended when it
 * finishes rendering and never removed), while the live list is replaced on every
 * streaming chunk. Composing them into a fresh array therefore cost work
 * proportional to the *session* — `[...committed, ...live]` plus a `Set` over every
 * committed id — once per chunk, which is exactly the cost that grows with the
 * transcript the reader is least likely to be looking at. Both consumers only ever
 * ask for a length, an item by index, or a slice of the visible band, so the
 * composition answers those lazily and materializes the band's rows alone.
 *
 * What is *not* lazy, deliberately: the duplicate set. An older row that the core
 * also draws is dropped here (the core keeps its copy — it was assembled with its
 * own neighbours, so it holds the merged tool result a page assembled from a slice
 * cannot see). That check needs the committed ids, and the caller that has them
 * already hands them in (`transcriptCoreIds`), memoized on the committed list — so
 * the ids are walked when a commit lands, not when a chunk does. The older list
 * itself is the resident pages (`older-history.ts`), which the walk's window keeps
 * bounded, so walking it per composition is bounded too.
 */
export interface ComposedTranscript {
  /** Rows the composition holds: the kept older rows, then the core. */
  readonly length: number;
  /** The row at `index` of the composition, or `undefined` outside it. */
  at(index: number): StaticItem | undefined;
  /** The rows in `[from, to)`, materialized. */
  slice(from: number, to: number): StaticItem[];
}

export interface ComposeTranscriptInput {
  /** Older history, oldest first — the pages currently resident. */
  readonly older: readonly StaticItem[];
  /** Committed rows, oldest first. Only ever appended to. */
  readonly committed: readonly StaticItem[];
  /** The rows of the turn in flight that draw a row, to sit after the core. */
  readonly live: readonly StaticItem[];
  /**
   * The committed ids, when the caller already holds them.
   *
   * Building them is the one pass this module cannot avoid *somewhere*, and the
   * caller can keep it off the frame (`transcriptCoreIds`, memoized on the committed
   * array). Omitted, they are built here — correct, and only as cheap as the caller.
   */
  readonly committedIds?: ReadonlySet<string>;
}

/**
 * The ids of a committed list, as the duplicate check wants them.
 *
 * The one pass over the committed rows, for a caller that can hold on to the
 * result: the committed array only ever grows, so rebuilding this when a commit
 * lands is a per-commit cost, not a per-frame one.
 */
export function transcriptCoreIds(
  committed: readonly StaticItem[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of committed) ids.add(item.id);
  return ids;
}

/**
 * The older rows that go in front of the core: no row the core draws, no row twice.
 *
 * A row the core already has is dropped *here* rather than at load time, because the
 * core keeps committing rows while a page is in flight: the check has to see both
 * sides as they are at render time (`older-history.ts` §2).
 */
function keptOlderRows(
  older: readonly StaticItem[],
  committedIds: ReadonlySet<string>,
  liveIds: ReadonlySet<string> | null,
): StaticItem[] {
  if (older.length === 0) return [];
  const seen = new Set<string>();
  const kept: StaticItem[] = [];
  for (const item of older) {
    if (committedIds.has(item.id) || liveIds?.has(item.id)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    kept.push(item);
  }
  return kept;
}

/**
 * Compose the two regions into one addressable list.
 *
 * `at` and `slice` answer from the three lists directly, so the work a frame pays is
 * the rows that frame actually reads — the band — instead of the rows it holds.
 */
export function composeTranscript(
  input: ComposeTranscriptInput,
): ComposedTranscript {
  const { committed, live } = input;
  const liveIds =
    live.length === 0 ? null : new Set(live.map((item) => item.id));
  const older = keptOlderRows(
    input.older,
    input.committedIds ?? transcriptCoreIds(committed),
    liveIds,
  );

  const length = older.length + committed.length + live.length;
  const at = (index: number): StaticItem | undefined => {
    if (index < 0 || index >= length) return undefined;
    if (index < older.length) return older[index];
    const core = index - older.length;
    if (core < committed.length) return committed[core];
    return live[core - committed.length];
  };

  return {
    length,
    at,
    slice(from, to) {
      const start = Math.max(0, Math.trunc(from));
      const end = Math.min(length, Math.trunc(to));
      const rows: StaticItem[] = [];
      for (let index = start; index < end; index += 1) {
        const item = at(index);
        if (item !== undefined) rows.push(item);
      }
      return rows;
    },
  };
}

/**
 * The composed list as an array.
 *
 * The view is the implementation; this is the shape a caller that wants the rows
 * themselves — a test, or a region that draws all of them — asks for.
 */
export function composeTranscriptItems(
  older: readonly StaticItem[],
  core: readonly StaticItem[],
): StaticItem[] {
  const composed = composeTranscript({ older, committed: core, live: [] });
  return composed.slice(0, composed.length);
}
