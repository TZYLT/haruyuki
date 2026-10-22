import { activeTabIsPage } from "@/cli/app/tabs";
import { pushToast } from "@/cli/notifications/toast-store";
import { runNotificationHooks } from "@/hooks";
import { debugLog } from "@/utils/debug";

/**
 * Telling the user something happened, on the two surfaces the app has.
 *
 * `sendDesktopNotification` is the *outside* one: the terminal bell (which modern
 * terminals turn into a desktop notification when the window is not focused) and
 * the user's notification hooks. It says nothing on screen, by design — it is for
 * the person who is not looking.
 *
 * `notifyTurnComplete` is the *inside* one: when a turn finishes while the user is
 * on a page, the frame puts a line above the input instead of only ringing.
 *
 * **Why not always.** A finished turn already writes its own summary row into the
 * transcript (`trajectory_summary`, "Worked for 12s · 8 steps"), and `docs/38`
 * §15.3 rules that one event must not arrive on two surfaces — the transcript is
 * the record, the toast is the report for what the record cannot show. So a turn
 * that finishes while its conversation is on screen gets the row and no toast; a
 * turn that finishes while a page holds the band gets the toast, because the row
 * is not on screen and the tab strip only says the conversation moved.
 *
 * Everything else that could toast — a subagent finishing, a connection coming
 * back, a compaction completing — still writes its own transcript row, so it is
 * wired the same way in the milestone that gives it a page-level home rather than
 * being toasted twice here.
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
 * A turn finished: ring, and say so on the frame when its own row cannot be seen.
 *
 * Called where the turn's summary row is written, so the two cannot disagree about
 * whether the user was looking — the page check is read at that instant, not
 * remembered from the turn's start.
 */
export function notifyTurnComplete(): void {
  sendDesktopNotification("Turn completed, awaiting your input");
  if (!activeTabIsPage()) return;
  pushToast("Turn finished");
}
