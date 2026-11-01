/**
 * Dream notes — the queue of "pay attention to this next time" messages for the
 * dream feature (F-06 §2.2–§2.7).
 *
 * Three entrances write to the same per-agent queue (the `/dream note…` slash
 * command, the main agent's `DreamNote` tool, and an app-server command family),
 * and one consumer reads it: a dream run claims the queue just before its first
 * turn, puts it into the run's seed, and settles it from the report at the end
 * of the run.
 *
 * Two properties are load-bearing.
 *
 * - **It lives in the harness home, never in the memory repository.** The note
 *   is a hint for the *machine*, not memory content: it must not enter the
 *   agent's memory git history, the usage ledger, or a transcript. The path is
 *   `<harness home>/dream/notes/<agent-segment>.jsonl` through `appHomePath`, so
 *   `HARUYUKI_HOME` and the project/home split keep working — a literal
 *   `.haruyuki` here would drift from every other resolver.
 * - **Overflow is an error, not a silent drop.** The queue is capped at
 *   {@link DREAM_NOTE_MAX_QUEUE} notes and one note at
 *   {@link DREAM_NOTE_MAX_TEXT_CHARS} characters. The design's rule is explicit:
 *   reject with a reason, never truncate. A user who wrote a long note must be
 *   told it was not saved, because a dropped reminder is worse than none.
 *
 * Reads are tolerant (the same philosophy as the usage ledger): a corrupt line
 * is skipped with a debug line instead of failing the queue. Appends are single
 * `appendFile` writes so two writers do not interleave partial lines; the
 * rewrite paths (claim / consume / remove / clear) go through temp + rename.
 *
 * Layer: `agent/` — it owns the dream domain and imports only `utils/`.
 */

import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { appHomePath } from "@/utils/app-paths";
import { debugWarn } from "@/utils/debug";

/** Longest accepted note text, measured after trimming; longer is refused. */
export const DREAM_NOTE_MAX_TEXT_CHARS = 2000;

/** How many notes one agent may queue; an append past this is refused. */
export const DREAM_NOTE_MAX_QUEUE = 50;

/** Id prefix every note carries (`note-<8 hex>`). */
export const DREAM_NOTE_ID_PREFIX = "note-";

/** Who left the note. `dream` is a run leaving a note for its next self. */
export type DreamNoteAuthor = "user" | "agent" | "dream";

/**
 * How a run answered a note in its report.
 *
 * `applied` means the run acted on it and the note is consumed; the other two
 * keep the note for a later run, with the attempt recorded so a note that keeps
 * coming back is visible instead of silently ignored.
 */
export type DreamNoteOutcome =
  | "applied"
  | "not-applicable"
  | "needs-authorization";

const DREAM_NOTE_OUTCOMES: readonly DreamNoteOutcome[] = [
  "applied",
  "not-applicable",
  "needs-authorization",
];

/** Where a note came from. Only a conversation id today; kept open on purpose. */
export interface DreamNoteSource {
  conversationId?: string;
}

/** One line of the JSONL queue, and one item the run's seed renders. */
export interface DreamNote {
  version: 1;
  id: string;
  /** Epoch milliseconds. */
  createdAt: number;
  author: DreamNoteAuthor;
  text: string;
  source: DreamNoteSource;
  /** The run that has read this note into its seed (not a consumption). */
  claimedByRunId?: string;
  claimedAt?: number;
  /** The last run that answered the note and kept it. */
  lastAttemptRunId?: string;
  lastOutcome?: DreamNoteOutcome;
}

export interface AppendDreamNoteInput {
  text: string;
  author: DreamNoteAuthor;
  source?: DreamNoteSource;
  /** Epoch ms; defaults to the clock. Pinned by tests. */
  now?: number;
  /** Explicit id; defaults to a fresh `note-<8hex>`. Pinned by tests. */
  id?: string;
}

export type AppendDreamNoteResult =
  | { ok: true; note: DreamNote }
  | { ok: false; error: string };

/** What {@link consumeNotes} did, so the run can record it in its metadata. */
export interface ConsumeDreamNotesResult {
  /** Ids deleted because the report answered `applied`. */
  consumed: string[];
  /** Ids kept with `lastAttemptRunId` / `lastOutcome` recorded. */
  kept: string[];
}

