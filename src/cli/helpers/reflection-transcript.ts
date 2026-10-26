import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import { getTranscriptRoot } from "@/utils/transcript-paths";
import type { Line } from "./accumulator";
import { safeJsonParseOr } from "./safe-json-parse";

/**
 * F-03 dropped the step-based counters together with the payload pipeline. The
 * schema name changes so an old `state.json` is recognized and reset instead of
 * being re-interpreted: requirement Q-20 says the new counters start at 0.
 */
export const REFLECTION_STATE_SCHEMA_VERSION = "v4_user_messages" as const;

export interface ReflectionTranscriptState {
  schema_version: typeof REFLECTION_STATE_SCHEMA_VERSION;
  /** User messages submitted into the model context for this conversation. */
  total_user_messages: number;
  /** `total_user_messages` already reflected by a *finished* run. */
  reflected_user_messages: number;
  /** Derived: `total_user_messages - reflected_user_messages`. */
  messages_since_last_successful_reflection: number;
  /**
   * Set by {@link recordReflectionUserMessage} and consumed by the post-turn
   * check. This is what keeps an automated turn (a task-notification turn, a
   * cron prompt) from re-evaluating the user-message trigger: no new user
   * message, no flag, no launch.
   */
  pending_user_message_trigger?: boolean;
  /**
   * `total_user_messages` captured when a run was launched. It becomes
   * `reflected_user_messages` once the run is no longer active — reflected means
   * finished, not merely started.
   */
  pending_reflected_user_messages?: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

type StoredReflectionTranscriptState = {
  schema_version?: unknown;
  total_user_messages?: unknown;
  reflected_user_messages?: unknown;
  pending_user_message_trigger?: unknown;
  pending_reflected_user_messages?: unknown;
  last_reflection_started_at?: unknown;
  last_reflection_succeeded_at?: unknown;
};

type TranscriptEntry =
  | {
      kind: "user" | "assistant" | "reasoning" | "error";
      text: string;
      captured_at: string;
      source_line_id?: string; // local transcript row id; may be synthetic
      source_message_id?: string; // canonical backend message.id when known
    }
  | {
      kind: "tool_call";
      name?: string;
      argsText?: string;
      resultText?: string;
      resultOk?: boolean;
      captured_at: string;
      source_line_id?: string; // local transcript row id; may be synthetic
      source_message_id?: string; // canonical backend message.id when known
    };

export interface ReflectionTranscriptPaths {
  /** ~/.haruyuki/transcripts/{agentId}/{conversationId}/ */
  rootDir: string;
  transcriptPath: string;
  statePath: string;
}

function sanitizePathSegment(segment: string): string {
  const sanitized = segment.replace(/[^a-zA-Z0-9._-]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "unknown";
}

const stateMutexes = new Map<string, Promise<unknown>>();

function withStateLock<T>(
  agentId: string,
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${agentId}::${conversationId}`;
  const previous = stateMutexes.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const paths = getReflectionTranscriptPaths(agentId, conversationId);
      await mkdir(paths.rootDir, { recursive: true });
      return withFileLock(`${paths.statePath}.lock`, fn);
    });
  const tail = next.catch(() => undefined);
  stateMutexes.set(key, tail);
  tail.finally(() => {
    if (stateMutexes.get(key) === tail) {
      stateMutexes.delete(key);
    }
  });
  return next;
}

function lineToTranscriptEntry(
  line: Line,
  capturedAt: string,
): TranscriptEntry | null {
  switch (line.kind) {
    case "user":
      return {
        kind: "user",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
        source_message_id: line.messageId,
      };
    case "assistant":
      return {
        kind: "assistant",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
        source_message_id: line.messageId,
      };
    case "reasoning":
      return {
        kind: "reasoning",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
        source_message_id: line.messageId,
      };
    case "error":
      return {
        kind: "error",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
      };
    case "tool_call":
      return {
        kind: "tool_call",
        name: line.name,
        argsText: line.argsText,
        resultText: line.resultText,
        resultOk: line.resultOk,
        captured_at: capturedAt,
        source_line_id: line.id,
      };
    default:
      return null;
  }
}

async function ensurePaths(paths: ReflectionTranscriptPaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await writeFile(paths.transcriptPath, "", { encoding: "utf-8", flag: "a" });
}

async function readTranscriptLines(
  paths: ReflectionTranscriptPaths,
): Promise<string[]> {
  try {
    const raw = await readFile(paths.transcriptPath, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

type ParsedTranscriptRow = {
  entry: TranscriptEntry;
  lineIndex: number;
};

function parseTranscriptRows(lines: string[]): ParsedTranscriptRow[] {
  return lines
    .map((line, lineIndex) => {
      const entry = safeJsonParseOr<TranscriptEntry | null>(line, null);
      return entry ? { entry, lineIndex } : null;
    })
    .filter((row): row is ParsedTranscriptRow => row !== null);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : fallback;
}

function zeroReflectionState(): ReflectionTranscriptState {
  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_user_messages: 0,
    reflected_user_messages: 0,
    messages_since_last_successful_reflection: 0,
  };
}

function normalizeV4State(
  parsed: StoredReflectionTranscriptState,
): ReflectionTranscriptState {
  const totalUserMessages = normalizeNonNegativeInteger(
    parsed.total_user_messages,
  );
  const reflectedUserMessages = Math.min(
    normalizeNonNegativeInteger(parsed.reflected_user_messages),
    totalUserMessages,
  );
  const pendingReflected = normalizeNonNegativeInteger(
    parsed.pending_reflected_user_messages,
    Number.NaN,
  );
  const state: ReflectionTranscriptState = {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_user_messages: totalUserMessages,
    reflected_user_messages: reflectedUserMessages,
    messages_since_last_successful_reflection:
      totalUserMessages - reflectedUserMessages,
    last_reflection_started_at: normalizeString(
      parsed.last_reflection_started_at,
    ),
    last_reflection_succeeded_at: normalizeString(
      parsed.last_reflection_succeeded_at,
    ),
  };
  if (parsed.pending_user_message_trigger === true) {
    state.pending_user_message_trigger = true;
  }
  if (Number.isFinite(pendingReflected)) {
    state.pending_reflected_user_messages = Math.min(
      Math.max(0, pendingReflected),
      totalUserMessages,
    );
  }
  return state;
}

async function readState(
  paths: ReflectionTranscriptPaths,
): Promise<ReflectionTranscriptState> {
  let raw: string | null = null;
  try {
    raw = await readFile(paths.statePath, "utf-8");
  } catch {
    raw = null;
  }
  const parsed = raw
    ? safeJsonParseOr<StoredReflectionTranscriptState | null>(raw, null)
    : null;

  const schemaVersion =
    parsed && typeof parsed.schema_version === "string"
      ? parsed.schema_version
      : undefined;
  if (schemaVersion === REFLECTION_STATE_SCHEMA_VERSION) {
    const state = normalizeV4State(parsed as StoredReflectionTranscriptState);
    if (JSON.stringify(state) !== JSON.stringify(parsed)) {
      await writeState(paths, state);
    }
    return state;
  }

  // Requirement Q-20: an old schema's counters are discarded, and the new
  // counters start at 0. The transcript itself is left untouched.
  const state = zeroReflectionState();
  await writeState(paths, state);
  return state;
}

async function writeState(
  paths: ReflectionTranscriptPaths,
  state: ReflectionTranscriptState,
): Promise<void> {
  state.messages_since_last_successful_reflection = Math.max(
    0,
    state.total_user_messages - state.reflected_user_messages,
  );
  await writeFile(
    paths.statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

export function getReflectionTranscriptPaths(
  agentId: string,
  conversationId: string,
): ReflectionTranscriptPaths {
  const rootDir = join(
    getTranscriptRoot(),
    sanitizePathSegment(agentId),
    sanitizePathSegment(conversationId),
  );
  return {
    rootDir,
    transcriptPath: join(rootDir, "transcript.jsonl"),
    statePath: join(rootDir, "state.json"),
  };
}

export async function appendTranscriptDeltaJsonl(
  agentId: string,
  conversationId: string,
  lines: Line[],
): Promise<number> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);

    const capturedAt = new Date().toISOString();
    const entries = lines
      .map((line) => lineToTranscriptEntry(line, capturedAt))
      .filter((entry): entry is TranscriptEntry => entry !== null);
    if (entries.length === 0) {
      return 0;
    }

    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await appendFile(paths.transcriptPath, `${payload}\n`, "utf-8");
    return entries.length;
  });
}

/**
 * A transcript entry supplied by an external source adapter (e.g. converted
 * OpenHands events). Mirrors the on-disk TranscriptEntry shape, but
 * captured_at may be omitted (stamped at append time).
 */
export type ExternalTranscriptEntry =
  | {
      kind: "user" | "assistant" | "reasoning" | "error";
      text: string;
      captured_at?: string;
      source_message_id?: string;
    }
  | {
      kind: "tool_call";
      name?: string;
      argsText?: string;
      resultText?: string;
      resultOk?: boolean;
      captured_at?: string;
      source_message_id?: string;
    };

function externalToTranscriptEntry(
  entry: ExternalTranscriptEntry,
  fallbackCapturedAt: string,
): TranscriptEntry | null {
  const capturedAt = normalizeString(entry.captured_at) ?? fallbackCapturedAt;
  if (entry.kind === "tool_call") {
    return {
      kind: "tool_call",
      name: entry.name,
      argsText: entry.argsText,
      resultText: entry.resultText,
      resultOk: entry.resultOk,
      captured_at: capturedAt,
      source_message_id: entry.source_message_id,
    };
  }
  if (typeof entry.text !== "string" || entry.text.length === 0) {
    return null;
  }
  return {
    kind: entry.kind,
    text: entry.text,
    captured_at: capturedAt,
    source_message_id: entry.source_message_id,
  };
}

/**
 * Append externally-sourced transcript entries (already in transcript shape).
 * Entries whose source_message_id already exists in the transcript are skipped,
 * so repeated ingestion of an overlapping event window is idempotent.
 */
export async function appendExternalTranscriptEntries(
  agentId: string,
  conversationId: string,
  entries: ExternalTranscriptEntry[],
): Promise<{ appended: number; skipped: number }> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);

    const existingIds = new Set(
      parseTranscriptRows(await readTranscriptLines(paths))
        .map((row) => row.entry.source_message_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const fallbackCapturedAt = new Date().toISOString();
    const fresh: TranscriptEntry[] = [];
    let skipped = 0;
    for (const external of entries) {
      const entry = externalToTranscriptEntry(external, fallbackCapturedAt);
      if (!entry) {
        skipped += 1;
        continue;
      }
      const id = entry.source_message_id;
      if (id && existingIds.has(id)) {
        skipped += 1;
        continue;
      }
      if (id) {
        existingIds.add(id);
      }
      fresh.push(entry);
    }
    if (fresh.length === 0) {
      return { appended: 0, skipped };
    }

    const payload = fresh.map((entry) => JSON.stringify(entry)).join("\n");
    await appendFile(paths.transcriptPath, `${payload}\n`, "utf-8");
    return { appended: fresh.length, skipped };
  });
}

export async function getReflectionTranscriptState(
  agentId: string,
  conversationId: string,
): Promise<ReflectionTranscriptState> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);
    return readState(paths);
  });
}

/**
 * Count user messages submitted into the model context for this conversation.
 *
 * F-03 §5.5.2: only real user submissions count — reminders, tool results,
 * compaction injections and unsubmitted slash commands do not. The count is
 * per conversation and is the only trigger input the message-counter switch
 * reads. Callers live in the CLI layer (TUI submit, listener inbound, headless
 * input); `appendTurnInput` deliberately does not count, because reminder
 * injection would inflate it and the backend cannot import the CLI.
 *
 * Every counted message also arms {@link ReflectionTranscriptState.pending_user_message_trigger}.
 * That flag — not the counter — is what the post-turn check consumes, so an
 * automated turn (a task-notification or cron turn) can never re-evaluate the
 * user-message trigger.
 */
export async function recordReflectionUserMessage(
  agentId: string,
  conversationId: string,
  count = 1,
): Promise<ReflectionTranscriptState> {
  const increment =
    Number.isInteger(count) && count > 0 ? Math.trunc(count) : 0;
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);
    const state = await readState(paths);
    if (increment > 0) {
      state.total_user_messages += increment;
      state.pending_user_message_trigger = true;
      await writeState(paths, state);
    }
    return state;
  });
}

/**
 * Take the "a user message arrived" arm. The post-turn check calls this once
 * per turn; a notification turn finds no flag and does no trigger work.
 */
export async function consumeReflectionUserMessageTrigger(
  agentId: string,
  conversationId: string,
): Promise<boolean> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);
    const state = await readState(paths);
    if (state.pending_user_message_trigger !== true) {
      return false;
    }
    state.pending_user_message_trigger = false;
    await writeState(paths, state);
    return true;
  });
}

/**
 * Stage the launch: remember which user messages the running reflection is
 * covering. `reflected_user_messages` itself only advances once the run has
 * finished ({@link applyPendingReflectionUserMessages}), because a message is
 * not reflected merely because a run started.
 *
 * Called when a `user-messages` reflection actually launches; a skipped launch
 * stages nothing, so the next user message re-arms the trigger.
 */
export async function markReflectionUserMessagesReflected(
  agentId: string,
  conversationId: string,
): Promise<ReflectionTranscriptState> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);
    const state = await readState(paths);
    state.pending_reflected_user_messages = state.total_user_messages;
    state.last_reflection_started_at = new Date().toISOString();
    await writeState(paths, state);
    return state;
  });
}

/**
 * Finish the staged launch: the run is no longer active, so the messages it was
 * covering are now reflected. Idempotent — a no-op when nothing is staged.
 */
export async function applyPendingReflectionUserMessages(
  agentId: string,
  conversationId: string,
): Promise<ReflectionTranscriptState> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);
    const state = await readState(paths);
    const pending = state.pending_reflected_user_messages;
    if (pending === undefined) {
      return state;
    }
    state.reflected_user_messages = Math.min(
      pending,
      state.total_user_messages,
    );
    state.pending_reflected_user_messages = undefined;
    state.last_reflection_succeeded_at = new Date().toISOString();
    await writeState(paths, state);
    return state;
  });
}
