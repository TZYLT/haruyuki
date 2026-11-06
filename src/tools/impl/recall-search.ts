/**
 * `RecallSearch` — the main agent's read-only semantic search over its own
 * transcript and memory vector indexes (48-3 §13.9.2, 48-4 D-24).
 *
 * This is the *explicit* counterpart to passive recall: the turn path injects
 * passages the model did not ask for, while this tool runs only when the model
 * decides to look something up mid-turn. It is deliberately read-only — it never
 * writes a transcript, never touches the context, and never builds or repairs an
 * index. It only reads B2's committed pointers and generations.
 *
 * Three decisions are load-bearing:
 *
 * 1. **Delay disclosure is part of every answer.** An embedding index is a
 *    derived cache: it is built at some point and is behind from then on. A hit
 *    list without its as-of time invites the model to treat a stale index as the
 *    whole truth, so every return carries the index's as-of time, how far behind
 *    it is, and how many units/chunks it covers. D-24 requires this; the as-of is
 *    the *oldest* committed unit (`current.json.updatedAt`) among the units
 *    searched, because that is the point through which the whole searched corpus
 *    is guaranteed to be current. Five minutes or more is printed with an
 *    actionable "run a build" line.
 * 2. **No lexical fallback.** When embedding is off, the encoder cannot answer,
 *    or the index is missing, the tool returns an error that says what to do.
 *    Falling back to lexical search would make "not indexed" indistinguishable
 *    from "no matching passage", which is exactly the confusion §13.9.2 item 3
 *    forbids.
 * 3. **The corpus is the recall corpus.** Units come from
 *    `listRecallEmbeddingUnits`, the same viewer the turn path uses, so hidden
 *    conversations, conversations owned by another agent, and memory files that
 *    no longer exist are excluded by the same rule this tool cannot override —
 *    it can read no hidden session, and it never creates a conversation. The
 *    current conversation is *included*: passive recall excludes messages still
 *    in context (48-1 §6.2 item 9), but an explicit lookup is the model asking to
 *    see them again. That exclusion is a turn-path budget rule, not a boundary
 *    this tool should enforce.
 *
 * Retrieval is not re-implemented here: the space comes from
 * `resolveEmbeddingSpace`, the unit list from `listRecallEmbeddingUnits`, the
 * scan from `createEmbeddingIndexSearch` (f32 and int8, dispatched on
 * `space.quantization`), and the passage mapping from the B4 builders in
 * `recall-sources.ts`. The ANN sidecar is deliberately *not* used: this is an
 * explicit, occasional call, so the brute-force scan's simpler failure modes are
 * worth more than its latency.
 *
 * Layer: `tools/`. It imports `reminders/` for the shared recall ports and
 * `backend/local/` for the index; `tools/` must not import `cli/`.
 */