/**
 * The report's answers, keyed by note id. A `Map` is accepted as well so the
 * run side can build it incrementally without converting to an object.
 */
export type DreamNoteOutcomeMap =
  | Readonly<Record<string, DreamNoteOutcome>>
  | ReadonlyMap<string, DreamNoteOutcome>;

/**
 * One file-system-safe path segment for the agent id.
 *
 * Agent ids are usually opaque strings, but nothing promises that, and a slash
 * or a colon in one would either create directories or fail on Windows. The
 * `.jsonl` suffix is always appended, so even a `..` id cannot escape the
 * notes directory.
 */
function agentFileSegment(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "unknown-agent";
}

/** `<harness home>/dream/notes/<agent>.jsonl` — resolved per call. */
export function getDreamNotesPath(agentId: string): string {
  return appHomePath(["dream", "notes", `${agentFileSegment(agentId)}.jsonl`]);
}

/** A fresh note id in the queue's `note-<8hex>` shape. */
export function createDreamNoteId(): string {
  return `${DREAM_NOTE_ID_PREFIX}${randomBytes(4).toString("hex")}`;
}

function isDreamNoteAuthor(value: unknown): value is DreamNoteAuthor {
  return value === "user" || value === "agent" || value === "dream";
}

function isDreamNoteOutcome(value: unknown): value is DreamNoteOutcome {
  return (
    typeof value === "string" &&
    (DREAM_NOTE_OUTCOMES as readonly string[]).includes(value)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse one line. `null` means "corrupt, skip it" — the queue must not lose its
 * other entries because one line was written by an older build or truncated.
 */
function parseNoteLine(line: string): DreamNote | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  const id = optionalString(record.id);
  if (id === undefined) return null;
  if (!isFiniteNumber(record.createdAt)) return null;
  if (!isDreamNoteAuthor(record.author)) return null;
  if (typeof record.text !== "string" || record.text.trim().length === 0) {
    return null;
  }
  const sourceRecord =
    typeof record.source === "object" && record.source !== null
      ? (record.source as Record<string, unknown>)
      : {};
  const note: DreamNote = {
    version: 1,
    id,
    createdAt: record.createdAt,
    author: record.author,
    text: record.text,
    source: {},
  };
  const conversationId = optionalString(sourceRecord.conversationId);
  if (conversationId !== undefined) note.source.conversationId = conversationId;
  const claimedByRunId = optionalString(record.claimedByRunId);
  if (claimedByRunId !== undefined) note.claimedByRunId = claimedByRunId;
  if (isFiniteNumber(record.claimedAt)) note.claimedAt = record.claimedAt;
  const lastAttemptRunId = optionalString(record.lastAttemptRunId);
  if (lastAttemptRunId !== undefined) note.lastAttemptRunId = lastAttemptRunId;
  if (isDreamNoteOutcome(record.lastOutcome)) {
    note.lastOutcome = record.lastOutcome;
  }
  return note;
}

/**
 * Read the queue in file order (oldest first), skipping corrupt lines.
 *
 * A missing file is an empty queue. Any other read error is logged and treated
 * as empty: a note queue that cannot be read must not take a slash command or a
 * dream run down with it.
 */
async function readNoteLines(path: string): Promise<{
  notes: DreamNote[];
  damaged: number;
  existed: boolean;
}> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      debugWarn("dream-notes", `could not read ${path}: ${String(error)}`);
    }
    return { notes: [], damaged: 0, existed: false };
  }
  const notes: DreamNote[] = [];
  let damaged = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const note = parseNoteLine(trimmed);
    if (note === null) {
      damaged += 1;
      continue;
    }
    notes.push(note);
  }
  if (damaged > 0) {
    debugWarn("dream-notes", `skipped ${damaged} corrupt line(s) in ${path}`);
  }
  return { notes, damaged, existed: true };
}

function serializeNotes(notes: readonly DreamNote[]): string {
  if (notes.length === 0) return "";
  return `${notes.map((note) => JSON.stringify(note)).join("\n")}\n`;
}

