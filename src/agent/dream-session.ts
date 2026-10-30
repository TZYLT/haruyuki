/**
 * The hidden conversation one dream run writes into (F-06 Q-37 / Q-53).
 *
 * A run never forks: it creates a fresh, hidden, standalone conversation for
 * the *main* agent so the run reuses that agent's stable prefix and tool set
 * (the requirement's alternative — a dedicated dream prefix — was rejected
 * because the `--conv` branch drops `--system` / `--base-tools`).
 *
 * The helper exists so the host, recovery and tests build the create body in
 * one place: `hidden: true`, `origin: "dream"`, `context_mode: "standalone"`.
 * Writing the `dream` run record is a separate step (the conversation id is
 * only known after creation), owned by the run controller.
 */
import type { ConversationCreateBody } from "@/backend";
import { getBackend } from "@/backend";
import { hiddenStandaloneProvenance } from "@/types/conversation-provenance";

export interface CreateDreamSessionInput {
  /** Owner agent; the run reuses this agent's prefix and tools. */
  agentId: string;
  /** Run id, used for the display summary and for crash-recovery correlation. */
  runId: string;
}

export interface DreamSession {
  conversationId: string;
}

/**
 * Body for the dream run's hidden conversation.
 *
 * `summary` is data (the hidden-session viewer shows it), not model context, so
 * it is safe to write at creation time. It is intentionally stable per run
 * rather than timestamped: the run record carries the timing.
 */
export function buildDreamSessionCreateBody(
  input: CreateDreamSessionInput,
): ConversationCreateBody {
  return {
    agent_id: input.agentId,
    summary: `Dream run ${input.runId}`,
    // `hiddenStandaloneProvenance` returns the local-only provenance fields
    // (`hidden` / `origin` / `context_mode`); the SDK create type does not
    // declare them, so the cast is the same one the schedule host uses.
    ...hiddenStandaloneProvenance("dream"),
  } as ConversationCreateBody;
}

/**
 * Create the run's hidden conversation and return its id.
 *
 * Throws when the backend cannot create it; the host treats that as a pre-run
 * failure (F1) before spawning anything.
 */
export async function createDreamSession(
  input: CreateDreamSessionInput,
): Promise<DreamSession> {
  const conversation = await getBackend().createConversation(
    buildDreamSessionCreateBody(input),
  );
  return { conversationId: conversation.id };
}
