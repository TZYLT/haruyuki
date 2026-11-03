/**
 * Feature 48's vector recall arm (package E2).
 *
 * The lexical arm searches two corpora with BM25 and never awaits. The vector
 * arm is the other half of the same turn: it encodes the raw query, asks the
 * space's B2 indexes for parent-level hits, and maps those hits back onto the
 * same injectable units the lexical arm reports. Everything it hands the
 * service is an ordinary {@link RecallSourcePort}, so the service sees one more
 * source and learns nothing about encoders, spaces or vectors.
 *
 * Three contracts are load-bearing here and are easy to break later:
 *
 * 1. **The arm keeps its own budget** (`VECTOR_RECALL_DEFAULT_BUDGET_MS`,
 *    injected in tests through `now`). A turn that runs out of *its* budget
 *    returns what it has with a `degraded` diagnostic; it must never report
 *    `timedOut`, because `timedOut` is the breaker's verdict (`recall-runtime.ts`)
 *    and belongs to the lexical arm only (48-2 §4.7; `recall-service.ts` freezes
 *    it at the phase boundary).
 * 2. **Failure is a diagnostic, not a throw** (invariant I7): an unavailable
 *    encoder, an unusable space, a drifted parent and a spent budget all become
 *    one status the service already knows how to render.
 * 3. **Identity does not change.** A candidate's `source` stays
 *    `transcript|memory` and its `fingerprint` is the lexical one (48-2 §4.3),
 *    so dedup, the relative threshold and RRF keep their existing keys. Only the
 *    optional `arm`/`focusChar`/`chunkIndex` fields distinguish the arm.
 *
 * Layer: `reminders/`. It imports `backend/local/` modules for the index, the
 * injection mapping (B4) and the parent reads; it must not import `cli/` or
 * `websocket/`.
 */

import { join } from "node:path";
import {
  type EmbeddingIndexExpectation,
  loadEmbeddingIndex,
} from "@/backend/local/embedding-cache";
import {
  type EmbeddingVectorUnit,
  embeddingVectorUnitDir,
  getRecallVectorsRoot,
} from "@/backend/local/embedding-format";
import {
  normalizeMemoryPath,
  parseMemoryVectorParentId,
  readMemoryVectorParentText,
} from "@/backend/local/embedding-memory";
import {
  EMBEDDING_SEARCH_DEFAULT_TOP_K,
  type EmbeddingSearchHit,
  searchEmbeddingIndex,
} from "@/backend/local/embedding-search";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { readRecallMessageTexts } from "@/backend/local/recall-snippets";
import { createRecallDeadline, type RecallDeadline } from "./recall-deadline";
import type {
  RecallCandidate,
  RecallScope,
  RecallSourceOutcome,
  RecallSourcePort,
  RecallSourceRequest,
  RecallSourceStatus,
} from "./recall-port";
import {
  buildMemoryVectorCandidates,
  buildTranscriptVectorCandidates,
  createTranscriptVectorParentReader,
  type RecallVectorCandidate,
  type RecallVectorParent,
  VECTOR_INJECTION_MAX_CHARS,
} from "./recall-sources";

/**
 * One vector arm's candidate depth (48-2 §4.7: "每臂候选 50"). Both arms are cut
 * to the same depth by fusion, and the requirement forbids unequal depths.
 */
export const VECTOR_RECALL_DEFAULT_TOP_K = EMBEDDING_SEARCH_DEFAULT_TOP_K;

/**
 * The arm's own wall-clock budget.
 *
 * 48-1 §6.6 gives the query arm a p95 target of 100 ms and a hard cap of 300 ms;
 * a turn has 1,000 ms in total, and the lexical arm's verdict is already frozen
 * before this arm starts. `0` disables the budget, the same convention the
 * turn's deadline uses (the deadline itself rejects negatives).
 */
export const VECTOR_RECALL_DEFAULT_BUDGET_MS = 300;

