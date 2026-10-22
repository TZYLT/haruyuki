/**
 * Deriving a conversation's title once, after its first completed turn.
 *
 * Extracted from `use-conversation-loop.ts` (which sits at its size cap): the
 * loop only decides *when* a turn makes a title possible, this module owns the
 * "once" part — the in-flight guard, the stale-conversation check that runs
 * again after the model call, and the silent failure that must not cost the
 * turn anything.
 *
 * The backend write stays fire-and-forget and the `finally` always clears the
 * in-flight flag, which is what keeps a slow write from blocking the next turn's
 * title attempt forever.
 */

export interface AutoTitleInput {
  /** Whether this conversation still wants a generated title. */
  shouldGenerate: boolean;
  /** A title request is already running. */
  inFlight: boolean;
  /** Conversation the turn belongs to, captured before the await. */
  conversationId: string;
  /** Re-read after the await: the user may have switched conversations. */
  currentConversationId: () => string;
  /** Whether a title is still wanted after the await (a rename cancels it). */
  stillWanted: () => boolean;
  generate: () => Promise<string | null>;
  update: (conversationId: string, summary: string) => Promise<unknown>;
  onApplied: (summary: string) => void;
  onFailure: (error: unknown) => void;
  setShouldGenerate: (value: boolean) => void;
  setInFlight: (value: boolean) => void;
}

/** Returns once the model call is done; the write continues in the background. */
export async function maybeAutoTitleConversation(
  input: AutoTitleInput,
): Promise<void> {
  if (!input.shouldGenerate || input.inFlight) return;
  if (input.conversationId === "default") return;

  input.setInFlight(true);
  const titleConversationId = input.conversationId;
  const title = await input.generate();
  if (!title) {
    input.setInFlight(false);
    return;
  }
  if (
    !input.stillWanted() ||
    input.currentConversationId() !== titleConversationId
  ) {
    input.setInFlight(false);
    return;
  }
  void input
    .update(titleConversationId, title)
    .then(() => {
      input.setShouldGenerate(false);
      input.onApplied(title);
    })
    .catch(input.onFailure)
    .finally(() => {
      input.setInFlight(false);
    });
}
