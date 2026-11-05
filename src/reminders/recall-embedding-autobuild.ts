/**
 * "Next turn embeds the previous turn" (48-1 §6.8 / §6.10, R-26).
 *
 * The build itself is A3's runner; what was missing is a caller that notices an
 * index is behind without the user running `/recall embedding build`. The turn
 * path asks this module once per recall turn (when embedding is on) and it:
 *
 * 1. cheaply decides whether anything is behind — a source file newer than its
 *    unit's `current.json`, or a unit that was never built (60 s memo);
 * 2. runs one **incremental** build in the background, at most once per
 *    cooldown, so a burst of turns cannot start a build per keystroke;
 * 3. never throws: a missing model, a held lock or a failed worker is logged and
 *    the turn continues.
 *
 * The trigger is deliberately one place rather than three: the TUI, headless
 * and the websocket listener all reach `runRecall` through the same engine
 * (`use-submit-handler`, `headless.ts`, `listener/turn-setup.ts`), so wiring it
 * here covers every host without touching a pinned orchestration file.
 *
 * Why "next turn" and not turn-end: the messages of the current turn are written
 * *after* recall runs, so a catch-up launched then would index a stale corpus.
 * At the next turn's start the previous turn is fully on disk. Idle backfill
 * (no turn at all) is a separate trigger and is not implemented here.
 *
 * Layer: `reminders/`. Imports `backend/local/` build modules and
 * `recall-settings`; no `cli/`, `websocket/` or `agent/` import.
 */