/**
 * Replace the whole file with `notes`, through a temp file + rename.
 *
 * Windows refuses a rename over an existing file in some states, so the direct
 * write is the documented fallback (the usage ledger does the same). The
 * fallback is still better than in-place truncation: a crash leaves either the
 * old file or a complete one.
 */
async function writeNoteLines(
  path: string,
  notes: readonly DreamNote[],
): Promise<void> {
  const body = serializeNotes(notes);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, body, "utf8");
  try {
    await rename(tempPath, path);
  } catch {
    await writeFile(path, body, "utf8");
  }
}

/** The agent's notes, oldest first. Corrupt lines and read failures are skipped. */
export async function listNotes(agentId: string): Promise<DreamNote[]> {
  const { notes } = await readNoteLines(getDreamNotesPath(agentId));
  return notes;
}

/**
 * Append one note.
 *
 * Refused (with the reason, never truncated) when the text is empty, longer
 * than {@link DREAM_NOTE_MAX_TEXT_CHARS} after trimming, or when the queue
 * already holds {@link DREAM_NOTE_MAX_QUEUE} notes. The cap is checked before
 * the append; two processes appending at the same instant can overflow it by at
 * most one note, which the next read surfaces instead of hiding.
 */
export async function appendNote(
  agentId: string,
  input: AppendDreamNoteInput,
): Promise<AppendDreamNoteResult> {
  const text = input.text.trim();
  if (text.length === 0) {
    return {
      ok: false,
      error: `A dream note needs 1–${DREAM_NOTE_MAX_TEXT_CHARS} characters of text; the note was empty.`,
    };
  }
  if (text.length > DREAM_NOTE_MAX_TEXT_CHARS) {
    return {
      ok: false,
      error: `The dream note is ${text.length} characters; the limit is ${DREAM_NOTE_MAX_TEXT_CHARS}. Nothing was saved — shorten it or split it into several notes.`,
    };
  }

  const path = getDreamNotesPath(agentId);
  const { notes } = await readNoteLines(path);
  if (notes.length >= DREAM_NOTE_MAX_QUEUE) {
    return {
      ok: false,
      error: `The dream note queue is full (${DREAM_NOTE_MAX_QUEUE} notes), so nothing was added. Remove a note with /dream note remove <id>, or let the next dream run consume one.`,
    };
  }

  const note: DreamNote = {
    version: 1,
    id: input.id ?? createDreamNoteId(),
    createdAt: input.now ?? Date.now(),
    author: input.author,
    text,
    source: input.source?.conversationId
      ? { conversationId: input.source.conversationId }
      : {},
  };

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(note)}\n`, "utf8");
  } catch (error) {
    debugWarn("dream-notes", `could not append to ${path}: ${String(error)}`);
    return {
      ok: false,
      error: `The dream note could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true, note };
}

/** Remove one note by id. `false` when no note has that id (or the write failed). */
export async function removeNote(
  agentId: string,
  id: string,
): Promise<boolean> {
  const path = getDreamNotesPath(agentId);
  const { notes } = await readNoteLines(path);
  const remaining = notes.filter((note) => note.id !== id);
  if (remaining.length === notes.length) return false;
  try {
    await writeNoteLines(path, remaining);
    return true;
  } catch (error) {
    debugWarn("dream-notes", `could not rewrite ${path}: ${String(error)}`);
    return false;
  }
}

/**
 * Drop the whole queue and report how many notes were removed.
 *
 * Corrupt lines are removed too (the file is rewritten from the parsed notes);
 * a missing file is a no-op rather than creating an empty one.
 */
export async function clearNotes(agentId: string): Promise<number> {
  const path = getDreamNotesPath(agentId);
  const { notes, existed } = await readNoteLines(path);
  if (!existed) return 0;
  try {
    await writeNoteLines(path, []);
  } catch (error) {
    debugWarn("dream-notes", `could not clear ${path}: ${String(error)}`);
    return 0;
  }
  return notes.length;
}

/**
 * Mark every queued note as read by this run and return them, oldest first.
 *
 * Claiming is not consumption: the notes stay in the queue in case the run
 * fails. The returned list is what the run's seed renders — when the claim
 * cannot be persisted the notes are still returned, because showing the run its
 * pending notes matters more than the bookkeeping marker.
 */
