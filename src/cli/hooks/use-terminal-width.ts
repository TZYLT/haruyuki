import { useEffect, useState } from "react";
import { debugWarn } from "@/utils/debug";

const getStdout = () => {
  if (typeof process === "undefined") return undefined;
  const stdout = process.stdout as NodeJS.WriteStream | undefined;
  return stdout && typeof stdout.on === "function" ? stdout : undefined;
};

/** The terminal whose size is reported when nothing answers. */
const DEFAULT_SIZE = { columns: 80, rows: 24 } as const;

/**
 * The console's own answer, or `null` when it cannot give one.
 *
 * Node's `tty.WriteStream.getWindowSize()` answers `[columns, rows]`.
 */
function askConsole(stdout: NodeJS.WriteStream): {
  columns?: number;
  rows?: number;
} | null {
  const sized = stdout as NodeJS.WriteStream & {
    getWindowSize?: () => unknown;
  };
  try {
    const queried = sized.getWindowSize?.();
    if (Array.isArray(queried)) {
      const [columns, rows] = queried as [number, number];
      return { columns, rows };
    }
    if (queried && typeof queried === "object") {
      return queried as { columns?: number; rows?: number };
    }
  } catch {
    // Not a console after all; the cached properties are all there is.
  }
  return null;
}

let reportedSizeMismatch: string | null = null;

/**
 * One dimension, from two sources that can disagree.
 *
 * **The smaller one wins.** The two numbers come from different places: the
 * console query asks the terminal, while `stdout.columns`/`rows` are the cached
 * properties Ink lays the frame out at and erases by. On the machine they
 * disagreed by two (2026-10-20), and the direction matters enormously:
 *
 * - **One column too many** makes every full-width row wrap — the composer's
 *   dividers, the status line, the tab row — and each wrapped row adds a line.
 *   A frame taller than the alternate screen scrolls it, and the rows that leave
 *   are the ones at the top: the tab row, which is then nowhere and clickable
 *   nowhere.
 * - **One row too many** does the same thing directly.
 * - **One too few** is a blank line, or a frame that stops a row short of the
 *   bottom edge.
 *
 * So a disagreement is a choice between a cosmetic gap and a dead feature, and
 * the smaller number is the one that cannot break the frame. The pair is logged
 * once, because which source lies (and by how much) is a fact about the machine
 * that should be in the session log rather than guessed at.
 */
function chooseSize(
  fromConsole: number | undefined,
  cached: number,
  fallback: number,
  axis: "columns" | "rows",
): number {
  const queried =
    fromConsole !== undefined && fromConsole > 0 ? fromConsole : null;
  const pinned = cached > 0 ? cached : null;
  if (queried === null && pinned === null) return fallback;
  if (queried === null) return pinned as number;
  if (pinned === null) return queried;
  if (queried !== pinned) {
    const pair = `${axis}:${queried}->${pinned}`;
    if (reportedSizeMismatch !== pair) {
      reportedSizeMismatch = pair;
      debugWarn(
        "terminal-size",
        `${axis}: console reports ${queried}, the stream says ${pinned}; using ${Math.min(queried, pinned)}`,
      );
    }
  }
  return Math.min(queried, pinned);
}

/**
 * Reads the terminal size for this render.
 *
 * Both sources are consulted and reconciled per call (`chooseSize`), because
 * either can be the wrong one on a given host: the cached properties can lag a
 * resize (which is why the console is asked at all), and the console's answer is
 * not what Ink drew against (which is why it cannot simply win). Reading here
 * rather than from state keeps a stale number out of the layout; the state in
 * the hooks below exists only to schedule the re-render that a resize needs.
 */
const querySize = (): { columns: number; rows: number } => {
  const stdout = getStdout();
  if (!stdout) return { ...DEFAULT_SIZE };
  const console_ = askConsole(stdout);
  return {
    columns: chooseSize(
      console_?.columns,
      stdout.columns ?? 0,
      DEFAULT_SIZE.columns,
      "columns",
    ),
    rows: chooseSize(
      console_?.rows,
      stdout.rows ?? 0,
      DEFAULT_SIZE.rows,
      "rows",
    ),
  };
};

const getTerminalWidth = () => querySize().columns;
const getTerminalRows = () => querySize().rows;

type WidthListener = (columns: number) => void;
type RowsListener = (rows: number) => void;

const widthListeners = new Set<WidthListener>();
const rowsListeners = new Set<RowsListener>();
let resizeHandlerRegistered = false;
let trackedColumns = getTerminalWidth();
let trackedRows = getTerminalRows();

const resizeHandler = () => {
  const nextColumns = getTerminalWidth();
  const nextRows = getTerminalRows();

  if (nextColumns !== trackedColumns) {
    trackedColumns = nextColumns;
    for (const listener of widthListeners) {
      listener(nextColumns);
    }
  }

  if (nextRows !== trackedRows) {
    trackedRows = nextRows;
    for (const listener of rowsListeners) {
      listener(nextRows);
    }
  }
};

const ensureResizeHandler = () => {
  if (resizeHandlerRegistered) return;
  const stdout = getStdout();
  if (!stdout) return;
  stdout.on("resize", resizeHandler);
  resizeHandlerRegistered = true;
};

const removeResizeHandlerIfIdle = () => {
  if (!resizeHandlerRegistered) return;
  if (widthListeners.size > 0 || rowsListeners.size > 0) return;
  const stdout = getStdout();
  if (!stdout) return;
  stdout.off("resize", resizeHandler);
  resizeHandlerRegistered = false;
};

/**
 * Hook to get terminal width and reactively update on resize
 * Uses a shared resize listener to avoid exceeding WriteStream listener limits.
 *
 * The value is re-read here rather than taken from state: state only exists to
 * schedule the re-render (the 'resize' event), and a cached number can outlive
 * the terminal it described.
 */
export function useTerminalWidth(): number {
  const [, setColumns] = useState(trackedColumns);

  useEffect(() => {
    ensureResizeHandler();
    const listener: WidthListener = (value) => {
      setColumns(value);
    };
    widthListeners.add(listener);

    return () => {
      widthListeners.delete(listener);
      removeResizeHandlerIfIdle();
    };
  }, []);

  return getTerminalWidth();
}

/**
 * Hook to get terminal rows and reactively update on resize.
 * Uses the same shared resize listener as useTerminalWidth.
 */
export function useTerminalRows(): number {
  const [, setRows] = useState(trackedRows);

  useEffect(() => {
    ensureResizeHandler();
    const listener: RowsListener = (value) => {
      setRows(value);
    };
    rowsListeners.add(listener);

    return () => {
      rowsListeners.delete(listener);
      removeResizeHandlerIfIdle();
    };
  }, []);

  return getTerminalRows();
}
