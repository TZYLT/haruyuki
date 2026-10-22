import { activeTabIsPage } from "@/cli/app/tabs";
import {
  type MessageHistoryKind,
  recordMessageHistory,
} from "@/cli/notifications/history-store";
import { pushToast } from "@/cli/notifications/toast-store";
import { runNotificationHooks } from "@/hooks";
import { debugLog } from "@/utils/debug";

/**
 * Telling the user something happened, on the surfaces this module owns.
 *
 * `sendDesktopNotification` is the *outside* one: the terminal bell (which modern
 * terminals turn into a desktop notification when the window is not focused) and
 * the user's notification hooks. It says nothing on screen, by design — it is for
 * the person who is not looking.
 *
 * `notify` is the *inside* one, and its rules are `docs/38` §15.3's channel table:
 *
 * | event | channel |
 * |---|---|
 * | a finished turn, a finished subagent, a connection coming back, a compaction | toast + history |
 * | an error | transcript + history, **never** a toast |
 * | an approval request | the approval UI + the bell (this module's `bell` half only) |
 * | transient status (bash mode, permission mode, the queue) | the status row, neither surface here |
 *
 * **Why the toast is conditional.** A finished turn already writes its own summary
 * row into the transcript (`trajectory_summary`, "Worked for 12s · 8 steps"), and
 * §15.3's first rule is that one event must not arrive on two surfaces — the
 * transcript is the record, the toast is the report for what the record cannot
 * show. So a turn that finishes while its conversation is on screen gets the row
 * and no toast; one that finishes while a page holds the band gets the toast,
 * because the row is not on screen and the tab strip only says the conversation
 * moved. Errors are the reverse case: the row is where they must stay, so they are
 * history only.
 *
 * The kinds that are not wired to a call site yet (subagent, connection,
 * compaction) route correctly the day they are: they are the same "row exists, so
 * toast only when it is off screen" shape as a turn.
 */

/** Bell plus the notification hooks: the report for someone not at the terminal. */
export function sendDesktopNotification(
  message = "Awaiting your input",
  level: "info" | "warning" | "error" = "info",
) {
  // Send terminal bell for native notification
  process.stdout.write("\x07");
  // Run Notification hooks (fire-and-forget, don't block)
  runNotificationHooks(message, level).catch((error) => {
    debugLog("hooks", "Notification hook error", error);
  });
}

/**
 * The words each kind uses when the caller does not supply its own.
 *
 * Short on purpose: the text is a toast row and a history line, not a sentence a
 * user has to read twice. The detail that belongs to the event (a turn's steps and
 * duration, a subagent's task) stays in the transcript row the event already wrote.
 */
export const DEFAULT_NOTIFICATION_TEXT: Record<MessageHistoryKind, string> = {
  turn: "Turn finished",
  subagent: "Subagent finished",
  connection: "Connection restored",
  compaction: "Compaction finished",
  error: "Something went wrong",
};

/**
 * One event, one surface: ring, and then route it to the band or to the history.
 *
 * The page check is read here, at the moment the event happens, rather than
 * remembered from the turn's start — what matters is whether the transcript was on
 * screen when the user would have looked.
 */
export function notify(
  kind: MessageHistoryKind,
  text: string = DEFAULT_NOTIFICATION_TEXT[kind],
): void {
  sendDesktopNotification(text, kind === "error" ? "error" : "info");
  if (kind === "error") {
    recordMessageHistory(kind, text);
    return;
  }
  if (!activeTabIsPage()) return;
  pushToast(text);
  recordMessageHistory(kind, text);
}
