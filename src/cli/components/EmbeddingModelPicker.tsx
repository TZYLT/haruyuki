/**
 * `/recall embedding model`'s interactive face (48-4 D-09).
 *
 * One row per stored space, with the actions the command's flags expose:
 * Enter selects, `D` deletes (two presses: preview, then confirm), `P` pins or
 * unpins. The pure listing/selection logic lives in `cli/helpers/embedding-models`;
 * this component only owns the cursor, the pending-delete state and the refresh.
 *
 * Deletion is deliberately a two-press action rather than a modal dialog: the
 * picker sits inside the recall wizard's overlay, where Escape belongs to the
 * wizard. A nested confirm view would need its own key ownership; pressing the
 * same destructive key twice is the same safety with no key conflict.
 *
 * Layer: `cli/components/` (Ink only).
 */

import { Box } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text } from "@/cli/components/Text";
import {
  type EmbeddingModelRow,
  listEmbeddingModels,
} from "@/cli/helpers/embedding-models";
import type { SingleSelectItem } from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { getErrorMessage } from "@/utils/error";

export interface EmbeddingModelPickerProps {
  /** The active agent; without it there is no space list to read. */
  agentId?: string;
  /** Runs one `/recall embedding model …` action (the same handler as the CLI). */
  runCommand: (args: string[]) => Promise<string>;
  /**
   * Test seam: the listing function. Production omits it and reads the spaces
   * on disk through `listEmbeddingModels`.
   */
  loadModels?: (agentId: string) => Promise<EmbeddingModelRow[]>;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function rowItem(row: EmbeddingModelRow): SingleSelectItem {
  const flags = [
    row.active ? "active" : "",
    row.pinned ? "pinned" : "",
    row.legacy ? "legacy" : "",
  ]
    .filter((flag) => flag.length > 0)
    .join(",");
  return {
    key: String(row.index),
    label: `#${row.index} ${row.model}`,
    description: `${row.dimensions ?? "?"}d · ${row.quantization ?? "?"} · ${row.chunks} chunks · ${formatBytes(row.bytes)} · built ${row.builtAt ?? "never"}${flags.length > 0 ? ` · ${flags}` : ""}`,
    isCurrent: row.active,
  };
}

export function EmbeddingModelPicker({
  agentId,
  runCommand,
  loadModels,
}: EmbeddingModelPickerProps) {
  const [rows, setRows] = useState<EmbeddingModelRow[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const cursorRef = useRef(0);

  const refresh = useCallback(async () => {
    if (agentId === undefined || agentId.trim().length === 0) {
      setPhase("failed");
      setNotice(
        "Vector recall needs an active agent to list its stored models.",
      );
      return;
    }
    setPhase("loading");
    try {
      const load =
        loadModels ?? ((id: string) => listEmbeddingModels({ agentId: id }));
      const next = await load(agentId);
      rowsRef.current = next;
      setRows(next);
      setPhase("ready");
    } catch (error) {
      setPhase("failed");
      setNotice(getErrorMessage(error));
    }
  }, [agentId, loadModels]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    (args: string[]) => {
      void (async () => {
        try {
          setNotice(await runCommand(args));
        } catch (error) {
          setNotice(getErrorMessage(error));
        }
        await refresh();
      })();
    },
    [refresh, runCommand],
  );

  const currentRow = (): EmbeddingModelRow | undefined =>
    rowsRef.current[cursorRef.current];

  const items = rows.map(rowItem);
  const list = useOverlayList({
    owner: "recall-embedding-model-picker",
    items,
    onConfirm: (key) => {
      const row = rowsRef.current[Number(key) - 1];
      if (row === undefined) return;
      if (row.active) {
        setNotice(`Model #${row.index} is already active.`);
        return;
      }
      setPendingDelete(null);
      run(["model", "--select", String(row.index)]);
    },
    extra: [
      {
        id: "recall-embedding-model.delete",
        chords: [{ key: "d" }, { key: "D" }, { key: "d", ctrl: true }],
        run: () => {
          const row = currentRow();
          if (row === undefined) return "declined";
          if (row.active) {
            setNotice(
              `Model #${row.index} is the active space; switch away before deleting it.`,
            );
            return "consumed";
          }
          if (pendingDelete !== row.index) {
            setPendingDelete(row.index);
            setNotice(
              `Deleting model #${row.index} (${row.model}) removes only its vector index; transcripts, memory and settings are untouched. Press D again to confirm, or move/leave to cancel.`,
            );
            return "consumed";
          }
          setPendingDelete(null);
          run(["model", "--delete", String(row.index), "--confirm"]);
          return "consumed";
        },
      },
      {
        id: "recall-embedding-model.pin",
        chords: [{ key: "p" }, { key: "P" }],
        run: () => {
          const row = currentRow();
          if (row === undefined) return "declined";
          if (row.legacy) {
            setNotice(
              `Model #${row.index} has no profile, so it cannot be pinned. Rebuild it once.`,
            );
            return "consumed";
          }
          setPendingDelete(null);
          run(["model", row.pinned ? "--unpin" : "--pin", String(row.index)]);
          return "consumed";
        },
      },
    ],
  });
  cursorRef.current = list.cursor;

  const row = currentRow();
  const footer =
    pendingDelete !== null && pendingDelete === row?.index
      ? `Press D again to delete #${row.index} · Esc leaves`
      : "Enter select · D delete · P pin · ↑↓/jk move · Esc back";

  return (
    <OverlayFrame command="/recall" title="Stored vector models">
      <Box flexDirection="column">
        {phase === "loading" && rows.length === 0 ? (
          <Text>Loading stored models…</Text>
        ) : null}
        <OverlayListView
          items={items}
          cursor={list.cursor}
          mouse={list.mouse}
          emptyLabel="No vector models are stored yet. Use Connect to add one."
        />
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
        {notice === null ? null : (
          <Box marginTop={1} flexDirection="column">
            {notice.split("\n").map((line, index) => (
              <Text key={`${index}-${line}`}>{line}</Text>
            ))}
          </Box>
        )}
      </Box>
    </OverlayFrame>
  );
}