/**
 * Queries shorter than this with no parsed terms skip the arm (48-1 O-10).
 *
 * Encoding "嗯嗯" costs a round trip and returns a vector with no information;
 * the lexical arm still sees it. The rule is only applied when the query parser
 * produced no terms at all, because "无实体" is not something this module can
 * decide — the parser is.
 */
export const VECTOR_RECALL_MIN_QUERY_CHARS = 6;

/** Lines of context a vector memory hit injects on each side (48-1 §6.2). */
export const VECTOR_RECALL_MEMORY_EXCERPT_LINES = 2;

/**
 * Encodes a query for the vector arm.
 *
 * A3/integration adapts the runtime clients to this shape:
 * - C3 `EmbeddingWorkerClient.embedOne(text)` already returns
 *   `Promise<Float32Array | null>` — it can be used directly.
 * - C6 `EmbeddingEndpointClient.embed([text])` returns
 *   `Promise<readonly Float32Array[]>` and throws on failure — adapt with
 *   `async (text) => (await client.embed([text]))[0] ?? null`.
 *
 * `null` means "the encoder cannot answer" (degraded to lexical); a thrown error
 * means "the encoder failed" (also degraded, with the message as the reason).
 * Neither aborts the turn. `encodeBatch` is optional future surface: the query
 * path embeds exactly one sentence, and bag-of-terms batch encoding would throw
 * away the sentence the model was trained on.
 */
export type RecallEncoderPort = {
  /** Stable label for diagnostics, e.g. `worker:bge-small-zh`. */
  readonly id?: string;
  encodeQuery(text: string): Promise<Float32Array | null>;
  encodeBatch?(
    texts: readonly string[],
  ): Promise<readonly (Float32Array | null)[]>;
};

/** One unit of a vector space: a transcript conversation or a memory file. */
export type RecallVectorUnit =
  | { kind: "transcript"; conversationKey: string }
  | { kind: "memory"; file: string; memoryFileKey: string };

/** One B2 parent-level hit, tagged with the unit that produced it. */
export type RecallVectorSearchHit =
  | { kind: "transcript"; conversationKey: string; hit: EmbeddingSearchHit }
  | { kind: "memory"; file: string; hit: EmbeddingSearchHit };

export type RecallVectorSearchInput = {
  scope: RecallScope;
  query: Float32Array;
  /** Candidate depth requested from each unit and from the merged result. */
  topK: number;
  /**
   * Cooperative budget predicate. The search checks it between units; a scan
   * that stops early reports `truncated` and keeps the hits it already has.
   */
  shouldStop: () => boolean;
};

/**
 * What one space search reports.
 *
 * - `searched`: the space was read. `truncated` means the budget cut it short.
 * - `empty`: the space has no units at all — a fresh install, not a failure.
 * - `unavailable`: no unit could be read or scored (missing/corrupt index, or a
 *   query whose width does not match the stored vectors). Never guess with a
 *   wrong space; fall back to lexical instead (48-1 §6.9).
 */
export type RecallVectorSearchResult =
  | {
      status: "searched";
      hits: readonly RecallVectorSearchHit[];
      /** Chunks actually scored, for diagnostics. */
      chunks: number;
      truncated?: boolean;
      reason?: string;
    }
  | {
      status: "empty";
      hits: readonly RecallVectorSearchHit[];
      reason?: string;
    }
  | {
      status: "unavailable";
      hits: readonly RecallVectorSearchHit[];
      reason: string;
    };

/**
 * The B2-facing half of the arm.
 *
 * Injected rather than built in here because the active space (model id,
 * dimensions, root) is a settings/host concern. {@link createEmbeddingIndexSearch}
 * covers the common case — a list of units under one space root.
 */
export type RecallVectorSearchPort = (
  input: RecallVectorSearchInput,
) => Promise<RecallVectorSearchResult> | RecallVectorSearchResult;

