import { useEffect, useState } from "react";

const getStdout = () => {
  if (typeof process === "undefined") return undefined;
  const stdout = process.stdout as NodeJS.WriteStream | undefined;
  return stdout && typeof stdout.on === "function" ? stdout : undefined;
};

/**
 * Reads the size from the stream, preferring the API that *queries* the console.
 *
 * `stdout.columns`/`rows` are cached properties: Node refreshes them when it
 * notices a change, which on a Windows console it only does on some hosts. A
 * stale `rows` is invisible until something depends on it — and the full-screen
 * shell does, because its viewport height is `rows - chrome`: a stale 24 leaves
 * a tall terminal half empty and never grows the transcript. `getWindowSize()`
 * asks the terminal every time, so re-reading it per render self-corrects.
 */
const querySize = (): { columns: number; rows: number } => {
  const stdout = getStdout() as
    | (NodeJS.WriteStream & { getWindowSize?: () => unknown })
    | undefined;
  if (!stdout) return { columns: 80, rows: 24 };
  try {
    // Node's `tty.WriteStream.getWindowSize()` answers `[columns, rows]`.
    const queried = stdout.getWindowSize?.();
    if (Array.isArray(queried)) {
      const [columns, rows] = queried as [number, number];
      if (columns && rows) return { columns, rows };
    } else if (queried && typeof queried === "object") {
      const { columns, rows } = queried as { columns?: number; rows?: number };
      if (columns && rows) return { columns, rows };
    }
  } catch {
    // Not a TTY after all; fall through to the cached properties.
  }
  return { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
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