import { getCurrentAgentId } from "@/agent/context";
import { type Backend, getBackend } from "@/backend";
import {
  createEmbeddingQueryEncoder,
  type EmbeddingQueryEncoder,
} from "@/backend/local/embedding-encoder";
import {
  embeddingVectorUnitDir,
  readEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import type { EmbeddingSearchHit } from "@/backend/local/embedding-search";
import {
  type EmbeddingSpaceIdentity,
  resolveEmbeddingSpace,
} from "@/backend/local/embedding-space";
import { LocalBackend } from "@/backend/local/local-backend";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import { listRecallEmbeddingUnits } from "@/reminders/recall-embedding-arms";
import {
  buildMemoryVectorCandidates,
  buildTranscriptVectorCandidates,
  createTranscriptVectorParentReader,
  VECTOR_INJECTION_MAX_CHARS,
} from "@/reminders/recall-sources";
import {
  createEmbeddingIndexSearch,
  createLocalVectorParentPort,
  type RecallVectorParentPort,
  type RecallVectorSearchHit,
  type RecallVectorUnit,
  VECTOR_RECALL_MEMORY_EXCERPT_LINES,
  VECTOR_RECALL_MIN_COSINE,
} from "@/reminders/recall-vector-source";

/** Hits a call returns when `limit` is omitted (the D-24 contract). */
export const RECALL_SEARCH_DEFAULT_LIMIT = 5;

/** Hard ceiling on `limit`; the schema says so, and the implementation checks. */
export const RECALL_SEARCH_MAX_LIMIT = 20;

/**
 * Lag at or above which the answer says what to do about it (D-24).
 *
 * The turn path's automatic catch-up runs at most once per five minutes too
 * (`EMBEDDING_AUTOBUILD_COOLDOWN_MS`), so a larger lag means the automatic path
 * is not keeping up and the user has to act.
 */
export const RECALL_SEARCH_LAG_WARN_SECONDS = 300;

/** The three corpora the tool can address. */
export const RECALL_SEARCH_SCOPES = ["transcript", "memory", "both"] as const;

export type RecallSearchScope = (typeof RECALL_SEARCH_SCOPES)[number];

export interface RecallSearchArgs {
  query?: unknown;
  scope?: unknown;
  limit?: unknown;
}

/** The normalized arguments, after validation. */
export interface RecallSearchFilters {
  query: string;
  scope: RecallSearchScope;
  limit: number;
}

export interface RecallSearchDeps {
  /** Backend used only when `storageDir` is absent; tests pass `storageDir`. */
  backend?: Backend;
  /** Calling agent; defaults to the live runtime context. */
  agentId?: string;
  /** Local-backend storage root; tests pass a temp directory. */
  storageDir?: string;
  /** Vector root override; defaults to what `resolveEmbeddingSpace` uses. */
  root?: string;
  /** Resolved embedding settings; defaults to the live settings record. */
  settings?: ResolvedEmbeddingSettings;
  /** Ready encoder (test seam); production uses the shared per-agent encoder. */
  encoder?: EmbeddingQueryEncoder;
  /** Encoder factory for the per-agent cache (test seam). */
  encoderFactory?: (
    settings: ResolvedEmbeddingSettings,
  ) => EmbeddingQueryEncoder;
  /** Clock seam so lag tests never wait on wall time. */
  now?: () => number;
}

export interface RecallSearchResult {
  content: string;
  status: "success" | "error";
}

/** What the answer says about the index it searched. */
export interface RecallSearchIndex {
  /** ISO commit time of the oldest searched unit; `null` before any build. */
  asOf: string | null;
  asOfMs: number | null;
  /** `now - asOf` in whole seconds; `null` before any build. */
  lagSeconds: number | null;
  /** Units whose `current.json` is readable. */
  units: number;
  /** Chunks those units commit to. */
  chunks: number;
  /** Storage precision of the resolved space. */
  quant: "f32" | "int8";
}

/** One passage in the answer. */
interface RecallSearchHit {
  source: "transcript" | "memory";
  text: string;
  score: number;
  /** Conversation directory key, or workspace-relative memory path. */
  file: string;
  /** Memory: 1-based first excerpt line. Transcript: 1-based message number. */
  line: number;
  /** Memory only: 1-based last excerpt line. */
  endLine?: number;
  /** Transcript only. */
  conversationKey?: string;
  messageId?: string;
  timestamp?: string;
}

/**
 * Validate and normalize the arguments.
 *
 * Every rejection carries the model-facing reason, so a bad call comes back as a
 * fixable message instead of a silent empty result. `scope` defaults to `both`
 * (the tool exists to look across the agent's memory, not just one corpus) and
 * `limit` to {@link RECALL_SEARCH_DEFAULT_LIMIT}.
 */
export function validateRecallSearchArgs(
  args: RecallSearchArgs,
): ({ ok: true } & RecallSearchFilters) | { ok: false; content: string } {
  if (typeof args.query !== "string") {
    return {
      ok: false,
      content:
        "`query` is required and must be a string: the text to search for. RecallSearch embeds it with the configured model, so a sentence or a question works better than a few keywords.",
    };
  }
  const query = args.query.trim();
  if (query.length === 0) {
    return {
      ok: false,
      content:
        "`query` was empty. Pass the text to search for — a sentence or a question works better than keywords, because the index stores whole passages.",
    };
  }

  let scope: RecallSearchScope = "both";
  if (args.scope !== undefined) {
    if (
      typeof args.scope !== "string" ||
      !(RECALL_SEARCH_SCOPES as readonly string[]).includes(args.scope)
    ) {
      return {
        ok: false,
        content: `\`scope\` must be one of ${RECALL_SEARCH_SCOPES.map(
          (value) => `"${value}"`,
        ).join(", ")}. It defaults to "both".`,
      };
    }
    scope = args.scope as RecallSearchScope;
  }

  let limit = RECALL_SEARCH_DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    const value = args.limit;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > RECALL_SEARCH_MAX_LIMIT
    ) {
      return {
        ok: false,
        content: `\`limit\` must be a whole number between 1 and ${RECALL_SEARCH_MAX_LIMIT}. It defaults to ${RECALL_SEARCH_DEFAULT_LIMIT}.`,
      };
    }
    limit = value;
  }

  return { ok: true, query, scope, limit };
}

