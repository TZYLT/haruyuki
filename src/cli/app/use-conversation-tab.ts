// src/cli/app/use-conversation-tab.ts

import { useEffect, useRef } from "react";
import {
  focusTab,
  openConversationTab,
  setTabTitle,
  tabTitleFor,
} from "./tabs";

/**
 * Keeps the tab strip's model in step with the conversation the app is on.
 *
 * This is the only writer of "a conversation is open": every switch path
 * (`/resume`, `/search`, an agent switch, `/new`, a fork jump) ends by setting
 * `conversationId`, so watching that value here records all of them without
 * threading a call through four handlers — and without the shell ever learning
 * what a conversation switch is.
 *
 * The distinction the hook has to make is **switch versus title**:
 *
 * - a *new* conversation id opens its tab and focuses it, because switching is
 *   exactly what putting a different conversation in the main area means;
 * - a *new summary* for the same id only retitles the tab. Focusing there would
 *   yank the user off the page they were reading the moment a background title
 *   landed.
 *
 * Which of the two titles a tab gets is the model's decision (`tabTitleFor`), not
 * this hook's: an absent summary must not demote a tab that already shows
 * something true.
 *
 * A turn starting focuses the conversation tab back, because the answer to
 * something the user just sent must not arrive hidden behind a page.
 */
export type ConversationTabInput = {
  conversationId: string;
  /** The conversation's summary (auto-title); `null` before the model writes one. */
  summary: string | null;
  /** Whether a turn is streaming right now. */
  streaming: boolean;
};

export function useConversationTab(input: ConversationTabInput): void {
  const { conversationId, summary, streaming } = input;
  const recordedRef = useRef<string | null>(null);

  // The process entry renders `<App agentId="loading" conversationId="loading">`
  // while it resolves the session (`index.ts`). That placeholder is not a
  // conversation and must never become a tab: it is titled "loading", a click or a
  // `/close` on it switches the runtime to it, and `persistSession` then writes
  // `conversationId: "loading"` — which is the session that fails to resume with
  // "Conversation loading not found" on the next start.
  const isPlaceholder = conversationId === "" || conversationId === "loading";

  useEffect(() => {
    if (isPlaceholder) return;
    const title = tabTitleFor(conversationId, summary);
    if (recordedRef.current === conversationId) {
      setTabTitle(conversationId, title);
      return;
    }
    recordedRef.current = conversationId;
    openConversationTab(conversationId, title);
  }, [conversationId, summary, isPlaceholder]);

  useEffect(() => {
    if (isPlaceholder) return;
    if (streaming) focusTab(conversationId);
  }, [streaming, conversationId, isPlaceholder]);
}