/**
 * The live parents a vector hit is rendered from.
 *
 * A vector hit names a stored parent (`message.id` or `memory:<path>#Lx-Ly`);
 * the text has to be re-read now, because the index is a derived cache and the
 * injection must show what is on disk today. B4 verifies the re-read text
 * against the stored `textHash` and drops the hit when it drifted (48-2 §4.3).
 */
export type RecallVectorParentPort = {
  /** Every recallable message of a conversation; `undefined` when it is gone. */
  transcriptMessages(
    conversationKey: string,
  ): readonly RecallMessageText[] | undefined;
  /** Current text of one memory parent; `undefined` when it no longer exists. */
  memoryParent(file: string, parentId: string): RecallVectorParent | undefined;
};

export type CreateVectorRecallSourceOptions = {
  encoder: RecallEncoderPort;
  search: RecallVectorSearchPort;
  parentReader: RecallVectorParentPort;
  /** Candidate depth; defaults to {@link VECTOR_RECALL_DEFAULT_TOP_K}. */
  topK?: number;
  /** The arm's own budget; defaults to {@link VECTOR_RECALL_DEFAULT_BUDGET_MS}. */
  budgetMs?: number;
  /** Clock for the budget, injectable so tests do not wait on wall time. */
  now?: () => number;
  /** Memory context lines; defaults to {@link VECTOR_RECALL_MEMORY_EXCERPT_LINES}. */
  excerptLines?: number;
  /** Add the `path › heading` prefix to memory hits (48-1 O-23, default on). */
  includeTitlePrefix?: boolean;
};

// ---------------------------------------------------------------------------
// The default B2 space search
// ---------------------------------------------------------------------------

export type CreateEmbeddingIndexSearchOptions = {
  /** The active space. Units live under `<root>/<agentId>/<spaceId>/`. */
  space: { agentId: string; spaceId: string };
  /**
   * The space's units, or a per-turn callback that lists them. The caller owns
   * the enumeration policy (it knows about the active conversations, the memory
   * workspace and the build state); this module only loads and scans them.
   */
  units:
    | readonly RecallVectorUnit[]
    | ((scope: RecallScope) => readonly RecallVectorUnit[]);
  /** Vector root; defaults to `getRecallVectorsRoot()` (`HARUYUKI_HOME` aware). */
  root?: string;
  /** Extra generation expectations (model/dimensions/quant/format). */
  expectation?: EmbeddingIndexExpectation;
};

/**
 * The standard space search: load every unit's B2 generation, scan it, merge the
 * parent hits and keep the best `topK`.
 *
 * Parent aggregation is B2's (`searchEmbeddingIndex` returns one hit per parent),
 * so a long message cannot spend several slots. The merge is global rather than
 * per unit because the vector arm's 50 candidates are shared between transcript
 * and memory (48-1 §6.7); a per-unit cut would let a conversation with many
 * units crowd out the memory side.
 *
 * Never throws: an unreadable unit is counted and skipped, and a space where no
 * unit is usable reports `unavailable` so the caller falls back to lexical.
 */
