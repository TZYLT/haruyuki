/**
 * `/recall embedding model` (48-4 D-09/D-12).
 *
 * A vector space is a directory named by a hash, so the only way to make it
 * selectable is the `profile.json` written at build time. This module reads the
 * directories, pairs each with its profile, and implements the four operations:
 *
 * - **list** — the table the TUI picker renders and the CLI prints;
 * - **select** — restore the settings that produced that space;
 * - **delete** — remove one directory (preview/confirm, active refused);
 * - **pin / unpin** — opt a space out of automatic retention.
 *
 * Legacy spaces (built before 48-4, no profile) are listable and deletable but
 * not selectable: their chunk window cannot be recovered, so restoring settings
 * would be a guess.
 *
 * Layer: `cli/helpers/`. Imports `backend/local/` and the settings writer.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getRecallVectorsRoot } from "@/backend/local/embedding-format";
import {
  type EmbeddingProfile,
  readEmbeddingProfile,
  setEmbeddingProfilePinned,
} from "@/backend/local/embedding-profile";
import {
  listEmbeddingSpaceDirs,
  resolveEmbeddingSpace,
} from "@/backend/local/embedding-space";
import { readEmbeddingSpaceSummary } from "@/backend/local/embedding-space-status";
import {
  type EmbeddingSettingsPatch,
  updateEmbeddingSettings,
} from "@/cli/app/pages/settings/embedding-settings";
import type { EmbeddingCommand } from "@/cli/commands/embedding-command-parser";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";

const NEEDS_AGENT =
  "Embedding recall needs an active agent for this action; pass --agent <id> or run it in a session.";

/** One selectable (or legacy) space, as the table renders it. */
export type EmbeddingModelRow = {
  /** 1-based row number used by `--select` / `--delete` / `--pin`. */
  index: number;
  spaceId: string;
  model: string;
  dimensions: number | null;
  quantization: string | null;
  chunks: number;
  builtAt: string | null;
  bytes: number | null;
  active: boolean;
  pinned: boolean;
  /** True when the space has no `profile.json` (pre-48-4 directory). */
  legacy: boolean;
};

