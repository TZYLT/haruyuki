/**
 * The one-shot no-marker nudge (feature ③, D-114).
 *
 * A conversation that runs `topic_nudge_turns` user turns without a marker gets
 * exactly one reminder per streak: the agent is told in its next message, and
 * the user sees a line in the terminal. The decision itself is
 * `decideTopicNudge` in `topic-compaction.ts`; this module is the small I/O
 * shell that reads the facts, settles the one-shot flag, and reports the reason.
 *
 * The flag is written when the nudge goes out and cleared on every other
 * outcome: a new marker (or a context rewrite) starts a new streak, so a flag
 * left over from the previous one must not suppress the next nudge. A *disabled*
 * nudge (`nudge_turns = 0`) is not an outcome that ends a streak, so it leaves
 * the flag exactly as it found it. Losing one delivery is acceptable; repeating
 * one is not, which is why the write happens here rather than after a reminder
 * has been rendered.
 *
 * It runs against a port object rather than the backend so the "one write, and
 * only when it is due" ordering can be tested without a provider — the same
 * shape `compaction-run.ts` uses for the rewrite.
 */
import type { LocalMessage } from "./local-message";
import type { LocalConversationContextManagement } from "./local-types";
import {
  decideTopicNudge,
  type LocalTopicMarker,
  type TopicNudgeDecision,
  userTurnsSinceLastTopicMarker,
} from "./topic-compaction";

export interface LocalTopicNudgePorts {
  listMessages(conversationId: string, agentId: string): LocalMessage[];
  readMarkers(conversationId: string, agentId: string): LocalTopicMarker[];
  readContextManagement(
    conversationId: string,
    agentId: string,
  ): LocalConversationContextManagement;
  /** Writes (or clears) the streak flag; a no-op when it already matches. */
  setTopicNudgeSent(
    conversationId: string,
    agentId: string,
    sent: boolean,
  ): void;
}

/**
 * The store members this module reads. It is the store itself, narrowed to what
 * the nudge needs, so `LocalStore` keeps its own size budget.
 */
export interface LocalTopicNudgeStore {
  listLocalMessages(conversationId: string, agentId: string): LocalMessage[];
  contextRewrites: {
    readTopicMarkers(
      conversationId: string,
      agentId: string,
    ): LocalTopicMarker[];
    readContextManagement(
      conversationId: string,
      agentId: string,
    ): LocalConversationContextManagement;
    setTopicNudgeSent(
      conversationId: string,
      agentId: string,
      sent: boolean,
    ): void;
  };
}

export function localTopicNudgePorts(
  store: LocalTopicNudgeStore,
): LocalTopicNudgePorts {
  return {
    listMessages: (conversationId, agentId) =>
      store.listLocalMessages(conversationId, agentId),
    readMarkers: (conversationId, agentId) =>
      store.contextRewrites.readTopicMarkers(conversationId, agentId),
    readContextManagement: (conversationId, agentId) =>
      store.contextRewrites.readContextManagement(conversationId, agentId),
    setTopicNudgeSent: (conversationId, agentId, sent) =>
      store.contextRewrites.setTopicNudgeSent(conversationId, agentId, sent),
  };
}

/**
 * Decide, settle the flag, and report why.
 *
 * `nudgeTurns` is passed in rather than read here so this module has no opinion
 * about where a preference comes from (`topic_nudge_turns`, default 50).
 */
export function consumeLocalTopicNudge(
  ports: LocalTopicNudgePorts,
  input: { conversationId: string; agentId: string; nudgeTurns: number },
): TopicNudgeDecision {
  const { conversationId, agentId } = input;
  const alreadySentForStreak =
    ports.readContextManagement(conversationId, agentId)
      .nudge_sent_for_streak === true;
  const decision = decideTopicNudge({
    turnsSinceLastMarker: userTurnsSinceLastTopicMarker(
      ports.listMessages(conversationId, agentId),
      ports.readMarkers(conversationId, agentId),
    ),
    nudgeTurns: input.nudgeTurns,
    alreadySentForStreak,
  });
  // The flag is set while the nudge is due or already recorded for this stretch
  // and cleared as soon as the stretch it belonged to ended. An "already_sent"
  // outcome must keep it, or the next turn would nudge again; a disabled nudge
  // keeps it too, so switching the nudge off and on again inside one stretch
  // cannot produce a second reminder.
  const recordSent =
    decision.reason === "due" ||
    decision.reason === "already_sent" ||
    (decision.reason === "disabled" && alreadySentForStreak);
  ports.setTopicNudgeSent(conversationId, agentId, recordSent);
  return decision;
}
