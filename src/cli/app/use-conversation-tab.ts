// src/cli/app/use-conversation-tab.ts

import { useEffect, useRef } from "react";
import {
  conversationTitle,
  focusTab,
  openConversationTab,
  setTabTitle,
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

  useEffect(() => {
    const title = conversationTitle(summary, conversationId);
    if (recordedRef.current === conversationId) {
      setTabTitle(conversationId, title);
      return;
    }
    recordedRef.current = conversationId;
    openConversationTab(conversationId, title);
  }, [conversationId, summary]);

  useEffect(() => {
    if (streaming) focusTab(conversationId);
  }, [streaming, conversationId]);
}
