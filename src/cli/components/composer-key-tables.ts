import type { KeyBindingTable } from "@/cli/helpers/input-keys";
import { consumeKey } from "@/cli/helpers/input-keys";
import { APP_KEY_CHORDS, LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";

/**
 * The keys the composer owns, as data.
 *
 * The composer's handlers close over its state (the draft, the pending
 * interrupt, the double-press guards), so the table is built from them rather
 * than declared statically — but "which keys does the composer have" is still
 * answerable without reading the handler bodies.
 *
 * Three scopes are involved, and the difference is the point:
 *
 * - While a profile confirmation is pending the confirmation takes **any** key
 *   (Enter confirms, anything else cancels) and nothing else may run: that is the
 *   `modal` scope with a catch-all.
 * - Every other composer key is `app` scope, which the focus ledger stands down
 *   whenever a selector, dialog route, or approval owns the keyboard.
 * - The leader prefix arms `app` scope and its entries are marked `leader: true`,
 *   so the router only reaches them while the prefix is armed. A second key with
 *   no meaning on its own (`?`) is typing the rest of the time.
 */

export interface ComposerKeyHandlers {
  /** Enter during a profile confirmation. */
  profileConfirm: () => void;
  /** Any other key during a profile confirmation. */
  profileCancel: () => void;
  /** Expand/collapse the last shell tool call's output. */
  toggleShellOutput: () => void;
  /** Show/hide system reminders. */
  toggleSystemReminders: () => void;
  /** Expand/collapse thinking blocks. */
  toggleThinking: () => void;
  /** Interrupt a running turn, else arm/perform the double-escape clear. */
  interrupt: () => void;
  /** Wipe the draft; a second press exits. */
  clearOrExit: () => void;
  /** Cycle the reasoning-effort tier; return false when something else owns Tab. */
  cycleReasoningEffort: () => boolean | void;
  /** Cycle the permission mode. */
  cyclePermissionMode: () => void;
  /** Arm the leader prefix (Ctrl+X): the next key is a leader command. */
  armLeader: () => void;
  /** The leader's own help entry: list what the prefix can do. */
  leaderHelp: () => void;
}

export function composerKeyTables(
  handlers: ComposerKeyHandlers,
  state: { enabled: boolean; profileConfirmPending: boolean },
): KeyBindingTable[] {
  if (!state.enabled) return [];

  const tables: KeyBindingTable[] = [];

  if (state.profileConfirmPending) {
    tables.push({
      scope: "modal",
      bindings: [
        {
          id: "profile.confirm",
          chords: [{ key: "return" }],
          run: consumeKey(handlers.profileConfirm),
        },
        // Anything else cancels. A catch-all only runs when no chord above
        // matched, so it cannot shadow the confirm binding.
        { id: "profile.cancel", run: consumeKey(handlers.profileCancel) },
      ],
    });
  }

  tables.push({
    scope: "app",
    bindings: [
      {
        id: "transcript.toggleShellOutput",
        chords: APP_KEY_CHORDS.toggleShellOutput,
        run: consumeKey(handlers.toggleShellOutput),
      },
      {
        id: "transcript.toggleSystemReminders",
        chords: APP_KEY_CHORDS.toggleSystemReminders,
        run: consumeKey(handlers.toggleSystemReminders),
      },
      {
        id: "transcript.toggleThinking",
        chords: APP_KEY_CHORDS.toggleThinking,
        run: consumeKey(handlers.toggleThinking),
      },
      {
        id: "app.interrupt",
        chords: APP_KEY_CHORDS.interrupt,
        run: consumeKey(handlers.interrupt),
      },
      {
        id: "app.clearOrExit",
        chords: APP_KEY_CHORDS.clearOrExit,
        run: consumeKey(handlers.clearOrExit),
      },
      {
        id: "app.cycleReasoningEffort",
        chords: APP_KEY_CHORDS.cycleReasoningEffort,
        run: consumeKey(handlers.cycleReasoningEffort),
      },
      {
        id: "app.cyclePermissionMode",
        chords: APP_KEY_CHORDS.cyclePermissionMode,
        run: consumeKey(handlers.cyclePermissionMode),
      },
      {
        id: "leader.activate",
        chords: LEADER_KEY_CHORDS.activate,
        run: consumeKey(handlers.armLeader),
      },
      {
        id: "leader.help",
        leader: true,
        chords: LEADER_KEY_CHORDS.help,
        label: "List available keys",
        run: consumeKey(handlers.leaderHelp),
      },
    ],
  });

  return tables;
}