export async function claimNotes(
  agentId: string,
  runId: string,
  now: number = Date.now(),
): Promise<DreamNote[]> {
  const path = getDreamNotesPath(agentId);
  const { notes } = await readNoteLines(path);
  if (notes.length === 0) return [];
  const claimed = notes.map((note) => ({
    ...note,
    claimedByRunId: runId,
    claimedAt: now,
  }));
  try {
    await writeNoteLines(path, claimed);
  } catch (error) {
    debugWarn("dream-notes", `could not claim ${path}: ${String(error)}`);
  }
  return claimed;
}

function outcomeFor(
  outcomes: DreamNoteOutcomeMap,
  id: string,
): DreamNoteOutcome | undefined {
  if (outcomes instanceof Map) return outcomes.get(id);
  const record = outcomes as Readonly<Record<string, DreamNoteOutcome>>;
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

/**
 * Settle the queue against a finished run's report.
 *
 * Only `applied` notes are deleted. `not-applicable` and
 * `needs-authorization` are kept and stamped with `lastAttemptRunId` /
 * `lastOutcome` so the next run can see the note has already been tried. A note
 * with no answer in the report (including one appended while the run was
 * executing) is left exactly as it was — the conservative rule: an unparsed
 * answer looks like no answer, and no answer must never delete a note.
 *
 * The caller decides *when* this is legal: only a `succeeded` /
 * `budget_exhausted` run settles the queue; a failed, timed-out, or cancelled
 * run keeps everything.
 */
export async function consumeNotes(
  agentId: string,
  runId: string,
  outcomes: DreamNoteOutcomeMap,
): Promise<ConsumeDreamNotesResult> {
  const path = getDreamNotesPath(agentId);
  const { notes } = await readNoteLines(path);
  const consumed: string[] = [];
  const kept: string[] = [];
  if (notes.length === 0) return { consumed, kept };

  const remaining: DreamNote[] = [];
  for (const note of notes) {
    const outcome = outcomeFor(outcomes, note.id);
    if (outcome === undefined || !isDreamNoteOutcome(outcome)) {
      remaining.push(note);
      continue;
    }
    if (outcome === "applied") {
      consumed.push(note.id);
      continue;
    }
    kept.push(note.id);
    const keptNote: DreamNote = {
      version: 1,
      id: note.id,
      createdAt: note.createdAt,
      author: note.author,
      text: note.text,
      source: note.source,
      lastAttemptRunId: runId,
      lastOutcome: outcome,
    };
    remaining.push(keptNote);
  }

  if (consumed.length > 0 || kept.length > 0) {
    try {
      await writeNoteLines(path, remaining);
    } catch (error) {
      debugWarn("dream-notes", `could not rewrite ${path}: ${String(error)}`);
    }
  }
  return { consumed, kept };
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `MM-DD HH:MM` in UTC, the queue's compact stamp (no locale surprises). */
function noteStamp(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(5, 16).replace("T", " ");
}

/**
 * The run seed's `## Pending notes` block (English: the manual is English, and
 * this block is model-facing).
 *
 * Returns an empty string for an empty queue — the seed renders nothing rather
 * than an empty section, and a run without notes should not spend prompt space
 * on a heading that says "none". The three response words are the contract the
 * report parser (and {@link consumeNotes}) depends on; they must appear here
 * verbatim.
 */
export function renderNotesSection(notes: readonly DreamNote[]): string {
  if (notes.length === 0) return "";
  const lines: string[] = [
    "## Pending notes",
    "",
    "The user, the main agent, or an earlier run left these for this run. They take priority over ordinary tidy plan items, but they never bypass the permission and authorization rules.",
  ];
  for (const note of notes) {
    lines.push(
      `- ${note.id} (${note.author}, ${noteStamp(note.createdAt)}): ${singleLine(note.text)}`,
    );
  }
  lines.push(
    "",
    "Answer every note in the report's `## Notes 回应` section with exactly one of: `applied` (done in this run), `not-applicable` (say why), `needs-authorization` (the user must authorize it; the note is kept for a later run).",
  );
  return lines.join("\n");
}
