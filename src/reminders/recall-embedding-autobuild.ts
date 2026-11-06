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
 * At the next turn's start the previous turn is fully on disk.
 *
 * **Cooldown-expiry self-check** (48-3 §13.10-1, user ruling 2026-11-06). A turn
 * is not always followed by another turn, and a build can finish while messages
 * landed during it, so a catch-up blocked by the cooldown/in-flight window would
 * leave the index behind until the user happens to send another message. The
 * turn-end entry therefore also arms *one* deferred self-check at the moment the
 * cooldown expires: it re-reads the settings, asks the same "is anything behind"
 * question, and runs one more incremental build only if the answer is yes. The
 * chain stops when the index is caught up, when embedding is turned off, when a
 * build fails, and after {@link EMBEDDING_AUTOBUILD_IDLE_MAX_CHECKS} fires.
 * This is **not** an idle-window probe (no timer runs while nothing is pending).
 *
 * CPU discipline: the armed callback only stats source files and, when behind,
 * starts the same background build a turn would; the timer fires at most once
 * per cooldown and a build holds A3's lock, so neither the keystroke path nor
 * streaming output gains a second consumer of that build's worker. The timer is
 * `unref()`ed, so a pending self-check never keeps the process alive.
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
import {
  type EmbeddingRunResult,
  runEmbeddingBuild,
} from "@/backend/local/embedding-runner";
import { resolveEmbeddingSpace } from "@/backend/local/embedding-space";
import { readJsonFileOrUndefined } from "@/backend/local/local-transcript";
import { collectRecallFiles } from "@/backend/local/memory-search";
import {
  conversationDirectories,
  conversationSearchRecord,
} from "@/backend/local/transcript-search";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";

/** Minimum gap between two automatic builds (48-1 §6.8's "小批量" cadence). */
export const EMBEDDING_AUTOBUILD_COOLDOWN_MS = 5 * 60_000;

/** How long one "is anything behind" answer is reused. */
export const EMBEDDING_AUTOBUILD_CHECK_TTL_MS = 60_000;

/**
 * Hard cap on one chain of cooldown-expiry self-checks.
 *
 * A chain re-arms only after a build ran, so a healthy sequence is "build, then
 * one verification". The cap is the backstop for a build that keeps reporting
 * success while the index stays behind (a measurement bug would otherwise loop
 * one build per cooldown for as long as the process lives).
 */
export const EMBEDDING_AUTOBUILD_IDLE_MAX_CHECKS = 3;

/** Timer seam for the deferred self-check; tests inject a fake one. */
export interface EmbeddingAutobuildTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** The process timers, called through so a test can count them. */
const REAL_AUTOBUILD_TIMERS: EmbeddingAutobuildTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** The backend shape this module needs; `LocalBackend` satisfies it. */
export type EmbeddingAutobuildBackend = {
  getLocalStorageDir?: () => string | undefined;
};

/** Seams for the build itself; every field defaults to the production module. */
export interface EmbeddingAutobuildDeps {
  createEmbed?: typeof createEmbeddingBuildEmbed;
  runBuild?: typeof runEmbeddingBuild;
  scanUnits?: typeof scanEmbeddingBuildUnits;
  /**
   * Settings re-read when the deferred self-check fires. A turn captures the
   * settings it saw, but the user can turn embedding off during the cooldown;
   * that must stop the build, not merely the next turn.
   */
  readSettings?: () => ResolvedEmbeddingSettings;
  /** Timer seam for the deferred self-check; defaults to the process timers. */
  timers?: EmbeddingAutobuildTimers;
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
/** The single pending cooldown-expiry timer; at most one chain exists. */
let idleTimer: unknown = null;
/** The timer seam that created {@link idleTimer} (needed to cancel it). */
let idleTimers: EmbeddingAutobuildTimers | null = null;
/** Fires so far in the current chain (reset by every turn-end scheduling). */
let idleChain = 0;

/** Test hook: forget the cooldown, the in-flight flag, the memo and any timer. */
export function resetRecallEmbeddingAutobuildForTests(): void {
  inFlight = false;
  lastAttemptAt = 0;
  behindMemo.clear();
  cancelScheduledEmbeddingSelfCheck();
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
): Promise<EmbeddingRunResult> {
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
    return result;
  } finally {
    await adapter.dispose();
  }
}

/**
 * What one catch-up attempt did.
 *
 * `built`/`failed` mean a build **ran**; `failed` only says its result was not
 * `completed`, which stops the idle chain rather than letting it retry forever.
 * `errored` means the attempt threw before the runner answered (a missing
 * model, a failing adapter). `not_behind` is the caught-up answer; `blocked` is
 * the cooldown/in-flight/feature-off answer.
 */
export type EmbeddingCatchUpOutcome =
  | "built"
  | "failed"
  | "errored"
  | "not_behind"
  | "blocked";

