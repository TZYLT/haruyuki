/**
 * Production wiring for feature 48's query arm (rework B).
 *
 * The pieces of the two-arm path already exist: `recall-vector-source.ts` turns
 * an encoder + a B2 index search + a parent reader into one `RecallSourcePort`
 * (E2), `recall-fusion.ts` merges the two arms (E1), and `runRecall` accepts an
 * optional `vectorSource`/`fusion` pair (E3). What was missing is the caller:
 * the turn path never built them, so every real turn stayed lexical-only
 * (48-3 §8.1, "集成待接"). This module is that caller's factory, and the only
 * place the live settings, the active space and the on-disk units meet.
 *
 * The contract this module keeps:
 *
 * 1. **Embedding off changes nothing.** When `recallEmbeddingEnabled` is not
 *    exactly `true` (or the configured backend cannot describe a space — an
 *    endpoint without its form), every entry point returns `null` before any
 *    filesystem access. The engine then calls `runRecall` with exactly the
 *    arguments it passed before this module existed, which is what keeps the
 *    embedding-off path bit for bit stable.
 * 2. **A construction failure is not a turn failure.** Nothing here throws: a
 *    missing space, an unreadable pointer, an unknown built-in model or a
 *    corrupt settings record all collapse to `null`, and the lexical arm still
 *    answers the turn (invariant I7).
 * 3. **The space is the settings' space, not a guess.** `resolveEmbeddingSpace`
 *    (A1) derives the directory from every input that can change a vector
 *    (model, width, precision, chunking), so a query can never scan an index
 *    built by a different configuration.
 * 4. **The units are the ones the builder writes.** Conversations are listed
 *    from the space directory, but only for conversation directories that still
 *    exist in the store (a deleted conversation's index must not be loaded on
 *    every turn). Memory files are listed from the live workspace through
 *    `collectRecallFiles` — the same corpus definition `buildMemoryVectorPlan`
 *    uses — because a unit directory is named by a one-way `fileKey` hash and
 *    the injection side needs the path itself to re-read the parent (B4).
 *
 * Layer: `reminders/`. Imports the `backend/local/` embedding modules and
 * `recall-settings`; it must not import `cli/` or `websocket/`.
 */

import { type Dirent, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createAnnAwareIndexSearch } from "@/backend/local/embedding-ann-search";
import {
  createEmbeddingQueryEncoder,
  type EmbeddingQueryEncoder,
} from "@/backend/local/embedding-encoder";
import {
  EMBEDDING_MEMORY_DIR_NAME,
  readEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import { memoryFileKey } from "@/backend/local/embedding-memory";
import {
  type EmbeddingSpaceIdentity,
  resolveEmbeddingSpace,
} from "@/backend/local/embedding-space";
import { hasUsableEmbeddingSpace } from "@/backend/local/embedding-space-status";
import { readJsonFileOrUndefined } from "@/backend/local/local-transcript";
import { collectRecallFiles } from "@/backend/local/memory-search";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import {
  conversationDirectories,
  conversationSearchRecord,
} from "@/backend/local/transcript-search";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
  readRecallSettings,
} from "@/recall-settings";
import {
  RECALL_FUSION_DEFAULTS,
  type RecallFusionOptions,
} from "./recall-fusion";
import type { RecallSourcePort } from "./recall-port";
import {
  createEmbeddingIndexSearch,
  createLocalVectorParentPort,
  createVectorRecallSource,
  type RecallEncoderPort,
  type RecallVectorSearchPort,
  type RecallVectorUnit,
  VECTOR_RECALL_DEFAULT_BUDGET_MS,
  VECTOR_RECALL_MIN_COSINE,
} from "./recall-vector-source";

/** One safe path component for a unit directory; same rule as the writer. */
const SAFE_UNIT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The two things `runRecall` needs to run the vector arm. */
export type RecallEmbeddingArms = {
  vectorSource: RecallSourcePort;
  fusion: RecallFusionOptions;
};