import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { createEmbeddingBuildEmbed } from "@/backend/local/embedding-build-embed";
import {
  resolveEmbeddingAgentMemoryDir,
  scanEmbeddingBuildUnits,
} from "@/backend/local/embedding-build-units";
import {
  embeddingVectorUnitDir,
  readEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import { memoryFileKey } from "@/backend/local/embedding-memory";
import { runEmbeddingBuild } from "@/backend/local/embedding-runner";
import { resolveEmbeddingSpace } from "@/backend/local/embedding-space";
import { readJsonFileOrUndefined } from "@/backend/local/local-transcript";
import { collectRecallFiles } from "@/backend/local/memory-search";
import {
  conversationDirectories,
  conversationSearchRecord,
} from "@/backend/local/transcript-search";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";

/** Minimum gap between two automatic builds (48-1 §6.8's "小批量" cadence). */
export const EMBEDDING_AUTOBUILD_COOLDOWN_MS = 5 * 60_000;

/** How long one "is anything behind" answer is reused. */
export const EMBEDDING_AUTOBUILD_CHECK_TTL_MS = 60_000;

/** The backend shape this module needs; `LocalBackend` satisfies it. */
export type EmbeddingAutobuildBackend = {
  getLocalStorageDir?: () => string;
};

/** Seams for the build itself; every field defaults to the production module. */
export interface EmbeddingAutobuildDeps {
  createEmbed?: typeof createEmbeddingBuildEmbed;
  runBuild?: typeof runEmbeddingBuild;
  scanUnits?: typeof scanEmbeddingBuildUnits;
}

export interface EmbeddingAutobuildInput {
  backend: EmbeddingAutobuildBackend;
  agentId: string;
  settings: ResolvedEmbeddingSettings;
  /** Vector root override; defaults to the call-time resolver. */
  root?: string;
  /** Clock seam (cooldown/memo); defaults to `Date.now`. */
  now?: () => number;
  /** Build seams; tests inject them so no worker is spawned. */
  deps?: EmbeddingAutobuildDeps;
}

let inFlight = false;
let lastAttemptAt = 0;
const behindMemo = new Map<string, { at: number; behind: boolean }>();

/** Test hook: forget the cooldown, the in-flight flag and the memo. */
export function resetRecallEmbeddingAutobuildForTests(): void {
  inFlight = false;
  lastAttemptAt = 0;
  behindMemo.clear();
}

/** Whether the settings describe a backend that can build at all. */
export function isEmbeddingAutobuildRequested(
  settings: ResolvedEmbeddingSettings,
): boolean {
  if (settings.enabled !== true) return false;
  if (settings.backend === "endpoint") return settings.endpoint !== null;
  return settings.backend === "builtin";
}

function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function pointerTimeMs(updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** One unit's source file, its pointer and whether the source is newer. */
function unitIsBehind(input: { unitDir: string; sourcePath: string }): boolean {
  const pointer = readEmbeddingIndexPointer(input.unitDir);
  // Never built, or a pointer we cannot trust: the builder is the fix.
  if (!pointer.ok) return true;
  const sourceMtime = fileMtimeMs(input.sourcePath);
  if (sourceMtime === undefined) return false;
  return sourceMtime > pointerTimeMs(pointer.pointer.updatedAt) + 1_000;
}

type BehindInput = {
  agentId: string;
  space: { spaceId: string; spaceDir: string };
  storageDir: string;
  memoryDir: string;
  root: string;
};

/**
 * Whether any unit's source changed after its committed generation.
 *
 * The filters mirror `listRecallEmbeddingUnits` / `scanEmbeddingBuildUnits`
 * (this agent, not hidden) so another agent's conversation cannot keep this
 * agent's index looking stale. A conversation with no readable record is
 * skipped: it is not part of the corpus either arm can answer from.
 */
export function isEmbeddingIndexBehind(input: BehindInput): boolean {
  for (const directory of conversationDirectories(input.storageDir)) {
    const record = conversationSearchRecord(
      readJsonFileOrUndefined(join(directory, "conversation.json")),
    );
    if (record === undefined) continue;
    if (record.hidden === true) continue;
    if (record.agent_id !== input.agentId) continue;
    const unitDir = embeddingVectorUnitDir(
      {
        agentId: input.agentId,
        spaceId: input.space.spaceId,
        conversationKey: basename(directory),
      },
      { root: input.root },
    );
    if (
      unitIsBehind({
        unitDir,
        sourcePath: join(directory, "messages.jsonl"),
      })
    ) {
      return true;
    }
  }

  for (const file of collectRecallFiles(input.memoryDir)) {
    const unitDir = embeddingVectorUnitDir(
      {
        agentId: input.agentId,
        spaceId: input.space.spaceId,
        memoryFileKey: memoryFileKey(file.path),
      },
      { root: input.root },
    );
    if (unitIsBehind({ unitDir, sourcePath: file.path })) return true;
  }
  return false;
}

function chunkOptionsOf(settings: ResolvedEmbeddingSettings): {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  maxChunksPerParent: number;
} {
  return {
    targetTokens: settings.chunkTarget,
    maxTokens: settings.chunkMax,
    overlapTokens: settings.chunkOverlap,
    maxChunksPerParent: settings.maxChunksPerMessage,
  };
}

type ResolvedAutobuild = {
  storageDir: string;
  memoryDir: string;
  space: ReturnType<typeof resolveEmbeddingSpace>;
  root: string;
};

function resolveAutobuildInput(
  input: EmbeddingAutobuildInput,
): ResolvedAutobuild | null {
  try {
    if (!isEmbeddingAutobuildRequested(input.settings)) return null;
    const storageDir = input.backend.getLocalStorageDir?.();
    if (typeof storageDir !== "string" || storageDir.length === 0) return null;
    const space = resolveEmbeddingSpace(input.agentId, input.settings, {
      ...(input.root === undefined ? {} : { root: input.root }),
    });
    return {
      storageDir,
      memoryDir: resolveEmbeddingAgentMemoryDir(storageDir, input.agentId),
      space,
      root: space.root,
    };
  } catch {
    return null;
  }
}

function behind(
  input: EmbeddingAutobuildInput,
  resolved: ResolvedAutobuild,
): boolean {
  const now = (input.now ?? Date.now)();
  const key = `${input.agentId}\u0000${resolved.space.spaceId}\u0000${resolved.storageDir}`;
  const memo = behindMemo.get(key);
  if (memo !== undefined && now - memo.at < EMBEDDING_AUTOBUILD_CHECK_TTL_MS) {
    return memo.behind;
  }
  let behindNow = false;
  try {
    behindNow = isEmbeddingIndexBehind({
      agentId: input.agentId,
      space: resolved.space,
      storageDir: resolved.storageDir,
      memoryDir: resolved.memoryDir,
      root: resolved.root,
    });
  } catch (error) {
    debugWarn(
      "recall",
      `embedding catch-up check failed: ${getErrorMessage(error)}`,
    );
  }
  behindMemo.set(key, { at: now, behind: behindNow });
  return behindNow;
}

async function runCatchUp(
  input: EmbeddingAutobuildInput,
  resolved: ResolvedAutobuild,
): Promise<void> {
  const deps = input.deps ?? {};
  const adapter = await (deps.createEmbed ?? createEmbeddingBuildEmbed)(
    input.settings,
  );
  try {
    const scanUnits = deps.scanUnits ?? scanEmbeddingBuildUnits;
    const runBuild = deps.runBuild ?? runEmbeddingBuild;
    const result = await runBuild({
      identity: {
        agentId: input.agentId,
        spaceId: resolved.space.spaceId,
      },
      modelId: resolved.space.modelId,
      dimensions: resolved.space.dimensions,
      quant: resolved.space.quantization,
      root: resolved.root,
      mode: "incremental",
      embed: adapter.embed,
      units: scanUnits({
        agentId: input.agentId,
        spaceId: resolved.space.spaceId,
        storageDir: resolved.storageDir,
        memoryDir: resolved.memoryDir,
        chunkOptions: chunkOptionsOf(input.settings),
      }),
    });
    debugWarn(
      "recall",
      `embedding catch-up ${result.status}: ${result.embeddedChunks} embedded, ${result.reusedChunks} reused`,
    );
  } finally {
    await adapter.dispose();
  }
}

/**
 * Run one catch-up if the index is behind and the cooldown allows it.
 *
 * Returns whether a build was started. Never throws: the caller is a turn.
 */
export async function runEmbeddingCatchUpIfBehind(
  input: EmbeddingAutobuildInput,
): Promise<boolean> {
  if (inFlight) return false;
  const resolved = resolveAutobuildInput(input);
  if (resolved === null) return false;
  const now = (input.now ?? Date.now)();
  if (now - lastAttemptAt < EMBEDDING_AUTOBUILD_COOLDOWN_MS) return false;
  // Claim the slot before any I/O: two turns arriving together must not both
  // decide "nothing is running".
  lastAttemptAt = now;
  inFlight = true;
  try {
    if (!behind(input, resolved)) return false;
    await runCatchUp(input, resolved);
    return true;
  } catch (error) {
    debugWarn(
      "recall",
      `embedding catch-up could not run: ${getErrorMessage(error)}`,
    );
    return false;
  } finally {
    inFlight = false;
  }
}

/**
 * The turn-path entry point: fire and forget.
 *
 * The turn must never wait on a build (48-1 §6.8: "不阻塞下一轮输入"). A
 * rejection is already handled inside the async body; this only guards the
 * promise itself.
 */
export function maybeScheduleEmbeddingCatchUp(
  input: EmbeddingAutobuildInput,
): void {
  void runEmbeddingCatchUpIfBehind(input).catch(() => undefined);
}