/** `12s`, `7m 30s`, `2h 5m` — compact enough for a first line. */
export function formatRecallSearchLag(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The delay-disclosure lines.
 *
 * Rendered for every return — success, empty and error alike — because the
 * disclosure is the point of the tool, not a decoration on the happy path.
 */
export function formatRecallSearchIndexLines(
  index: RecallSearchIndex,
): string[] {
  if (index.asOf === null || index.lagSeconds === null) {
    return [
      "Index: not built — as-of unknown, lag unknown, 0 chunks committed.",
    ];
  }
  const lag = index.lagSeconds;
  const lines = [
    `Index as of ${index.asOf} · lag ${formatRecallSearchLag(lag)} · ${index.quant} · ${index.units} unit(s), ${index.chunks} chunk(s)`,
  ];
  if (lag >= RECALL_SEARCH_LAG_WARN_SECONDS) {
    lines.push(
      `The index is behind: its oldest searched unit was committed ${formatRecallSearchLag(lag)} ago, so anything newer than that is not searchable yet. Run /recall embedding build to catch up (vector recall must be on).`,
    );
  }
  return lines;
}

/** Resolution of one call's inputs, before any search happens. */
type ResolvedRecallSearchContext =
  | {
      ok: true;
      agentId: string;
      storageDir: string;
      memoryDir: string;
      settings: ResolvedEmbeddingSettings;
      space: EmbeddingSpaceIdentity;
    }
  | { ok: false; content: string };

function errorResult(lines: readonly string[]): RecallSearchResult {
  return { content: lines.join("\n"), status: "error" };
}

function resolveRecallSearchContext(
  deps: RecallSearchDeps,
): ResolvedRecallSearchContext {
  let agentId: string;
  try {
    agentId = deps.agentId ?? getCurrentAgentId();
  } catch {
    return {
      ok: false,
      content:
        "RecallSearch needs the calling agent, which is not available in this execution context.",
    };
  }

  let storageDir = deps.storageDir;
  if (storageDir === undefined) {
    const backend = deps.backend ?? getBackend();
    if (!(backend instanceof LocalBackend)) {
      return {
        ok: false,
        content:
          "RecallSearch needs the local backend: the vector index is derived from the local transcripts and the agent's local memory workspace, and this conversation runs on the API backend.",
      };
    }
    storageDir = backend.getLocalStorageDir();
  }
  const memoryDir = getLocalBackendMemoryFilesystemRoot(agentId, storageDir);

  const settings = deps.settings ?? readEmbeddingSettings();
  if (settings.enabled !== true) {
    return {
      ok: false,
      content: [
        "Vector recall is off: `recallEmbeddingEnabled` is not true, so there is no embedding index to search. Turn it on with /recall embedding on, then run /recall embedding build if the index has never been built.",
        'RecallSearch is semantic-only on purpose: it never silently falls back to lexical search, because "unavailable" must not read as "no matches".',
      ].join("\n"),
    };
  }

  let space: EmbeddingSpaceIdentity;
  try {
    space = resolveEmbeddingSpace(
      agentId,
      settings,
      deps.root === undefined ? {} : { root: deps.root },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      content: `The embedding configuration does not describe a usable vector space (${detail}). Run /recall embedding connect to finish setup. Nothing was searched and nothing falls back to lexical search.`,
    };
  }

  return { ok: true, agentId, storageDir, memoryDir, settings, space };
}

function unitDirectory(
  unit: RecallVectorUnit,
  space: EmbeddingSpaceIdentity,
): string {
  return embeddingVectorUnitDir(
    unit.kind === "transcript"
      ? {
          agentId: space.agentId,
          spaceId: space.spaceId,
          conversationKey: unit.conversationKey,
        }
      : {
          agentId: space.agentId,
          spaceId: space.spaceId,
          memoryFileKey: unit.memoryFileKey,
        },
    { root: space.root },
  );
}

/**
 * The as-of/coverage summary of the units a call is about to search.
 *
 * `asOf` is the oldest readable `current.json.updatedAt`: a newer unit cannot
 * pull the guarantee forward, because the older one is where the corpus stops
 * being current. An unreadable pointer is not counted — the scan will skip that
 * unit anyway, and the summary must describe what was searched.
 */
function summarizeRecallSearchIndex(input: {
  units: readonly RecallVectorUnit[];
  space: EmbeddingSpaceIdentity;
  nowMs: number;
}): RecallSearchIndex {
  let asOfMs: number | null = null;
  let readableUnits = 0;
  let chunks = 0;
  for (const unit of input.units) {
    const pointer = readEmbeddingIndexPointer(unitDirectory(unit, input.space));
    if (!pointer.ok) continue;
    readableUnits += 1;
    chunks += Number.isFinite(pointer.pointer.chunkCount)
      ? Math.max(0, Math.trunc(pointer.pointer.chunkCount))
      : 0;
    const committed = Date.parse(pointer.pointer.updatedAt);
    if (Number.isFinite(committed) && (asOfMs === null || committed < asOfMs)) {
      asOfMs = committed;
    }
  }
  return {
    asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
    asOfMs,
    lagSeconds:
      asOfMs === null
        ? null
        : Math.max(0, Math.round((input.nowMs - asOfMs) / 1000)),
    units: readableUnits,
    chunks,
    quant: input.space.quantization,
  };
}

function scopeUnits(
  units: readonly RecallVectorUnit[],
  scope: RecallSearchScope,
): RecallVectorUnit[] {
  if (scope === "both") return [...units];
  return units.filter((unit) => unit.kind === scope);
}

/**
 * Group B2 parent hits and map them onto the same B4 passages the turn path
 * injects: verified against the live parent text, dropped when it drifted.
 */
function mapRecallSearchHits(input: {
  hits: readonly RecallVectorSearchHit[];
  parentReader: RecallVectorParentPort;
  excerptLines: number;
}): { hits: RecallSearchHit[]; dropped: number } {
  const transcriptHits = new Map<string, EmbeddingSearchHit[]>();
  const memoryHits = new Map<string, EmbeddingSearchHit[]>();
  for (const tagged of input.hits) {
    if (tagged.kind === "transcript") {
      const bucket = transcriptHits.get(tagged.conversationKey);
      if (bucket === undefined) {
        transcriptHits.set(tagged.conversationKey, [tagged.hit]);
      } else {
        bucket.push(tagged.hit);
      }
      continue;
    }
    const bucket = memoryHits.get(tagged.file);
    if (bucket === undefined) memoryHits.set(tagged.file, [tagged.hit]);
    else bucket.push(tagged.hit);
  }

  const hits: RecallSearchHit[] = [];
  let dropped = 0;

  for (const [conversationKey, group] of transcriptHits) {
    const messages = input.parentReader.transcriptMessages(conversationKey);
    if (messages === undefined || messages.length === 0) {
      dropped += group.length;
      continue;
    }
    const built = buildTranscriptVectorCandidates({
      hits: group,
      conversationKey,
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    dropped += group.length - built.length;
    for (const candidate of built) {
      if (candidate.messageId === undefined) continue;
      const ordinal = messages.findIndex(
        (message) => message.id === candidate.messageId,
      );
      hits.push({
        source: "transcript",
        text: candidate.text,
        score: candidate.score,
        file: conversationKey,
        conversationKey,
        messageId: candidate.messageId,
        line: ordinal + 1,
        ...(candidate.timestamp === undefined
          ? {}
          : { timestamp: candidate.timestamp }),
      });
    }
  }

  for (const [file, group] of memoryHits) {
    const built = buildMemoryVectorCandidates({
      hits: group,
      file,
      readParent: (parentId) => input.parentReader.memoryParent(file, parentId),
      excerptLines: input.excerptLines,
      maxCharacters: VECTOR_INJECTION_MAX_CHARS,
    });
    dropped += group.length - built.length;
    for (const candidate of built) {
      hits.push({
        source: "memory",
        text: candidate.text,
        score: candidate.score,
        file,
        line: candidate.startLine ?? 0,
        ...(candidate.endLine === undefined
          ? {}
          : { endLine: candidate.endLine }),
      });
    }
  }

  hits.sort((left, right) => right.score - left.score);
  return { hits, dropped };
}

function indentPassage(text: string): string[] {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `   ${line}`));
}

/** One result row: source, locator, score, then the passage itself. */
function formatRecallSearchHit(hit: RecallSearchHit, rank: number): string[] {
  const score = hit.score.toFixed(3);
  if (hit.source === "memory") {
    const span =
      hit.endLine !== undefined && hit.endLine !== hit.line
        ? `L${hit.line}-L${hit.endLine}`
        : `L${hit.line}`;
    return [
      `${rank}. [memory] ${hit.file} ${span} · score ${score}`,
      ...indentPassage(hit.text),
    ];
  }
  const timestamp =
    hit.timestamp !== undefined && hit.timestamp.length > 0
      ? ` · ${hit.timestamp}`
      : "";
  return [
    `${rank}. [transcript] conversation ${hit.conversationKey ?? hit.file} · message #${hit.line}${timestamp} · score ${score}`,
    ...indentPassage(hit.text),
  ];
}

/**
 * The tool entry point.
 *
 * `deps.storageDir` exists for tests and for callers that already hold a backend
 * root; without it the storage dir comes from the local backend, never from the
 * ambient default, so an alternate-root store can never search the user's real
 * `~/.haruyuki/lc-local-backend`.
 */
export async function recall_search(
  args: RecallSearchArgs,
  deps: RecallSearchDeps = {},
): Promise<RecallSearchResult> {
  const validated = validateRecallSearchArgs(args);
  if (!validated.ok) return errorResult([validated.content]);

  const context = resolveRecallSearchContext(deps);
  if (!context.ok) return errorResult([context.content]);
  const { agentId, storageDir, memoryDir, settings, space } = context;

  let units: RecallVectorUnit[];
  try {
    units = listRecallEmbeddingUnits({
      agentId,
      spaceDir: space.spaceDir,
      storageDir,
      memoryDir,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return errorResult([
      ...formatRecallSearchIndexLines({
        asOf: null,
        asOfMs: null,
        lagSeconds: null,
        units: 0,
        chunks: 0,
        quant: space.quantization,
      }),
      `The vector index could not be listed (${detail}). Nothing was searched; this is not a "no matches" answer.`,
    ]);
  }

  if (units.length === 0) {
    return errorResult([
      ...formatRecallSearchIndexLines({
        asOf: null,
        asOfMs: null,
        lagSeconds: null,
        units: 0,
        chunks: 0,
        quant: space.quantization,
      }),
      "The vector index has not been built yet, so there is nothing to search. Run /recall embedding build (vector recall must be on); the next turn also triggers a catch-up build automatically.",
      'RecallSearch does not fall back to lexical search, so "not built" is never reported as "no matches".',
    ]);
  }

  const searchedUnits = scopeUnits(units, validated.scope);
  if (searchedUnits.length === 0) {
    return errorResult([
      `Nothing is indexed for scope "${validated.scope}" yet: the space has ${units.length} indexed unit(s), all of the other corpus. Run /recall embedding build to index this corpus (vector recall must be on).`,
    ]);
  }

  const now = deps.now ?? Date.now;
  const index = summarizeRecallSearchIndex({
    units: searchedUnits,
    space,
    nowMs: now(),
  });
  const indexLines = formatRecallSearchIndexLines(index);
  if (index.units === 0) {
    return errorResult([
      ...indexLines,
      "The space directory exists but none of its units has a readable current.json, so the index is effectively unbuilt. Run /recall embedding build.",
    ]);
  }

  let encoder: EmbeddingQueryEncoder;
  try {
    encoder =
      deps.encoder ??
      sharedQueryEncoder(agentId, settings, deps.encoderFactory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return errorResult([
      ...indexLines,
      `The embedding encoder could not be started (${detail}). Run /recall embedding connect to finish setup. Nothing falls back to lexical search.`,
    ]);
  }

  let queryVector: Float32Array | null;
  try {
    queryVector = await encoder.encodeQuery(validated.query);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return errorResult([
      ...indexLines,
      `The embedding encoder failed to encode the query (${detail}). Run /recall embedding connect to check the setup. Nothing falls back to lexical search.`,
    ]);
  }
  if (queryVector === null || queryVector.length === 0) {
    return errorResult([
      ...indexLines,
      "The embedding encoder returned no query vector: the built-in model or runtime is not installed, or the endpoint refused the request. Run /recall embedding connect to download the built-in model (or check the endpoint). Nothing falls back to lexical search.",
    ]);
  }

  const parentReader = createLocalVectorParentPort({ storageDir, memoryDir });
  const search = createEmbeddingIndexSearch({
    space: { agentId, spaceId: space.spaceId },
    root: space.root,
    units: searchedUnits,
    expectation: {
      agentId,
      spaceId: space.spaceId,
      modelId: space.modelId,
      dimensions: space.dimensions,
      quant: space.quantization,
    },
  });

  let found: Awaited<ReturnType<typeof search>>;
  try {
    found = await search({
      scope: { agentId, currentConversationId: "default" },
      query: queryVector,
      topK: validated.limit,
      shouldStop: () => false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return errorResult([
      ...indexLines,
      `The vector scan failed (${detail}). Nothing falls back to lexical search.`,
    ]);
  }

  if (found.status === "unavailable") {
    return errorResult([
      ...indexLines,
      `No unit in the index could be read (${found.reason}). Run /recall embedding build to rebuild it. Nothing falls back to lexical search.`,
    ]);
  }
  if (found.status === "empty") {
    return errorResult([
      ...indexLines,
      "The vector index has no committed unit yet. Run /recall embedding build.",
    ]);
  }

  const mapped = mapRecallSearchHits({
    hits: found.hits,
    parentReader,
    excerptLines: VECTOR_RECALL_MEMORY_EXCERPT_LINES,
  });
  const shown = mapped.hits.slice(0, validated.limit);
  const lines = [...indexLines, ""];

  if (shown.length === 0) {
    lines.push(
      `No passage for "${validated.query}" passed the similarity floor (cosine >= ${VECTOR_RECALL_MIN_COSINE}) in the ${validated.scope} index. The index was searched — see the as-of line — so this is a real "nothing similar", not an unavailable index.`,
    );
  } else {
    lines.push(
      `${shown.length} hit(s) for "${validated.query}" · scope ${validated.scope}`,
      "",
    );
    shown.forEach((hit, position) => {
      lines.push(...formatRecallSearchHit(hit, position + 1), "");
    });
  }

  if (mapped.dropped > 0) {
    lines.push(
      `${mapped.dropped} hit(s) were dropped because their parent text no longer matches the index; run /recall embedding build to repair it.`,
    );
  }
  if (found.reason !== undefined) {
    lines.push(`Search note: ${found.reason}.`);
  }

  return { content: lines.join("\n").trimEnd(), status: "success" };
}

// ---------------------------------------------------------------------------
// The shared query encoder
// ---------------------------------------------------------------------------

interface SharedQueryEncoder {
  key: string;
  encoder: EmbeddingQueryEncoder;
}

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
 * Same rule as the turn path's own cache (`recall-embedding-arms.ts`): creating a
 * fresh encoder per call acquires a new reference on the shared worker and never
 * releases it, so the reference count would grow without bound. One handle per
 * agent keeps that stable and lets a configuration change shut the previous one
 * down. The `recall-embedding-arms.ts` helper is not exported, so this module
 * keeps its own copy rather than widening the turn path's API.
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
export async function resetRecallSearchEncoderCacheForTests(): Promise<void> {
  const encoders = [...sharedEncodersByAgent.values()];
  sharedEncodersByAgent.clear();
  await Promise.allSettled(encoders.map((entry) => entry.encoder.dispose()));
}
