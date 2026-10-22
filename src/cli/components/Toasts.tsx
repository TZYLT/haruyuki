import { Box } from "ink";
import { memo, useSyncExternalStore } from "react";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  getToastSnapshot,
  subscribeToToasts,
} from "@/cli/notifications/toast-store";

/**
 * The toast band, as the frame draws it: up to three rows, newest at the bottom.
 *
 * It is a **slot the shell fills**, not a branch inside `AppView`
 * (`AppShellProps.aboveInput`). The append shell never passes it, which is what
 * keeps the compatibility mode frozen without `if (legacy)` anywhere in core — the
 * same mechanism the transcript region uses (`ShellFrame`).
 *
 * Where it sits is `docs/38` §2.1's order: toast rows, then the input, then the
 * status row and the hint row. The band is inside the measured chrome
 * (`chrome-height.ts`), so the transcript band gives its rows up while a toast is
 * up and takes them back when it leaves — which is what "the middle is elastic,
 * it absorbs the rows the toast gives back" (§2.1) means in practice.
 *
 * **Subscribed here, in a leaf.** A toast arriving must not re-render the
 * transcript or the composer: the store is module state, this component is the one
 * subscriber (`docs/33` R6 — "toast 用独立 store ＋ memo"). `memo` means a render of
 * `AppView` for any other reason stops at this boundary.
 */
function ToastBand() {
  const { toasts, folded } = useSyncExternalStore(
    subscribeToToasts,
    getToastSnapshot,
  );

  if (toasts.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {toasts.map((toast, index) => (
        <Text key={toast.id} wrap="truncate">
          <Text color={colors.toast.marker}>{`${CLI_GLYPHS.toast} `}</Text>
          <Text color={colors.toast.text}>{toast.text}</Text>
          {/* The count belongs to the oldest row: it is the ones before it that
              did not fit, and the newest row is left alone to be read. */}
          {index === 0 && folded > 0 ? (
            <Text dimColor>{`  +${folded}`}</Text>
          ) : null}
        </Text>
      ))}
    </Box>
  );
}

export const Toasts = memo(ToastBand);
