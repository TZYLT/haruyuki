/**
 * The one write path for reflection run metadata on a fork conversation.
 *
 * The launcher records `running` once the fork exists; the run controller
 * records the terminal status (and, on a timeout, where the discarded work was
 * backed up). Both call this instead of hand-building an update body, so the
 * stored shape has a single producer and a single reader
 * (`readReflectionRunMetadata`).
 *
 * A failed write must not fail the run: the in-process state remains the
 * authority for the gate, and the durable copy is a record for the viewer,
 * recovery and the user. Callers treat a rejection as a warning.
 */

import type { ConversationUpdateBody } from "@/backend";
import { getBackend } from "@/backend";
import type { ReflectionRunMetadata } from "@/types/reflection-run-metadata";

export interface WriteReflectionRunMetadataInput {
  conversationId: string;
  metadata: ReflectionRunMetadata;
}

/**
 * Replace the run metadata on a conversation.
 *
 * `reflection` is not part of the SDK's `ConversationUpdateBody` — it is a
 * local-backend conversation field (like `hidden` / `context_mode`) that the
 * record layer accepts as an additive extension. The cast is confined here so
 * no caller has to know that.
 */
export async function writeReflectionRunMetadata(
  input: WriteReflectionRunMetadataInput,
): Promise<void> {
  const body = {
    reflection: input.metadata,
  } as unknown as ConversationUpdateBody;
  await getBackend().updateConversation(input.conversationId, body);
}