export function createEmbeddingIndexSearch(
  options: CreateEmbeddingIndexSearchOptions,
): RecallVectorSearchPort {
  return (input) => {
    const units =
      typeof options.units === "function"
        ? options.units(input.scope)
        : options.units;
    if (units.length === 0) {
      return {
        status: "empty",
        hits: [],
        reason: "the vector space has no units yet",
      };
    }

    const root = options.root ?? getRecallVectorsRoot();
    const expectation: EmbeddingIndexExpectation = {
      agentId: options.space.agentId,
      spaceId: options.space.spaceId,
      ...options.expectation,
    };
    const hits: RecallVectorSearchHit[] = [];
    let usableUnits = 0;
    let unusableUnits = 0;
    let chunks = 0;
    let truncated = false;
    let firstProblem: string | undefined;

    for (const unit of units) {
      if (input.shouldStop()) {
        truncated = true;
        break;
      }
      const unitDir = embeddingVectorUnitDir(
        unitIdentity(unit, options.space),
        {
          root,
        },
      );
      const loaded = loadEmbeddingIndex(unitDir, { expectation });
      if (!loaded.ok) {
        unusableUnits += 1;
        firstProblem ??= problemText(loaded.problem, loaded.detail);
        continue;
      }
      usableUnits += 1;
      const searched = searchEmbeddingIndex(loaded.index, input.query, {
        topK: input.topK,
      });
      if (!searched.ok) {
        // A width mismatch is a space-level problem: one unit's answer cannot
        // be trusted against a query of another width, and mixing widths would
        // silently compare unrelated geometry.
        usableUnits -= 1;
        unusableUnits += 1;
        firstProblem ??= problemText(searched.problem, searched.detail);
        continue;
      }
      chunks += loaded.index.records.length;
      for (const hit of searched.hits) hits.push(taggedHit(unit, hit));
    }

    if (usableUnits === 0) {
      if (truncated) {
        // Nothing was scanned because the budget was already spent. That is a
        // partial answer, not a broken space; the caller must keep the lexical
        // arm's result instead of reporting the space unavailable.
        return {
          status: "searched",
          hits: [],
          chunks,
          truncated: true,
          reason: "the vector search budget expired",
        };
      }
      return {
        status: "unavailable",
        hits: [],
        reason: `no usable vector index in the space (${firstProblem ?? "unknown problem"})`,
      };
    }

    hits.sort(compareVectorSearchHits);
    const depth = Math.max(0, Math.trunc(input.topK));
    const reasons: string[] = [];
    if (unusableUnits > 0) {
      reasons.push(`${unusableUnits} unit(s) had no usable index`);
    }
    if (truncated) reasons.push("the vector search budget expired");
    return {
      status: "searched",
      hits: depth === 0 ? [] : hits.slice(0, depth),
      chunks,
      ...(truncated ? { truncated: true } : {}),
      ...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }),
    };
  };
}

// ---------------------------------------------------------------------------
// The default local parent reader
// ---------------------------------------------------------------------------

export type CreateLocalVectorParentPortOptions = {
  /** Local-backend storage directory (`.../conversations/<key>/` lives below it). */
  storageDir: string;
  /** Active agent's memory workspace. */
  memoryDir: string;
};

/**
 * Reads parents from the local backend the way the lexical arm reads them.
 *
 * The transcript side re-reads `messages.jsonl` through B4's tolerant reader, so
 * a snapshot disagreement drops the hit instead of injecting a stale message.
 * The memory side rejects a parent id whose path is not the file the unit came
 * from: the id comes from an index file on disk, and a corrupt one must not read
 * outside the memory workspace (48-1 §8.2).
 */
export function createLocalVectorParentPort(
  options: CreateLocalVectorParentPortOptions,
): RecallVectorParentPort {
  return {
    transcriptMessages(conversationKey) {
      const messages = readRecallMessageTexts(
        join(options.storageDir, "conversations", conversationKey),
      );
      return messages.length === 0 ? undefined : messages;
    },
    memoryParent(file, parentId) {
      const parsed = parseMemoryVectorParentId(parentId);
      if (parsed === undefined) return undefined;
      if (normalizeMemoryPath(parsed.path) !== normalizeMemoryPath(file)) {
        return undefined;
      }
      return readMemoryVectorParentText(options.memoryDir, parentId);
    },
  };
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * The vector arm as one {@link RecallSourcePort}.
 *
 * `id` is `"vector"` rather than `transcript`/`memory`: one source covers both
 * corpora (48-1 §6.1: "两臂各自覆盖两源"), while every candidate keeps its
 * corpus in `source`. Fusion recovers the split with
 * {@link partitionRecallCandidates}.
 */
export function createVectorRecallSource(
  options: CreateVectorRecallSourceOptions,
): RecallSourcePort {
  const settings = resolveVectorSourceOptions(options);
  return {
    id: "vector",
    arm: "vector",
    async search(request) {
      try {
        return await searchVectorArm(request, settings);
      } catch (error) {
        // I7: recall may never be the reason a message does not get sent. The
        // individual steps catch their own failures; this is the last net.
        return vectorOutcome("failed", [], reasonFor(error));
      }
    },
  };
}

/**
 * Splits a flat candidate list back into the two arms.
 *
 * `searchRecallPhases` flattens both arms into one array (it has to: the
 * service's selection and dedup are arm-agnostic), and fusion needs the split
 * back. A candidate with no `arm` is lexical — that is what the lexical sources
 * produce, and it keeps old fixtures and stored decisions valid.
 */
export function partitionRecallCandidates(
  candidates: readonly RecallCandidate[],
): { lexical: RecallCandidate[]; vector: RecallCandidate[] } {
  const lexical: RecallCandidate[] = [];
  const vector: RecallCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.arm === "vector") vector.push(candidate);
    else lexical.push(candidate);
  }
  return { lexical, vector };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ResolvedVectorSourceOptions = {
  encoder: RecallEncoderPort;
  search: RecallVectorSearchPort;
  parentReader: RecallVectorParentPort;
  topK: number;
  budgetMs: number;
  now: () => number;
  excerptLines: number;
  includeTitlePrefix: boolean;
};