/** Input for {@link createRecallEmbeddingArms}. */
export type CreateRecallEmbeddingArmsInput = {
  agentId: string;
  /** Resolved D3 settings; the caller reads them once per turn. */
  settings: ResolvedEmbeddingSettings;
  /** Local-backend storage root: the directory holding `conversations/`. */
  storageDir: string;
  /** The agent's memory workspace root; see `getLocalBackendMemoryFilesystemRoot`. */
  memoryDir: string;
  /**
   * Vector root override. Defaults to `resolveEmbeddingSpace`'s own default
   * (`<harness home>/recall-vectors`); tests pass a temp directory.
   */
  root?: string;
  /**
   * Test/probe seam: a ready encoder. Production omits it and gets
   * `createEmbeddingQueryEncoder(settings)`, whose built-in form starts its
   * worker lazily on the first encode.
   */
  encoder?: EmbeddingQueryEncoder;
  /**
   * Test seam for the per-agent encoder cache: builds the encoder when the
   * agent's configuration changes. Production omits it.
   */
  encoderFactory?: (
    settings: ResolvedEmbeddingSettings,
  ) => EmbeddingQueryEncoder;
  /** Clock for the arm's own budget; tests inject one so nothing waits. */
  now?: () => number;
  /**
   * Relative score floor applied to the fused result (48-4 D-06). Defaults to
   * `readRecallSettings().minScoreRatio`, the same knob the lexical arm uses.
   */
  minScoreRatio?: number;
};

/**
 * The production factory: resolve the space, list its usable units and build
 * the vector source plus the fusion tunables.
 *
 * Returns `null` when embedding recall is off, the backend is not configured
 * well enough to describe a space, the space has no usable unit, or anything
 * goes wrong while reading them. The `null` cases are deliberately
 * indistinguishable to the caller: all of them mean "keep the lexical arm".
 */