/** One catch-up attempt, classified; never throws. */
export async function runEmbeddingCatchUp(
  input: EmbeddingAutobuildInput,
): Promise<EmbeddingCatchUpOutcome> {
  if (inFlight) return "blocked";
  const resolved = resolveAutobuildInput(input);
  if (resolved === null) return "blocked";
  const now = (input.now ?? Date.now)();
  if (now - lastAttemptAt < EMBEDDING_AUTOBUILD_COOLDOWN_MS) return "blocked";
  // Claim the slot before any I/O: two turns arriving together must not both
  // decide "nothing is running".
  lastAttemptAt = now;
  inFlight = true;
  try {
    if (!behind(input, resolved)) return "not_behind";
    const result = await runCatchUp(input, resolved);
    return result.status === "failed" ? "failed" : "built";
  } catch (error) {
    debugWarn(
      "recall",
      `embedding catch-up could not run: ${getErrorMessage(error)}`,
    );
    return "errored";
  } finally {
    inFlight = false;
  }
}

/**
 * Run one catch-up if the index is behind and the cooldown allows it.
 *
 * Returns whether a build was attempted. Never throws: the caller is a turn.
 */
export async function runEmbeddingCatchUpIfBehind(
  input: EmbeddingAutobuildInput,
): Promise<boolean> {
  const outcome = await runEmbeddingCatchUp(input);
  return outcome === "built" || outcome === "failed";
}

// ── Cooldown-expiry self-check (the no-next-turn case) ─────────────────────

/** Hand the timer back to the event loop: `unref()` when the platform has it. */
function unrefTimer(handle: unknown): void {
  const candidate = handle as { unref?: () => void } | null;
  if (candidate !== null && typeof candidate.unref === "function") {
    candidate.unref();
  }
}

function timersOf(input: EmbeddingAutobuildInput): EmbeddingAutobuildTimers {
  return input.deps?.timers ?? REAL_AUTOBUILD_TIMERS;
}

/**
 * Cancel the pending self-check and end its chain.
 *
 * Called when the feature is turned off, by a new turn-end (which re-arms with
 * the new cooldown) and by the test hook.
 */
export function cancelScheduledEmbeddingSelfCheck(): void {
  if (idleTimer !== null && idleTimers !== null) {
    idleTimers.clearTimeout(idleTimer);
  }
  idleTimer = null;
  idleTimers = null;
  idleChain = 0;
}

function armIdleSelfCheck(input: EmbeddingAutobuildInput): void {
  // One chain, one timer: re-arming replaces the pending deadline (the cooldown
  // may have moved) instead of leaving a second wake-up behind.
  if (idleTimer !== null && idleTimers !== null) {
    idleTimers.clearTimeout(idleTimer);
  }
  const timers = timersOf(input);
  const now = (input.now ?? Date.now)();
  const remaining = Math.max(
    0,
    lastAttemptAt + EMBEDDING_AUTOBUILD_COOLDOWN_MS - now,
  );
  const handle = timers.setTimeout(() => {
    idleTimer = null;
    idleTimers = null;
    void runEmbeddingIdleSelfCheckOnce(input).catch(() => undefined);
  }, remaining);
  // A pending self-check must never keep the process alive (48-3 §13.10-1):
  // the next launch's turn-end arms it again.
  unrefTimer(handle);
  idleTimer = handle;
  idleTimers = timers;
}

/**
 * Turn-end entry point: arm the cooldown-expiry self-check.
 *
 * It is armed only when an attempt actually claimed the cooldown slot
 * (`lastAttemptAt`); a feature-off or misconfigured backend has nothing to
 * verify. A second turn-end replaces the pending check instead of stacking one,
 * because the new attempt moved the deadline. Turning embedding off cancels it.
 */
export function scheduleEmbeddingIdleSelfCheck(
  input: EmbeddingAutobuildInput,
): void {
  cancelScheduledEmbeddingSelfCheck();
  if (!isEmbeddingAutobuildRequested(input.settings)) return;
  if (lastAttemptAt === 0) return;
  armIdleSelfCheck(input);
}

/**
 * One deferred self-check tick (the timer body).
 *
 * Re-arms only when a build ran (the "still behind after the build" case) or
 * when a build was still in flight; a caught-up answer, a disabled feature and
 * any failure end the chain. The failure rule is what keeps a broken build from
 * becoming a retry storm: one attempt, then silence until the next turn.
 */
async function runEmbeddingIdleSelfCheckOnce(
  input: EmbeddingAutobuildInput,
): Promise<boolean> {
  idleChain += 1;
  try {
    const settings = (input.deps?.readSettings ?? readEmbeddingSettings)();
    if (!isEmbeddingAutobuildRequested(settings)) return false;
    const next: EmbeddingAutobuildInput = { ...input, settings };
    if (inFlight) {
      // The previous build outlived its cooldown; look again once it is over.
      return rearmIfAllowed(next);
    }
    const outcome = await runEmbeddingCatchUp(next);
    if (outcome !== "built") return false;
    return rearmIfAllowed(next);
  } catch (error) {
    debugWarn(
      "recall",
      `embedding idle self-check failed: ${getErrorMessage(error)}`,
    );
    return false;
  }
}

function rearmIfAllowed(input: EmbeddingAutobuildInput): boolean {
  if (idleChain >= EMBEDDING_AUTOBUILD_IDLE_MAX_CHECKS) return false;
  armIdleSelfCheck(input);
  return true;
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