type EncodeOutcome =
  | { status: "ok"; vector: Float32Array }
  | { status: "unavailable" | "failed" | "degraded"; reason: string };

function resolveVectorSourceOptions(
  options: CreateVectorRecallSourceOptions,
): ResolvedVectorSourceOptions {
  return {
    encoder: options.encoder,
    search: options.search,
    parentReader: options.parentReader,
    topK: positiveInteger(options.topK, VECTOR_RECALL_DEFAULT_TOP_K),
    budgetMs: resolveBudget(options.budgetMs),
    now: options.now ?? Date.now,
    excerptLines: nonNegativeInteger(
      options.excerptLines,
      VECTOR_RECALL_MEMORY_EXCERPT_LINES,
    ),
    includeTitlePrefix: options.includeTitlePrefix !== false,
  };
}

function resolveBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return VECTOR_RECALL_DEFAULT_BUDGET_MS;
  }
  // `0` and negatives mean "no budget", the same convention the turn deadline
  // uses: a corrupt setting must not bound the arm.
  return value > 0 ? Math.trunc(value) : 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

async function searchVectorArm(
  request: RecallSourceRequest,
  settings: ResolvedVectorSourceOptions,
): Promise<RecallSourceOutcome> {
  const rawText =
    typeof request.terms.rawText === "string" ? request.terms.rawText : "";
  if (rawText.trim().length === 0) {
    return vectorOutcome("empty", [], "the query carries no text");
  }
  if (
    rawText.trim().length < VECTOR_RECALL_MIN_QUERY_CHARS &&
    request.terms.terms.length === 0 &&
    request.terms.phrases.length === 0
  ) {
    return vectorOutcome(
      "empty",
      [],
      `the query is shorter than ${VECTOR_RECALL_MIN_QUERY_CHARS} characters and has no terms`,
    );
  }

  // The arm's own budget starts here. It bounds the encode, the scan and the
  // mapping; it is deliberately *not* the turn's deadline (`request` does not
  // carry one), so a slow encoder degrades this arm instead of timing the turn
  // out and tripping the breaker.
  const deadline = createRecallDeadline(settings.budgetMs, settings.now);
  const shouldStop = (): boolean => deadline.expired();

  const encoded = await encodeQueryWithinBudget(
    settings.encoder,
    rawText,
    deadline,
  );
  if (encoded.status !== "ok") {
    return vectorOutcome(encoded.status, [], encoded.reason);
  }
  if (shouldStop()) {
    return vectorOutcome(
      "degraded",
      [],
      "the vector query budget expired before the scan",
    );
  }

  let found: RecallVectorSearchResult;
  try {
    found = await settings.search({
      scope: request.scope,
      query: encoded.vector,
      topK: settings.topK,
      shouldStop,
    });
  } catch (error) {
    return vectorOutcome("failed", [], reasonFor(error));
  }
  if (found.status === "unavailable") {
    return vectorOutcome("unavailable", [], found.reason);
  }
  if (found.status === "empty") {
    return vectorOutcome("empty", [], found.reason);
  }

  const mapped = mapVectorHits({
    hits: found.hits,
    parentReader: settings.parentReader,
    excerptLines: settings.excerptLines,
    includeTitlePrefix: settings.includeTitlePrefix,
    shouldStop,
  });
  // The arm's depth is 50 shared between transcript and memory; a per-unit scan
  // can return more than the merged depth, so the cut happens after mapping.
  const candidates = mapped.candidates.slice(0, settings.topK);
  const reasons: string[] = [];
  if (mapped.dropped > 0) {
    reasons.push(
      `${mapped.dropped} hit(s) dropped because their parent text drifted`,
    );
  }
  if (found.reason) reasons.push(found.reason);
  // The budget can be spent by the scan, by the mapping, or by the clock moving
  // between them. All three mean "partial result", never "the turn timed out".
  const truncated = mapped.stopped || found.truncated === true || shouldStop();
  if (truncated) {
    reasons.push("the vector arm ran out of its own query budget");
    return vectorOutcome("degraded", candidates, reasons.join("; "));
  }
  return vectorOutcome(
    candidates.length > 0 ? "searched" : "empty",
    candidates,
    reasons.length > 0 ? reasons.join("; ") : undefined,
  );
}

