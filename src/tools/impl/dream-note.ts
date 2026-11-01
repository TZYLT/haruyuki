/**
 * `DreamNote` — leave a note for the agent's next dream run (F-06 §2.4).
 *
 * The user's slash command (`/dream note …`) and this tool write the same
 * per-agent queue; the difference is the recorded author. A normal session's
 * call is author `agent` (the agent is passing a decision forward), and a call
 * from inside a dream run is author `dream` (the run telling its next self what
 * it could not finish). Both are allowed: the design's ruling is that the tool
 * is callable in ordinary sessions and in dream runs, and only the author
 * differs.
 *
 * What this tool is **not**: a memory write. The note is a transient priority
 * for one future run, not content, so it goes to
 * `<harness home>/dream/notes/<agent>.jsonl` (see
 * `agent/dream/dream-notes.ts`) and never into the memory repository,
 * transcripts, or the usage ledger.
 *
 * It is also not an authorization: the note is a hint the model may follow, and
 * the dream run still has to satisfy its own permission and authorization rules
 * before acting on it. The description says so, because a model that mistakes a
 * note for permission is exactly the failure the task tier's rules guard
 * against.
 *
 * Permission-wise the tool only touches agent-owned queue state under the
 * harness home, so `permissions/checker.ts` auto-allows it in ordinary sessions
 * (the same class of argument as `Skill`); a dream run covers it through
 * `DREAM_AUTO_ALLOW_TOOL_NAMES`.
 */

import { getConversationId, getCurrentAgentId } from "@/agent/context";
import {
  appendNote,
  DREAM_NOTE_MAX_QUEUE,
  DREAM_NOTE_MAX_TEXT_CHARS,
  type DreamNote,
  type DreamNoteAuthor,
} from "@/agent/dream/dream-notes";
import { isDreamRun } from "@/permissions/dream-run-guard";
import { getRuntimeContext } from "@/runtime-context";

const TOOL_NAME = "DreamNote";

export interface DreamNoteArgs {
  text?: unknown;
  agent_id?: unknown;
}

export interface DreamNoteDeps {
  /** Overrides the ambient agent resolution; tests pin it. */
  agentId?: string;
  /** Overrides the runtime-context conversation used for `source`. */
  conversationId?: string | null;
  /** Overrides the dream-run detection; tests pin it. */
  dreamRun?: boolean;
  /** Epoch ms; defaults to the clock. Pinned by tests. */
  now?: number;
  /** Injection seam for the queue writer; production uses `appendNote`. */
  append?: typeof appendNote;
}

/**
 * The tool result. `content` + `status` is the tool-runner contract; `ok` +
 * `note_id` are the design's promised payload for programmatic consumers.
 */
export interface DreamNoteToolResult {
  content: string;
  status: "success" | "error";
  ok: boolean;
  note_id: string | null;
}

function error(content: string): DreamNoteToolResult {
  return { content, status: "error", ok: false, note_id: null };
}

function resolveAgentId(
  args: DreamNoteArgs,
  deps: DreamNoteDeps,
): string | null {
  if (args.agent_id !== undefined) {
    if (typeof args.agent_id !== "string" || args.agent_id.trim() === "") {
      return null;
    }
    return args.agent_id.trim();
  }
  if (deps.agentId) return deps.agentId;
  const runtimeAgentId = getRuntimeContext()?.agentId;
  if (typeof runtimeAgentId === "string" && runtimeAgentId.length > 0) {
    return runtimeAgentId;
  }
  try {
    return getCurrentAgentId();
  } catch {
    return null;
  }
}

function resolveConversationId(deps: DreamNoteDeps): string | null {
  if (deps.conversationId !== undefined) return deps.conversationId;
  const runtimeConversationId = getRuntimeContext()?.conversationId;
  if (
    typeof runtimeConversationId === "string" &&
    runtimeConversationId.length > 0
  ) {
    return runtimeConversationId;
  }
  return getConversationId();
}

/**
 * Append one note and tell the model what it did.
 *
 * A refused queue (full, empty text, over the length limit) is reported with
 * the queue's own error text — the limits are refusals by design, so the model
 * must see *why* nothing was saved rather than a generic failure.
 */
export async function dream_note(
  args: DreamNoteArgs,
  deps: DreamNoteDeps = {},
): Promise<DreamNoteToolResult> {
  const agentId = resolveAgentId(args, deps);
  if (agentId === null) {
    return error(
      `${TOOL_NAME}: no agent is available in this execution context, so the note has no queue to go to. Pass "agent_id" explicitly or call ${TOOL_NAME} inside an agent turn.`,
    );
  }

  if (typeof args.text !== "string") {
    return error(
      `${TOOL_NAME}: "text" is required — one short note (1–${DREAM_NOTE_MAX_TEXT_CHARS} characters) for the next dream run.`,
    );
  }
  const text = args.text.trim();
  if (text.length === 0) {
    return error(`${TOOL_NAME}: "text" must not be empty.`);
  }
  if (text.length > DREAM_NOTE_MAX_TEXT_CHARS) {
    return error(
      `${TOOL_NAME}: "text" is ${text.length} characters; the limit is ${DREAM_NOTE_MAX_TEXT_CHARS}. Nothing was saved — shorten it or split it into several notes.`,
    );
  }

  const conversationId = resolveConversationId(deps);
  const dreamRun = deps.dreamRun ?? isDreamRun();
  const author: DreamNoteAuthor = dreamRun ? "dream" : "agent";
  const append = deps.append ?? appendNote;
  const appended = await append(agentId, {
    text,
    author,
    ...(conversationId ? { source: { conversationId } } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (!appended.ok) {
    return error(`${TOOL_NAME}: ${appended.error}`);
  }

  const note: DreamNote = appended.note;
  const authorWords =
    author === "dream"
      ? "this run left it for the next one"
      : "the agent left it for the next dream run";
  return {
    content: [
      `${TOOL_NAME}: saved ${note.id} for agent ${agentId} (${authorWords}).`,
      "The next dream run for this agent reads it before its ordinary tidy work, and answers it in its report as applied / not-applicable / needs-authorization.",
      `Queue size: at most ${DREAM_NOTE_MAX_QUEUE} notes; remove one with /dream note remove <id> if the queue is full.`,
      "This is not a memory write and it does not authorize anything — the run still needs a real authorization entry to act on it.",
    ].join("\n"),
    status: "success",
    ok: true,
    note_id: note.id,
  };
}
