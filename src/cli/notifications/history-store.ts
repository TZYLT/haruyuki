import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APP_SUBDIRS,
  type AppHomePathOptions,
  appHomePath,
} from "@/utils/app-paths";

/**
 * The shell's message history: what the toast band told the user, and when.
 *
 * `docs/38` §15.2 rules four things, and they are all here:
 *
 * - **It is kept on disk** — one JSONL file under the harness root, the same
 *   mechanism as the usage ledger (`usage/`), so a restart does not lose what the
 *   user missed while the window was closed;
 * - **it is a ring in memory** of {@link MESSAGE_HISTORY_RING} entries, because the
 *   overlay only ever shows a window of it and the transcript is the place for
 *   anything older;
 * - **it is pruned lazily on read** — {@link MESSAGE_HISTORY_DISK_ENTRIES} entries
 *   or {@link MESSAGE_HISTORY_DAYS} days, whichever comes first. Nothing else ever
 *   deletes lines, so reading is the one moment anything looks at them;
 * - **it counts what was not seen** so the hint row can say `未读 N` and opening
 *   the face clears it.
 *
 * What an entry keeps is the ruling's other half: **type, time and a short text**,
 * nothing more (§15.2 "只存 类型／时间／短文本"). No message bodies, no tool output —
 * this is a log of *notifications*, so it must not become a second transcript with
 * a second retention policy.
 *
 * A module store for the reason the toast band is one (`src/cli/AGENTS.md`'s
 * flicker red line): the writers are event sources outside the component tree and
 * the readers are one face and one hint row.
 */

/** File name under `APP_SUBDIRS.notifications`. */
export const MESSAGE_HISTORY_FILE_NAME = "message-history.jsonl";

/** Entries kept on disk before the oldest are dropped. */
export const MESSAGE_HISTORY_DISK_ENTRIES = 500;

/** Days of history kept on disk. */
export const MESSAGE_HISTORY_DAYS = 30;

/** Entries kept in memory, which is what the face can scroll through. */
export const MESSAGE_HISTORY_RING = 200;

/**
 * What kind of thing was announced.
 *
 * The five are `docs/38` §15.3's rows that reach this module at all: approvals are
 * the approval UI's (bell only) and transient status is the status row's, so
 * neither is a history entry.
 */
export type MessageHistoryKind =
  | "turn"
  | "subagent"
  | "connection"
  | "compaction"
  | "error";

/** One line of the file, and one row of the face. */
export interface MessageHistoryEntry {
  /** Epoch milliseconds; the face prints `HH:MM` from it. */
  at: number;
  kind: MessageHistoryKind;
  /** The short text the toast showed, e.g. `Turn finished`. */
  text: string;
}

export interface MessageHistorySnapshot {
  /** Newest first: the face lists the most recent on its first row. */
  entries: readonly MessageHistoryEntry[];
  /** Held in the ring and not yet seen in the face. */
  unread: number;
}

/** Where the file lives. Resolved per call so `HARUYUKI_HOME` is honoured. */
export function messageHistoryPath(options: AppHomePathOptions = {}): string {
  return join(
    appHomePath([APP_SUBDIRS.notifications], options),
    MESSAGE_HISTORY_FILE_NAME,
  );
}

function isKind(value: unknown): value is MessageHistoryKind {
  return (
    value === "turn" ||
    value === "subagent" ||
    value === "connection" ||
    value === "compaction" ||
    value === "error"
  );
}

function parseEntry(line: string): MessageHistoryEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  if (typeof record.text !== "string") return null;
  if (!isKind(record.kind)) return null;
  return { at: record.at, kind: record.kind, text: record.text };
}

/**
 * Drop what the retention window no longer covers: anything older than the day
 * cutoff, then everything past the entry cap. Pure; no disk access.
 *
 * Entries are chronological on the way in and out, so the cap is "keep the tail".
 */
export function pruneMessageHistory(
  entries: readonly MessageHistoryEntry[],
  now: Date = new Date(),
  days: number = MESSAGE_HISTORY_DAYS,
  cap: number = MESSAGE_HISTORY_DISK_ENTRIES,
): { kept: MessageHistoryEntry[]; dropped: number } {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1_000;
  const kept = entries
    .filter((entry) => entry.at >= cutoff)
    .slice(Math.max(0, entries.length - cap) > 0 ? -cap : 0)
    .slice(-cap);
  return { kept, dropped: entries.length - kept.length };
}

let entries: readonly MessageHistoryEntry[] = [];
let unread = 0;
let loaded = false;
let snapshot: MessageHistorySnapshot = { entries: [], unread: 0 };
const listeners = new Set<() => void>();

