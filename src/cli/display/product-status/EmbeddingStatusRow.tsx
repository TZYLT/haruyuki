/**
 * The embedding status row above the input (48-1 §7.4, 48-2 §3.4 D6).
 *
 * The polled half of the segment: `display/product-status/embedding.ts` owns
 * the copy, this component owns the read and the refresh cadence. It is a
 * separate module on purpose — `AppView.tsx` is on the size ratchet, so the
 * view only mounts the row (`<EmbeddingStatusRow width={chromeColumns} />`)
 * and all state stays in this subtree.
 *
 * Refresh discipline (TUI flicker rules, `src/cli/AGENTS.md`): one 2 s timer,
 * and a poll that compares the serialized snapshot before publishing, so an
 * unchanged reading does not repaint the frame. The row renders `null` while
 * the feature is off, which is also what keeps an idle build from occupying a
 * status line (48-1 §7.4).
 *
 * What is *not* here yet: the build's live progress. That belongs to the
 * embedding host (A4) and its status hook (A5); until they land, the row is fed
 * the process-wide arm counters, so it shows a round summary and degrade
 * reasons rather than a percentage. `EmbeddingProductStatusSnapshot.build`
 * already carries the shape the hook will fill in.
 */

import chalk from "chalk";
import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";
import { readEmbeddingBuildStatusSnapshot } from "@/cli/hooks/use-embedding-build-status";
import { readEmbeddingSettings } from "@/recall-settings";
import { embeddingMetrics } from "@/reminders/embedding-metrics";
import {
  type EmbeddingProductStatusSnapshot,
  renderEmbeddingSegment,
} from "./embedding";

/** How often the row re-reads settings and the arm counters while the TUI runs. */
export const EMBEDDING_STATUS_REFRESH_MS = 2_000;

const HIDDEN: EmbeddingProductStatusSnapshot = {
  enabled: false,
  backend: "builtin",
  model: null,
};

/**
 * Read the current snapshot. Cheap and synchronous: a resolved settings record
 * plus the already-in-memory metrics window. Settings are read call-time (never
 * captured at import) so a `/recall embedding on` takes effect on the next
 * poll.
 */
export function readEmbeddingProductStatus(): EmbeddingProductStatusSnapshot {
  try {
    const settings = readEmbeddingSettings();
    const last = embeddingMetrics.snapshot().last;
    return {
      enabled: settings.enabled,
      backend: settings.backend,
      model:
        settings.backend === "endpoint"
          ? (settings.endpoint?.model ?? null)
          : settings.model,
      arms:
        last === null
          ? null
          : {
              lexical: last.lexical.candidates,
              vector: last.vector.candidates,
              injected: last.injected,
              degraded: last.degrade.length > 0,
            },
      degrade: last?.degrade[0] ?? null,
      // Coverage belongs to the build snapshot the A4/A5 host will inject.
      coverage: null,
    };
  } catch {
    // Settings unavailable (very early startup, no manager): stay silent.
    return HIDDEN;
  }
}

function sameSnapshot(
  left: EmbeddingProductStatusSnapshot,
  right: EmbeddingProductStatusSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A stable `readSnapshot` for the shell, one per agent.
 *
 * The row owns a 2 s poll and re-arms it when `readSnapshot`'s identity
 * changes, so the view must hand it a function that survives re-renders — an
 * inline arrow would reset the interval on every streamed frame and the build
 * progress would never paint. The factory memoizes by agent id and prefers the
 * A5 projection (settings + live build) when that knows the agent, falling back
 * to the settings/metrics read for hosts that have no build projection yet.
 */
export function embeddingProductStatusReader(
  agentId: string | null | undefined,
): () => EmbeddingProductStatusSnapshot {
  const key = agentId ?? "";
  const existing = readersByAgent.get(key);
  if (existing !== undefined) return existing;
  const reader = (): EmbeddingProductStatusSnapshot => {
    const build =
      key.length === 0 ? null : readEmbeddingBuildStatusSnapshot(key);
    return build ?? readEmbeddingProductStatus();
  };
  readersByAgent.set(key, reader);
  return reader;
}

const readersByAgent = new Map<string, () => EmbeddingProductStatusSnapshot>();

export const EmbeddingStatusRow = memo(function EmbeddingStatusRow({
  width,
  readSnapshot = readEmbeddingProductStatus,
}: {
  /** The terminal's content columns; the renderer degrades within them. */
  width: number;
  /**
   * The status provider, defaulting to the real settings + metrics read. A
   * host (or a test) can swap it without touching the poll loop; the A5 build
   * hook will eventually supply the same shape with live progress.
   */
  readSnapshot?: () => EmbeddingProductStatusSnapshot;
}) {
  const [snapshot, setSnapshot] =
    useState<EmbeddingProductStatusSnapshot>(readSnapshot);

  useEffect(() => {
    const timer = setInterval(() => {
      setSnapshot((previous) => {
        const next = readSnapshot();
        return sameSnapshot(previous, next) ? previous : next;
      });
    }, EMBEDDING_STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [readSnapshot]);

  const line = renderEmbeddingSegment(snapshot, width, chalk);
  if (line.length === 0) return null;
  return (
    <Box>
      <Text>{line}</Text>
    </Box>
  );
});
