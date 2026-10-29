import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { useKeyBindings } from "@/cli/hooks/use-input-router";

/**
 * The message history face's own door (`docs/38` §15.2): `Ctrl+X h`.
 *
 * Mounted by `V2Shell` and not by the append shell, which is what freezes the
 * compatibility mode without a mode branch: the append shell registers nothing, so
 * the chord is not a key there at all — the same shape as the mouse escape hatch
 * next to it (`use-mouse-input.ts`).
 *
 * The face is opened through a callback rather than by touching a store, because
 * `activeOverlay` is the view's state: this hook owns a key, not a surface.
 */
export function useMessageHistory(open: () => void): void {
  useKeyBindings("message-history", [
    {
      scope: "app",
      bindings: [
        {
          id: "leader.messageHistory",
          leader: true,
          chords: LEADER_KEY_CHORDS.messageHistory,
          label: "Message history",
          run: () => {
            open();
            return "consumed";
          },
        },
      ],
    },
  ]);
}
