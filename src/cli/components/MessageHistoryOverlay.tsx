import { Box } from "ink";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import {
  clearMessageHistory,
  getMessageHistorySnapshot,
  loadMessageHistory,
  type MessageHistoryKind,
  markMessageHistoryRead,
  subscribeToMessageHistory,
} from "@/cli/notifications/history-store";
import { ConfirmOptions } from "@/cli/overlay/confirm";
import { OverlayFrame } from "@/cli/overlay/frame";
import { listBindings } from "@/cli/overlay/list-bindings";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { Text } from "./Text";

/**
 * `/message-history` — what the shell told the user, and when (M6-P6).
 *
 * `docs/38` §15.2 renamed this from "history" on purpose: `history` reads as shell
 * history, and this is not that. It is the log behind the toast band — the rows a
 * user who was elsewhere missed — and it is **read-only** for the same reason
 * §15.4 gives: M6 does not jump from a notification back to a conversation or
 * replay an event, because the runtime refuses a switch while a turn runs and a
 * face that offered one would be offering a refusal.
 *
 * The only action is `C`, and it is the one action that can lose something, so it
 * asks first (the ruling says "需确认"): the confirmation replaces the list in the
 * same frame, the way `/hooks`' delete does, because that is this tree's shape for
 * a destructive step inside a face.
 *
 * Everything else is the toolkit: `useOverlayList` owns the cursor, the window
 * (ten rows, so a long log scrolls instead of growing the frame), the keys and the
 * `overlay` scope claim — a face that bound keys without claiming the scope is
 * wired correctly and receives nothing.
 */

const WINDOW_ROWS = 10;

/** The label each kind of notification wears in the type column. */
const KIND_LABELS: Record<MessageHistoryKind, string> = {
  turn: "turn",
  subagent: "subagent",
  connection: "connection",
  compaction: "compaction",
  error: "error",
};

/** Widest label above; the column is fixed so the texts line up. */
const KIND_WIDTH = 10;

const CLEAR_OPTIONS = [
  { key: "clear", label: "Yes, clear" },
  { key: "cancel", label: "No, keep" },
];

/** `HH:MM` in the user's own clock, which is the only time a log should show. */
function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function MessageHistoryOverlay({ onClose }: { onClose: () => void }) {
  const { entries } = useSyncExternalStore(
    subscribeToMessageHistory,
    getMessageHistorySnapshot,
  );
  const [confirming, setConfirming] = useState(false);
  const [confirmIndex, setConfirmIndex] = useState(1); // Default to "No, keep"

  // Opening the face is what marks the log read (`docs/38` §15.2: "打开即清零"),
  // and the file is read here rather than at import time so a test that never opens
  // the face never touches the disk.
  useEffect(() => {
    markMessageHistoryRead();
    void loadMessageHistory();
  }, []);

  const items = useMemo<OverlayListItem[]>(
    () =>
      entries.map((entry, index) => ({
        key: `${entry.at}-${entry.kind}-${index}`,
        label: `${clock(entry.at)}  ${KIND_LABELS[entry.kind].padEnd(KIND_WIDTH)}`,
        description: entry.text,
      })),
    [entries],
  );

  const list = useOverlayList({
    owner: "message-history",
    items,
    rows: WINDOW_ROWS,
    // Escape belongs to the confirmation while it is up; the list cannot also
    // answer it, or cancelling the confirmation would close the face.
    onCancel: confirming ? undefined : onClose,
    navigationEnabled: !confirming,
    extra: [
      {
        id: "message-history.clear",
        label: "清空",
        chords: [{ key: "c" }],
        run: () => {
          if (entries.length === 0) return "declined";
          setConfirmIndex(1);
          setConfirming(true);
          return "consumed";
        },
      },
    ],
  });

  // The confirmation's keys live in the `modal` layer, which outranks the face's
  // own `overlay` layer: the router consults only the owning scope, so a list
  // binding that merely *declines* while the confirmation is up would otherwise
  // take the arrows with it (a matched-but-declined binding does not pass to the
  // next owner). Claiming the higher layer is how `useWizard`'s faces keep their
  // sub-views apart, and it is why the frame below passes `container="modal"`.
  useKeyBindings("message-history-clear", [
    {
      scope: "modal",
      bindings: listBindings({
        count: CLEAR_OPTIONS.length,
        cursor: confirmIndex,
        onMoveCursor: setConfirmIndex,
        onConfirm: () => {
          if (confirmIndex === 0) clearMessageHistory();
          setConfirming(false);
        },
        onCancel: () => setConfirming(false),
        navigationEnabled: confirming,
      }),
    },
  ]);

  if (confirming) {
    return (
      <OverlayFrame
        command="/message-history"
        title="Clear the message history?"
        footer="Enter to confirm · esc to cancel"
        container="modal"
      >
        <Text>
          {`This drops ${entries.length} ${entries.length === 1 ? "entry" : "entries"}, in memory and in the file.`}
        </Text>
        <Box height={1} />
        <ConfirmOptions options={CLEAR_OPTIONS} selectedIndex={confirmIndex} />
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      command="/message-history"
      title="Message history"
      footer="↑↓ scroll · C clear · Esc close"
    >
      <OverlayListView
        items={items}
        cursor={list.cursor}
        rows={WINDOW_ROWS}
        emptyLabel="Nothing yet — what the toast band announces lands here."
      />
    </OverlayFrame>
  );
}