export function createRecallEmbeddingArms(
  input: CreateRecallEmbeddingArmsInput,
): RecallEmbeddingArms | null {
  if (!isRecallEmbeddingArmsRequested(input.settings)) return null;
  let space: EmbeddingSpaceIdentity;
  try {
    space = resolveEmbeddingSpace(input.agentId, input.settings, {
      ...(input.root === undefined ? {} : { root: input.root }),
    });
  } catch {
    // An unsafe agent id, an unknown built-in model or an endpoint whose form
    // does not describe a width: the query path cannot pin a space, so the
    // turn stays lexical. A configuration error is reported by the settings
    // surface, not by silently searching the wrong directory.
    return null;
  }

  try {
    if (!hasUsableEmbeddingSpace(space.spaceDir)) return null;
    const units = listRecallEmbeddingUnits({
      agentId: input.agentId,
      spaceDir: space.spaceDir,
      storageDir: input.storageDir,
      memoryDir: input.memoryDir,
    });
    if (units.length === 0) {
      // Every unit is stale (or belongs to a conversation/memory file that no
      // longer exists): there is nothing the arm could legitimately answer, so
      // do not make it pay an encode per turn to find that out.
      return null;
    }

    const encoder =
      input.encoder ??
      sharedQueryEncoder(input.agentId, input.settings, input.encoderFactory);
    const vectorSource = createVectorRecallSource({
      encoder: encoder as RecallEncoderPort,
      search: createSpaceSearch(space, units),
      parentReader: createLocalVectorParentPort({
        storageDir: input.storageDir,
        memoryDir: input.memoryDir,
      }),
      topK: input.settings.candidateDepth,
      // 48-2 §4.5: derive the arm's budget from the measured p90 (×40, clamped
      // 50–300 ms) instead of the fixed 300. The turn's own deadline stays the
      // outer authority: a vector result that arrives after it is dropped by
      // `recall-service`, so this can only ever shorten the arm.
      budgetMs: vectorArmBudgetMs(input.settings),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return {
      vectorSource,
      fusion: recallFusionOptionsFor(input.settings, input.minScoreRatio),
    };
  } catch {
    return null;
  }
}

/**
 * The query port for one space.
 *
 * A float32 space uses A6: below the ANN trigger it runs the same flat scan
 * (a missing sidecar is the normal flat path), above it reads the sidecar the
 * build wrote. A6 has no score floor of its own, so the arm's cosine safety
 * valve is applied here to the same parent score B2 filters on. An int8-only
 * space keeps the code-scoring B2 reader: the sidecar format carries float32
 * vectors, and an int8 space has no float32 view to build one from.
 */
function createSpaceSearch(
  space: EmbeddingSpaceIdentity,
  units: readonly RecallVectorUnit[],
): RecallVectorSearchPort {
  const expectation = { quant: space.quantization };
  if (space.quantization === "int8") {
    return createEmbeddingIndexSearch({
      space: { agentId: space.agentId, spaceId: space.spaceId },
      root: space.root,
      units,
      expectation,
    });
  }
  const ann = createAnnAwareIndexSearch({
    space: { agentId: space.agentId, spaceId: space.spaceId },
    units,
    root: space.root,
    expectation,
  });
  return (input) => {
    const result = ann(input);
    if (result.status !== "searched") return result;
    return {
      ...result,
      hits: result.hits.filter(
        (hit) => hit.hit.score >= VECTOR_RECALL_MIN_COSINE,
      ),
    };
  };
}

/** Input for {@link maybeCreateRecallEmbeddingArms}. */
export type MaybeCreateRecallEmbeddingArmsInput = {
  /**
   * The live backend. Only the local backend can answer `getLocalStorageDir`;
   * the API-shaped backend has no local store, so it yields no arms.
   */
  backend: RecallEmbeddingArmsBackend;
  agentId: string;
  /** Resolved settings; defaults to `readEmbeddingSettings()`. */
  settings?: ResolvedEmbeddingSettings;
  /** Test seam forwarded to {@link createRecallEmbeddingArms}. */
  encoder?: EmbeddingQueryEncoder;
  /** Vector root override forwarded to {@link createRecallEmbeddingArms}. */
  root?: string;
  /** Clock override forwarded to {@link createRecallEmbeddingArms}. */
  now?: () => number;
  /** Fusion floor override; defaults to the recall settings value. */
  minScoreRatio?: number;
};

/**
 * The narrow backend shape this module needs.
 *
 * Structural rather than `LocalBackend` so the reminders layer does not have to
 * import the local backend class (and the store it drags in) on a path that is
 * off by default; `LocalBackend` satisfies it as-is.
 */
export type RecallEmbeddingArmsBackend = {
  getLocalStorageDir?: () => string;
};

/**
 * The vector arm's wall-clock budget (48-2 §4.5).
 *
 * `p90 × 40` clamped to 50–300 ms, falling back to the documented 300 ms cap
 * when no calibration was recorded. The turn deadline (`timeout`, default
 * 1,000 ms) remains the outer authority; this budget only bounds one phase.
 */
export function vectorArmBudgetMs(settings: ResolvedEmbeddingSettings): number {
  const p90 = settings.calibration?.queryLatencyP90Ms;
  if (typeof p90 === "number" && Number.isFinite(p90) && p90 > 0) {
    return Math.min(300, Math.max(50, Math.round(p90 * 40)));
  }
  return VECTOR_RECALL_DEFAULT_BUDGET_MS;
}

/**
 * The engine/probe entry point: resolve the agent's storage and memory roots
 * from the backend and build the arms.
 *
 * Never throws. A non-local backend, an unreadable settings record, an unsafe
 * agent id and an unusable space are all `null`.
 */
export function maybeCreateRecallEmbeddingArms(
  input: MaybeCreateRecallEmbeddingArmsInput,
): RecallEmbeddingArms | null {
  try {
    const storageDir = input.backend.getLocalStorageDir?.();
    if (typeof storageDir !== "string" || storageDir.length === 0) return null;
    const settings = input.settings ?? readEmbeddingSettings();
    if (!isRecallEmbeddingArmsRequested(settings)) return null;
    return createRecallEmbeddingArms({
      agentId: input.agentId,
      settings,
      storageDir,
      memoryDir: getLocalBackendMemoryFilesystemRoot(input.agentId, storageDir),
      ...(input.root === undefined ? {} : { root: input.root }),
      ...(input.encoder === undefined ? {} : { encoder: input.encoder }),
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.minScoreRatio === undefined
        ? {}
        : { minScoreRatio: input.minScoreRatio }),
    });
  } catch {
    return null;
  }
}

/**
 * Whether the settings ask for the vector arm *and* describe a space.
 *
 * Pure, exported so the settings/probe surfaces and the tests can assert the
 * decision without touching the filesystem. `enabled` must be exactly `true`:
 * feature 48's default is off, and a hand-edited settings value must not start
 * an encoder.
 */
export function isRecallEmbeddingArmsRequested(
  settings: ResolvedEmbeddingSettings,
): boolean {
  if (settings.enabled !== true) return false;
  if (settings.backend === "endpoint") return settings.endpoint !== null;
  return settings.backend === "builtin";
}

/** One live query encoder per agent, tagged with the configuration it serves. */
type SharedQueryEncoder = {
  key: string;
  encoder: EmbeddingQueryEncoder;
};

const sharedEncodersByAgent = new Map<string, SharedQueryEncoder>();

/**
 * Everything about a settings record that decides which worker/model serves a
 * query. The agent is the map key, so it is deliberately absent here.
 */
function encoderConfigurationKey(settings: ResolvedEmbeddingSettings): string {
  if (settings.backend === "endpoint") {
    const endpoint = settings.endpoint;
    return JSON.stringify([
      "endpoint",
      endpoint?.kind ?? "",
      endpoint?.baseUrl ?? "",
      endpoint?.model ?? "",
      endpoint?.dimensions ?? 0,
    ]);
  }
  return JSON.stringify(["builtin", settings.model, settings.threads]);
}

/**
 * The process-wide encoder for one agent, rebuilt only when the configuration
 * changes.
 *
 * The turn path asks for arms once per turn. Creating a fresh encoder each time
 * acquired a new reference on the shared worker and never released it, so the
 * refcount grew without bound and a settings change left the old worker (its
 * entry, model and RSS) alive for the life of the process. Keeping one handle
 * per agent makes the reference stable and lets the previous configuration be
 * shut down when the user switches model or backend.
 */
function sharedQueryEncoder(
  agentId: string,
  settings: ResolvedEmbeddingSettings,
  factory:
    | ((settings: ResolvedEmbeddingSettings) => EmbeddingQueryEncoder)
    | undefined,
): EmbeddingQueryEncoder {
  const key = encoderConfigurationKey(settings);
  const existing = sharedEncodersByAgent.get(agentId);
  if (existing !== undefined && existing.key === key) return existing.encoder;
  if (existing !== undefined) {
    sharedEncodersByAgent.delete(agentId);
    // A turn still holding the old handle degrades to lexical recall; the
    // alternative is leaking one worker per configuration for the process life.
    void existing.encoder.dispose().catch(() => undefined);
  }
  const encoder = factory?.(settings) ?? createEmbeddingQueryEncoder(settings);
  sharedEncodersByAgent.set(agentId, { key, encoder });
  return encoder;
}

/**
 * Drop every shared query encoder and stop its worker. Tests call this between
 * cases so a fake or a previous model can never serve the next one.
 */
export async function resetRecallEmbeddingArmsEncoderCacheForTests(): Promise<void> {
  const encoders = [...sharedEncodersByAgent.values()];
  sharedEncodersByAgent.clear();
  await Promise.allSettled(encoders.map((entry) => entry.encoder.dispose()));
}

/**
 * The fusion tunables for a settings record.
 *
 * `vectorWeight`, the per-arm depth and the relative floor are all the user's:
 * the first two from the embedding record, the floor from `/recall config
 * ratio` (48-4 D-06), so one value governs both the lexical arm and fusion.
 */
export function recallFusionOptionsFor(
  settings: ResolvedEmbeddingSettings,
  minScoreRatio: number = readRecallSettings().minScoreRatio,
): RecallFusionOptions {
  return {
    vectorWeight: settings.weight,
    k: RECALL_FUSION_DEFAULTS.k,
    minScoreRatio,
    candidateDepth: settings.candidateDepth,
  };
}

/** Input for {@link listRecallEmbeddingUnits}. */
export type ListRecallEmbeddingUnitsInput = {
  agentId: string;
  /** `<root>/<agentId>/<spaceId>` from `resolveEmbeddingSpace`. */
  spaceDir: string;
  /** Local-backend storage root: the directory holding `conversations/`. */
  storageDir: string;
  /** The agent's memory workspace root. */
  memoryDir: string;
};

/**
 * Every unit of one space that can answer a query right now.
 *
 * A unit counts when `current.json` parses (`readEmbeddingIndexPointer`), which
 * is the same "can the query path find anything" test the status surface uses,
 * *and* its conversation is still part of the corpus the lexical arm searches:
 * it has a readable `conversation.json`, belongs to this agent and is not
 * hidden. The builder and `loadRecallCorpus` apply those same filters, so an
 * index left behind by a conversation that was deleted or hidden after its build
 * cannot make the vector arm answer from a corpus the lexical arm refuses.
 *
 * The listing is a *view*, not a build: it never reads vectors and never writes.
 * Ordering is deterministic (conversation keys, then memory paths, both code-unit
 * sorted) so a partial scan under budget pressure is reproducible.
 */
export function listRecallEmbeddingUnits(
  input: ListRecallEmbeddingUnitsInput,
): RecallVectorUnit[] {
  const conversations: { conversationKey: string; conversationId: string }[] =
    [];
  const spaceEntries = readDirectoryEntries(input.spaceDir);
  if (spaceEntries.length > 0) {
    const live = new Set(
      conversationDirectories(input.storageDir).map((directory) =>
        basename(directory),
      ),
    );
    for (const entry of spaceEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === EMBEDDING_MEMORY_DIR_NAME) continue;
      if (!SAFE_UNIT_SEGMENT.test(entry.name)) continue;
      if (!live.has(entry.name)) continue;
      if (!readEmbeddingIndexPointer(join(input.spaceDir, entry.name)).ok) {
        continue;
      }
      const conversationDir = join(
        input.storageDir,
        "conversations",
        entry.name,
      );
      const conversation = conversationSearchRecord(
        readJsonFileOrUndefined(join(conversationDir, "conversation.json")),
      );
      if (conversation === undefined) continue;
      if (conversation.hidden === true) continue;
      if (conversation.agent_id !== input.agentId) continue;
      // The record id travels with the unit so the query arm can tell "this is
      // the conversation the turn is running in" and apply the same in-context
      // exclusion as the lexical arm (48-1 §6.2 item 9). It is read here anyway
      // to filter hidden conversations, so carrying it costs nothing.
      conversations.push({
        conversationKey: entry.name,
        conversationId: conversation.id,
      });
    }
    conversations.sort((left, right) =>
      compareCodeUnits(left.conversationKey, right.conversationKey),
    );
  }

  const units: RecallVectorUnit[] = conversations.map(
    ({ conversationKey, conversationId }) => ({
      kind: "transcript",
      conversationKey,
      conversationId,
    }),
  );

  // The memory side is enumerated from the workspace, not from the space
  // directory: the unit name is `memoryFileKey(path)`, a one-way hash, while the
  // injection mapper must re-read the parent from its real path. `collectRecall
  // Files` is the corpus definition the builder used, so a unit and its live
  // file can never disagree about which path a hit belongs to.
  const memoryUnitsDir = join(input.spaceDir, EMBEDDING_MEMORY_DIR_NAME);
  const memoryFiles = collectRecallFiles(input.memoryDir);
  for (const file of memoryFiles) {
    const fileKey = memoryFileKey(file.path);
    if (!readEmbeddingIndexPointer(join(memoryUnitsDir, fileKey)).ok) continue;
    units.push({ kind: "memory", file: file.path, memoryFileKey: fileKey });
  }
  return units;
}

function readDirectoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Code-unit order, never locale order: the listing must not move per process. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
