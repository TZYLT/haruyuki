/**
 * `DreamDone` — the dream run's "I am finishing" call (F-06 R-5.4.3,
 * route §2.3 M3).
 *
 * A dream run is a headless child process, so "the model is done" cannot be
 * inferred from the conversation: the model may end a turn because it finished,
 * because it ran out of budget, or because it was interrupted mid-work. This
 * tool is the explicit signal. It records **what is left** in the run record's
 * `handoff` field, which the finishing step includes in the report
 * (`maintenance/dream-report.md`) — a later run may read that report for
 * context, but no handoff message is delivered to it automatically — and tells
 * the model to stop calling tools and write the report body as its final
 * message. Calling it ends the whole run, so the per-tier turns must not call it
 * just because one tier's work is done.
 *
 * It deliberately does not commit memory and does not change the run status:
 * the agent's own `MemoryCommit` calls are the durable writes, and the run
 * controller decides the terminal status (`succeeded` / `budget_exhausted` /
 * `cancelled`). Passing the status word through this tool would let the run
 * declare its own success, which the requirement forbids (`R-5.8.7`).
 */
import { getConversationId } from "@/agent/context";
import { writeDreamRunMetadata } from "@/agent/dream-run-metadata";
import { getBackend } from "@/backend";
import { getRuntimeContext } from "@/runtime-context";
import {
  type DreamRunMetadata,
  readDreamRunMetadata,
} from "@/types/dream-run-metadata";
import { isRecord } from "@/utils/type-guards";

const TOOL_NAME = "DreamDone";

/** Longest accepted handoff text; the report carries the detail. */
export const DREAM_DONE_MAX_HANDOFF_CHARS = 4_000;

export interface DreamDoneArgs {
  handoff?: unknown;
  status?: unknown;
}

export interface DreamDoneDeps {
  backend?: { retrieveConversation(conversationId: string): Promise<unknown> };
  conversationId?: string;
  writeMetadata?: (input: {
    conversationId: string;
    metadata: DreamRunMetadata;
  }) => Promise<void>;
}

export interface DreamDoneResult {
  content: string;
  status: "success" | "error";
}

function error(content: string): DreamDoneResult {
  return { content, status: "error" };
}

function resolveConversationId(deps: DreamDoneDeps): string | null {
  if (deps.conversationId) return deps.conversationId;
  const runtimeConversationId = getRuntimeContext()?.conversationId;
  if (
    typeof runtimeConversationId === "string" &&
    runtimeConversationId.length > 0
  ) {
    return runtimeConversationId;
  }
  try {
    return getConversationId();
  } catch {
    return null;
  }
}

/**
 * Record the handoff and return the instruction the model must follow.
 *
 * `status` is a model-facing word only (`done` when the planned tiers are
 * complete, `handoff` when the run stops early); it is not written to the record
 * because the run controller owns `DreamRunStatus`.
 */
export async function dream_done(
  args: DreamDoneArgs,
  deps: DreamDoneDeps = {},
): Promise<DreamDoneResult> {
  const conversationId = resolveConversationId(deps);
  if (conversationId === null) {
    return error(
      `${TOOL_NAME}: no conversation is available in this execution context, so there is no dream run to finish.`,
    );
  }

  if (typeof args.handoff !== "string") {
    return error(
      `${TOOL_NAME}: "handoff" is required and must be a string — one short paragraph saying where the next run should continue (or that nothing is left).`,
    );
  }
  const handoff = args.handoff.trim();
  if (handoff.length === 0) {
    return error(`${TOOL_NAME}: "handoff" must not be empty.`);
  }
  if (handoff.length > DREAM_DONE_MAX_HANDOFF_CHARS) {
    return error(
      `${TOOL_NAME}: "handoff" is ${handoff.length} characters; the limit is ${DREAM_DONE_MAX_HANDOFF_CHARS}. Put the detail in the report body instead.`,
    );
  }

  let statusWord: "done" | "handoff" = "done";
  if (args.status !== undefined) {
    if (args.status !== "done" && args.status !== "handoff") {
      return error(
        `${TOOL_NAME}: "status" must be "done" or "handoff" when provided.`,
      );
    }
    statusWord = args.status;
  }

  const backend = deps.backend ?? getBackend();
  let record: unknown;
  try {
    record = await backend.retrieveConversation(conversationId);
  } catch {
    return error(
      `${TOOL_NAME}: conversation "${conversationId}" was not found, so there is no dream run to finish.`,
    );
  }
  const metadata = readDreamRunMetadata(
    isRecord(record) ? record.dream : undefined,
  );
  if (metadata === undefined) {
    return error(
      `${TOOL_NAME}: conversation "${conversationId}" is not a dream run (it carries no run record). ${TOOL_NAME} only works inside the hidden conversation a dream run created.`,
    );
  }

  const writeMetadata = deps.writeMetadata ?? writeDreamRunMetadata;
  await writeMetadata({
    conversationId,
    metadata: { ...metadata, handoff },
  });

  return {
    content: [
      `${TOOL_NAME}: handoff recorded (status: ${statusWord}).`,
      "Stop calling tools now. Your next and final message is the report body — write what you changed, why, and what is left.",
      statusWord === "handoff"
        ? "The handoff is written to the run record and included in maintenance/dream-report.md; a later run can read that report if it needs the context (no message is delivered automatically)."
        : "Nothing is left; the handoff says so. It is included in maintenance/dream-report.md.",
      "This tool did not commit anything. If you still have uncommitted memory changes, commit them with MemoryCommit first — after this call there is no further turn.",
    ].join("\n"),
    status: "success",
  };
}
