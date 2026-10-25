import { Box } from "ink";
import { useCallback, useRef, useState } from "react";
import { getBackend } from "@/backend";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { type ConfirmOption, ConfirmOptions } from "@/cli/overlay/confirm";
import { OverlayFrame } from "@/cli/overlay/frame";
import { listBindings } from "@/cli/overlay/list-bindings";
import {
  type HiddenConversationSummary,
  readConversationProvenance,
} from "@/types/conversation-provenance";
import { Text } from "./Text";

/**
 * The one confirmation before a hidden session is destroyed (F-01 §5.4.2).
 *
 * The list and the detail both open it and both stop drawing while it is up, so
 * there is one question, one key table and one delete call rather than two
 * variants that could disagree about the default. The default row is **Cancel**:
 * the destructive row must be reached on purpose.
 *
 * What the box owes the reader is the identity of the thing (title and id), what
 * it holds (inherited / new or in-context counts) and the two consequences that
 * are not visible on screen: this is not undoable, and a still-running session's
 * background task may fail afterwards. A failed delete stays in this box with the
 * error: the row must not look deleted when the disk still has it (§5.4.7).
 */

const DELETE_OPTIONS: readonly ConfirmOption[] = [
  { key: "delete", label: "Delete permanently" },
  { key: "cancel", label: "Cancel" },
];

const CANCEL_INDEX = 1;

export interface HiddenSessionDeleteConfirmProps {
  /** The row the list opened, or the detail's own session. */
  session: HiddenConversationSummary;
  /**
   * `newMessages.length` when the detail already knows it. The list does not read
   * a transcript, so it falls back to the in-context size instead.
   */
  newCount?: number | null;
  onCancel: () => void;
  onDeleted: () => void;
}

export function HiddenSessionDeleteConfirm({
  session,
  newCount,
  onCancel,
  onDeleted,
}: HiddenSessionDeleteConfirmProps) {
  const width = Math.max(1, useTerminalWidth() - 4);
  const [selected, setSelected] = useState(CANCEL_INDEX);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two Enters can land in one tick, before `busy` has rendered; the ref is what
  // actually makes the delete one-shot.
  const busyRef = useRef(false);

  const provenance = readConversationProvenance(session);
  const inherited = provenance.inherited_message_count;
  // Three genuinely different facts: nothing inherited, N inherited, or a legacy
  // record that never recorded a count. Collapsing the last into "0" would tell
  // the reader the fork was empty when nothing is known.
  const inheritedLabel =
    inherited == null
      ? "inherited count unknown"
      : inherited === 0
        ? "no inherited context"
        : `${inherited} inherited hidden`;
  const sizeLabel =
    newCount != null
      ? `${newCount} new`
      : `${session.context_message_count} in context`;
  const title = session.summary?.trim() || session.id;

  const runDelete = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // The viewer only lists hidden sessions; this is the last line of defence
      // for a hand-built row or a future caller.
      if (session.hidden !== true) {
        setError("this is not a hidden session");
        return;
      }
      const backend = getBackend();
      if (typeof backend.deleteConversation !== "function") {
        setError("this backend cannot delete conversations");
        return;
      }
      await backend.deleteConversation(session.id);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onDeleted, session.hidden, session.id]);

  useKeyBindings("hidden-session-delete", [
    {
      scope: "modal",
      bindings: listBindings({
        count: DELETE_OPTIONS.length,
        cursor: selected,
        onMoveCursor: setSelected,
        onConfirm: () => {
          if (selected === CANCEL_INDEX) {
            onCancel();
            return;
          }
          void runDelete();
        },
        onCancel,
        navigationEnabled: !busy,
      }),
    },
  ]);

  const lines: Array<{ key: string; text: string }> = [
    { key: "title", text: title },
    { key: "id", text: session.id },
    {
      key: "meta",
      text: `${provenance.origin} · ${inheritedLabel} · ${sizeLabel}`,
    },
  ];

  return (
    <OverlayFrame
      command="/maintenance sessions"
      title="Delete this hidden session?"
      footer="↑↓ choose · enter confirms · esc cancels"
      container="modal"
    >
      <Box flexDirection="column">
        {lines.map((line) => (
          <Text key={line.key}>{truncateText(line.text, width)}</Text>
        ))}
        <Box height={1} />
        <Text>
          {truncateText(
            "This permanently deletes the record, its messages and its compiled prompt.",
            width,
          )}
        </Text>
        <Text>It cannot be undone.</Text>
        <Text dimColor>
          {truncateText(
            "If the session is still running, the background task may fail.",
            width,
          )}
        </Text>
        {error && (
          <Text color="red">
            {truncateText(`Delete failed: ${error}`, width)}
          </Text>
        )}
        <Box height={1} />
        <ConfirmOptions options={DELETE_OPTIONS} selectedIndex={selected} />
      </Box>
    </OverlayFrame>
  );
}