function directoryBytes(dir: string): number | null {
  try {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = directoryBytes(path);
        if (nested !== null) total += nested;
      } else if (entry.isFile()) {
        total += statSync(path).size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

/** Every space on disk for one agent, active first, then newest. */
export async function listEmbeddingModels(input: {
  agentId: string;
  settings?: ResolvedEmbeddingSettings;
  root?: string;
}): Promise<EmbeddingModelRow[]> {
  const root = input.root ?? getRecallVectorsRoot();
  const settings = input.settings ?? readEmbeddingSettings();
  let active: string | null = null;
  try {
    active = resolveEmbeddingSpace(input.agentId, settings, { root }).spaceId;
  } catch {
    active = null;
  }

  const rows: EmbeddingModelRow[] = [];
  for (const dir of listEmbeddingSpaceDirs(input.agentId, { root })) {
    const summary = readEmbeddingSpaceSummary(dir.spaceDir);
    const profile = await readEmbeddingProfile(dir.spaceDir);
    rows.push({
      index: 0,
      spaceId: dir.spaceId,
      model: profile?.modelId ?? summary.modelId ?? "unknown",
      dimensions: summary.dimensions ?? profile?.dimensions ?? null,
      quantization: summary.quant ?? profile?.quantization ?? null,
      chunks: summary.chunks,
      builtAt: summary.builtAt,
      bytes: directoryBytes(dir.spaceDir),
      active: dir.spaceId === active,
      pinned: profile?.pinned === true,
      legacy: profile === null,
    });
  }
  rows.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return (right.builtAt ?? "").localeCompare(left.builtAt ?? "");
  });
  rows.forEach((row, position) => {
    row.index = position + 1;
  });
  return rows;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatEmbeddingModelTable(
  rows: readonly EmbeddingModelRow[],
): string {
  if (rows.length === 0) {
    return [
      "No vector models are stored yet.",
      "Connect one with /recall embedding connect.",
    ].join("\n");
  }
  const lines = [
    "#  model                     dims   precision  chunks  size     built                 flags",
  ];
  for (const row of rows) {
    const flags = [
      row.active ? "active" : "",
      row.pinned ? "pinned" : "",
      row.legacy ? "legacy" : "",
    ]
      .filter((flag) => flag.length > 0)
      .join(",");
    lines.push(
      `${String(row.index).padEnd(2)} ${row.model.padEnd(25)} ${String(row.dimensions ?? "?").padEnd(6)} ${String(row.quantization ?? "?").padEnd(10)} ${String(row.chunks).padEnd(7)} ${formatBytes(row.bytes).padEnd(8)} ${(row.builtAt ?? "never").padEnd(21)} ${flags}`,
    );
  }
  lines.push(
    "Enter selects (TUI), D deletes, P pins. CLI: --select/--delete/--pin <n>.",
  );
  return lines.join("\n");
}

function selectPatch(profile: EmbeddingProfile): EmbeddingSettingsPatch {
  return {
    enabled: true,
    backend: profile.backend,
    model: profile.modelId,
    ...(profile.endpoint === undefined
      ? {}
      : {
          endpoint: {
            kind: profile.endpoint.kind,
            baseUrl: profile.endpoint.baseUrl,
            model: profile.endpoint.model,
            dimensions: profile.endpoint.dimensions,
          },
        }),
    quantization: profile.quantization,
    chunkTarget: profile.chunkTarget,
    chunkMax: profile.chunkMax,
    chunkOverlap: profile.chunkOverlap,
    maxChunksPerMessage: profile.maxChunksPerMessage,
  };
}

function findRow(
  rows: readonly EmbeddingModelRow[],
  index: number | undefined,
): EmbeddingModelRow | null {
  if (index === undefined) return null;
  return rows.find((row) => row.index === index) ?? null;
}

/** Run one `model` command; the reply is the user-facing text. */
export async function handleEmbeddingModelCommand(
  command: Extract<EmbeddingCommand, { kind: "model" }>,
  agentId: string | null | undefined,
  options: { root?: string } = {},
): Promise<string> {
  if (!agentId || agentId.trim().length === 0) return NEEDS_AGENT;
  const root = options.root ?? getRecallVectorsRoot();
  const rows = await listEmbeddingModels({ agentId, root });

  if (command.action === "list") {
    return command.json
      ? JSON.stringify(
          rows.map(
            ({
              index,
              spaceId,
              model,
              dimensions,
              quantization,
              chunks,
              builtAt,
              bytes,
              active,
              pinned,
              legacy,
            }) => ({
              index,
              spaceId,
              model,
              dimensions,
              quantization,
              chunks,
              builtAt,
              bytes,
              active,
              pinned,
              legacy,
            }),
          ),
          null,
          2,
        )
      : formatEmbeddingModelTable(rows);
  }

  const row = findRow(rows, command.index);
  if (row === null) {
    return `There is no model #${command.index ?? "?"}. Run /recall embedding model to see the list.`;
  }
  const spaceDir = join(root, agentId, row.spaceId);

  if (command.action === "select") {
    const profile = await readEmbeddingProfile(spaceDir);
    if (profile === null) {
      return [
        `Model #${row.index} (${row.model}) was built before profiles existed.`,
        "Its chunk window cannot be recovered, so selecting it would be a guess. Run /recall embedding connect to add it again (the existing vectors are kept).",
      ].join("\n");
    }
    const updated = updateEmbeddingSettings(selectPatch(profile));
    return [
      `Selected model #${row.index} (${row.model}).`,
      `  ${updated.model} · ${updated.quantization} · chunk ${updated.chunkTarget}/${updated.chunkMax}/${updated.chunkOverlap}`,
      updated.enabled
        ? "  Vector recall is on."
        : "  Note: vector recall is off.",
    ].join("\n");
  }

  if (command.action === "delete") {
    if (row.active) {
      return [
        `Model #${row.index} is the active space; switch or turn vector recall off before deleting it.`,
        "Nothing was deleted.",
      ].join("\n");
    }
    if (!command.confirmed) {
      return [
        `This deletes model #${row.index} (${row.model}, ${row.chunks} chunks, ${formatBytes(row.bytes)}).`,
        "Transcripts, memory files and settings are untouched. Nothing was deleted. To confirm:",
        `  /recall embedding model --delete ${row.index} --confirm`,
      ].join("\n");
    }
    try {
      rmSync(spaceDir, { recursive: true, force: true });
    } catch (error) {
      return `Could not delete model #${row.index}: ${error instanceof Error ? error.message : String(error)}`;
    }
    return `Deleted model #${row.index} (${row.model}).`;
  }

  const pinned = command.action === "pin";
  if (row.legacy) {
    return `Model #${row.index} has no profile, so it cannot be pinned. Rebuild it once with /recall embedding build.`;
  }
  const written = await setEmbeddingProfilePinned(spaceDir, pinned);
  return written
    ? `${pinned ? "Pinned" : "Unpinned"} model #${row.index} (${row.model}).`
    : `Could not update the profile of model #${row.index}.`;
}