/**
 * Encodes the query, racing a watchdog so a hung encoder cannot hold the turn.
 *
 * The watchdog is only armed for a finite budget; `0` means the caller asked for
 * no bound at all, and scheduling a timer for it would expire a budget nobody
 * set (the same reason `recall-deadline.ts` checks before comparing). When the
 * watchdog wins, the still-running encode resolves into nothing — its result is
 * ignored, and its rejection is already handled by the promise chain, so no
 * unhandled rejection can escape.
 */
async function encodeQueryWithinBudget(
  encoder: RecallEncoderPort,
  text: string,
  deadline: RecallDeadline,
): Promise<EncodeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog =
    deadline.timeoutMs > 0
      ? new Promise<EncodeOutcome>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: "degraded",
                reason: "the vector query budget expired while encoding",
              }),
            deadline.timeoutMs,
          );
        })
      : undefined;
  const work = Promise.resolve()
    .then(() => encoder.encodeQuery(text))
    .then(
      (vector): EncodeOutcome => {
        if (vector === null) {
          return {
            status: "unavailable",
            reason: "the encoder returned no query vector",
          };
        }
        if (vector.length === 0) {
          return {
            status: "unavailable",
            reason: "the encoder returned an empty query vector",
          };
        }
        return { status: "ok", vector };
      },
      (error): EncodeOutcome => ({
        status: "failed",
        reason: reasonFor(error),
      }),
    );
  try {
    const result =
      watchdog === undefined
        ? await work
        : await Promise.race([work, watchdog]);
    // The injected clock may have moved past the budget while the encode was in
    // flight; the watchdog cannot see that when the clock is a fake.
    if (result.status === "ok" && deadline.expired()) {
      return {
        status: "degraded",
        reason: "the vector query budget expired while encoding",
      };
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Maps B2 hits onto injectable candidates through B4, dropping anything whose
 * parent cannot be rendered faithfully.
 *
 * Transcript hits are grouped by conversation so the transcript is read once per
 * search, exactly like the lexical arm. Memory hits are grouped by file for the
 * same reason (the reader reads the whole document to map a line span).
 */
function mapVectorHits(input: {
  hits: readonly RecallVectorSearchHit[];
  parentReader: RecallVectorParentPort;
  excerptLines: number;
  includeTitlePrefix: boolean;
  shouldStop: () => boolean;
}): {
  candidates: RecallVectorCandidate[];
  dropped: number;
  stopped: boolean;
} {
  const transcriptHits = new Map<string, EmbeddingSearchHit[]>();
  const memoryHits = new Map<string, EmbeddingSearchHit[]>();
  for (const tagged of input.hits) {
    const groups = tagged.kind === "transcript" ? transcriptHits : memoryHits;
    const key =
      tagged.kind === "transcript" ? tagged.conversationKey : tagged.file;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [tagged.hit]);
    else bucket.push(tagged.hit);
  }

  const candidates: RecallVectorCandidate[] = [];
  let dropped = 0;

  for (const [conversationKey, hits] of transcriptHits) {
    if (input.shouldStop()) return { candidates, dropped, stopped: true };
    const messages = input.parentReader.transcriptMessages(conversationKey);
    if (messages === undefined || messages.length === 0) {
      // The conversation disappeared between the build and this turn.
      dropped += hits.length;
      continue;
    }
    const built = buildTranscriptVectorCandidates({
      hits,
      conversationKey,
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    dropped += hits.length - built.length;
    candidates.push(...built);
  }

  for (const [file, hits] of memoryHits) {
    if (input.shouldStop()) return { candidates, dropped, stopped: true };
    const built = buildMemoryVectorCandidates({
      hits,
      file,
      readParent: (parentId) => input.parentReader.memoryParent(file, parentId),
      excerptLines: input.excerptLines,
      includeTitlePrefix: input.includeTitlePrefix,
      maxCharacters: VECTOR_INJECTION_MAX_CHARS,
    });
    dropped += hits.length - built.length;
    candidates.push(...built);
  }

  candidates.sort(compareVectorCandidates);
  // One injectable unit per fingerprint: a memory file can contribute several
  // paragraphs (B2 aggregates per paragraph, B4 fingerprints per file), and two
  // copies in the same arm would spend two depth slots on one passage.
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    if (seen.has(candidate.fingerprint)) return false;
    seen.add(candidate.fingerprint);
    return true;
  });
  return { candidates: unique, dropped, stopped: false };
}

function unitIdentity(
  unit: RecallVectorUnit,
  space: { agentId: string; spaceId: string },
): EmbeddingVectorUnit {
  return unit.kind === "transcript"
    ? {
        agentId: space.agentId,
        spaceId: space.spaceId,
        conversationKey: unit.conversationKey,
      }
    : {
        agentId: space.agentId,
        spaceId: space.spaceId,
        memoryFileKey: unit.memoryFileKey,
      };
}

function taggedHit(
  unit: RecallVectorUnit,
  hit: EmbeddingSearchHit,
): RecallVectorSearchHit {
  return unit.kind === "transcript"
    ? { kind: "transcript", conversationKey: unit.conversationKey, hit }
    : { kind: "memory", file: unit.file, hit };
}

function compareVectorSearchHits(
  left: RecallVectorSearchHit,
  right: RecallVectorSearchHit,
): number {
  if (right.hit.score !== left.hit.score) {
    return right.hit.score - left.hit.score;
  }
  const leftKey = taggedHitKey(left);
  const rightKey = taggedHitKey(right);
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

function taggedHitKey(item: RecallVectorSearchHit): string {
  const unit = item.kind === "transcript" ? item.conversationKey : item.file;
  return `${item.kind}\u0000${unit}\u0000${item.hit.parentId}\u0000${item.hit.chunkIndex}`;
}

function compareVectorCandidates(
  left: RecallVectorCandidate,
  right: RecallVectorCandidate,
): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.fingerprint === right.fingerprint) return 0;
  // Code-unit order, not locale order: the tie-break must not move with the
  // process locale (same rule as fusion).
  return left.fingerprint < right.fingerprint ? -1 : 1;
}

function problemText(problem: string, detail: string | undefined): string {
  return detail === undefined ? problem : `${problem}: ${detail}`;
}

function vectorOutcome(
  status: RecallSourceStatus,
  candidates: readonly RecallVectorCandidate[],
  reason: string | undefined,
): RecallSourceOutcome {
  return {
    candidates: [...candidates],
    diagnostic: {
      source: "vector",
      status,
      candidates: candidates.length,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