function publish(): void {
  // Newest first: the face's first row is the most recent, and the ring stores
  // chronological order because that is what the file holds.
  snapshot = { entries: [...entries].reverse(), unread };
  for (const listener of listeners) listener();
}

export function subscribeToMessageHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current rows (newest first) and the unread count. */
export function getMessageHistorySnapshot(): MessageHistorySnapshot {
  return snapshot;
}

/**
 * Write one entry down: memory first, then the file.
 *
 * The write is fire-and-forget on purpose — a notification must never wait on the
 * disk, and a failed write costs a line of history, not the notification the user
 * is looking at.
 */
export function recordMessageHistory(
  kind: MessageHistoryKind,
  text: string,
  options: { at?: number; path?: string } = {},
): void {
  const trimmed = text.trim();
  if (trimmed === "") return;
  const entry: MessageHistoryEntry = {
    at: options.at ?? Date.now(),
    kind,
    text: trimmed,
  };
  entries = [...entries, entry].slice(-MESSAGE_HISTORY_RING);
  unread += 1;
  publish();
  void appendMessageHistoryEntry(entry, options.path).catch(() => {
    // Keep the in-memory row: the file is a convenience across restarts.
  });
}

async function appendMessageHistoryEntry(
  entry: MessageHistoryEntry,
  path: string = messageHistoryPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

async function rewriteMessageHistory(
  path: string,
  kept: readonly MessageHistoryEntry[],
): Promise<void> {
  const body = kept.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, body, "utf8");
  try {
    await rename(tempPath, path);
  } catch {
    // Windows refuses to rename over an existing file; write it directly.
    await writeFile(path, body, "utf8");
  }
}

export interface ReadMessageHistoryOptions {
  path?: string;
  /** Defaults to now; injectable for retention tests. */
  now?: Date;
  days?: number;
  cap?: number;
  /** Rewrite the file when the prune dropped entries. On by default. */
  prune?: boolean;
}

/**
 * Read the file, oldest first, pruning past the retention window.
 *
 * A missing file, a malformed line or an unwritable home all degrade to "fewer
 * entries", never to an error — the same contract the usage ledger keeps.
 */
export async function readMessageHistory(
  options: ReadMessageHistoryOptions = {},
): Promise<MessageHistoryEntry[]> {
  const path = options.path ?? messageHistoryPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const parsed: MessageHistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (entry) parsed.push(entry);
  }
  if (options.prune === false) return parsed;
  const { kept, dropped } = pruneMessageHistory(
    parsed,
    options.now ?? new Date(),
    options.days ?? MESSAGE_HISTORY_DAYS,
    options.cap ?? MESSAGE_HISTORY_DISK_ENTRIES,
  );
  if (dropped > 0) {
    try {
      await rewriteMessageHistory(path, kept);
    } catch {
      // The in-memory answer is still the pruned one.
    }
  }
  return kept;
}

/**
 * Fill the ring from the file, once.
 *
 * Called by the face when it mounts rather than at import time: a store that reads
 * the disk as a side effect of being imported would do it in every test that
 * touches notifications, and `HARUYUKI_HOME` is not frozen when modules load.
 *
 * Entries recorded before the load (this session's own notifications) are kept and
 * win the de-duplication, because they are the ones the unread count describes.
 */
export async function loadMessageHistory(
  options: ReadMessageHistoryOptions = {},
): Promise<void> {
  if (loaded) return;
  loaded = true;
  const fromDisk = await readMessageHistory(options);
  const seen = new Set(entries.map(entryKey));
  const merged = [...fromDisk.filter((entry) => !seen.has(entryKey(entry)))];
  if (merged.length === 0) return;
  entries = [...merged, ...entries]
    .sort((left, right) => left.at - right.at)
    .slice(-MESSAGE_HISTORY_RING);
  publish();
}

function entryKey(entry: MessageHistoryEntry): string {
  return `${entry.at}|${entry.kind}|${entry.text}`;
}

/** Opening the face clears the count (`docs/38` §15.2). */
export function markMessageHistoryRead(): void {
  if (unread === 0) return;
  unread = 0;
  publish();
}

/** `C` in the face, after its confirmation: the ring and the file both go. */
export function clearMessageHistory(options: { path?: string } = {}): void {
  const path = options.path ?? messageHistoryPath();
  entries = [];
  unread = 0;
  publish();
  void writeFile(path, "", "utf8").catch(() => {
    // Nothing to do: the ring is already empty, and the next append recreates it.
  });
}

/** Test seam. */
export function resetMessageHistoryForTests(): void {
  entries = [];
  unread = 0;
  loaded = false;
  snapshot = { entries: [], unread: 0 };
  listeners.clear();
}
