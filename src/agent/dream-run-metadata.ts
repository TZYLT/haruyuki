/**
 * The one write path for dream run metadata on a hidden conversation.
 *
 * The run host records `running` once the baseline exists; the run controller
 * records every later transition (tier progress, budget spend, terminal
 * status). Both call this instead of hand-building an update body, so the
 * stored shape has a single producer and a single reader
 * (`readDreamRunMetadata`).
 *
 * A failed write must not fail the run: the in-process controller remains the
 * authority for the gate, and the durable copy is a record for the viewer,
 * recovery and the user. Callers treat a rejection as a warning.
 */

import type { ConversationUpdateBody } from "@/backend";
import { getBackend } from "@/backend";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

export interface WriteDreamRunMetadataInput {
  conversationId: string;
  metadata: DreamRunMetadata;
}

/**
 * Replace the dream metadata on a conversation.
 *
 * `dream` is not part of the SDK's `ConversationUpdateBody` — it is a
 * local-backend conversation field (like `hidden` / `reflection`) that the
 * record layer accepts as an additive extension. The cast is confined here so
 * no caller has to know that.
 */
export async function writeDreamRunMetadata(
  input: WriteDreamRunMetadataInput,
): Promise<void> {
  const body = {
    dream: input.metadata,
  } as unknown as ConversationUpdateBody;
  await getBackend().updateConversation(input.conversationId, body);
}
