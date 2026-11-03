/**
 * Public shapes for the vector-recall chunker (feature 48, package B1).
 *
 * The types live in their own leaf module so `embedding-chunk.ts` (public
 * surface), `embedding-chunk-tokens.ts` and `embedding-chunk-segments.ts` can
 * all depend on them without a cycle. Nothing here has behaviour.
 */

export type EmbeddingTextSpan = {
  /** Inclusive UTF-16 offset into the parent's original text. */
  startChar: number;
  /** Exclusive UTF-16 offset into the parent's original text. */
  endChar: number;
};

export type EmbeddingChunkKind = "prose" | "table" | "list" | "json" | "log";

export type EmbeddingChunk = {
  parentId: string;
  chunkIndex: number;
  kind: EmbeddingChunkKind;
  /** Text to embed: prose only, with fenced code removed. */
  text: string;
  /** Original UTF-16 range covered by this chunk, code in between included. */
  startChar: number;
  endChar: number;
  /**
   * Prose runs copied verbatim into `text`, in original order. Joining their
   * original slices with `"\n"` reproduces `text` exactly.
   */
  spans: EmbeddingTextSpan[];
  /** Original offset of the prose midpoint; anchors the injection window. */
  focusChar: number;
  /** Conservative estimate of {@link EmbeddingChunk.text}. */
  estimatedTokens: number;
};

export type EmbeddingChunkSkipReason =
  | "empty"
  | "code-only"
  | "prose-too-short";

export type EmbeddingChunkCoverage = {
  /** Unique original characters embedded by a chunk. */
  embeddedChars: number;
  /** Original characters the parent offered to recall (code included). */
  recallableChars: number;
  /** `embeddedChars / recallableChars`; 0 when the parent is empty. */
  ratio: number;
};

export type EmbeddingChunkPlan = {
  parentId: string;
  chunks: EmbeddingChunk[];
  /** True when the parent is lexical-only; `chunks` is then empty. */
  skipVector: boolean;
  skipReason: EmbeddingChunkSkipReason | undefined;
  coverage: EmbeddingChunkCoverage;
  /** True when the per-parent chunk cap dropped part of the parent. */
  truncatedByCap: boolean;
};

export type EmbeddingChunkInput = {
  /** Parent unit id (message id, or `memory:<path>`); echoed on every chunk. */
  parentId: string;
  /** Original parent text, UTF-16; CRLF and full-width punctuation allowed. */
  text: string;
};

export type EmbeddingChunkOptions = {
  /** Soft window size; a single sentence may briefly exceed it. Default 200. */
  targetTokens?: number;
  /** Hard cap for one chunk. Default 256. */
  maxTokens?: number;
  /** Tokens repeated between adjacent prose chunks. Default 32. */
  overlapTokens?: number;
  /** Per-parent chunk cap. Default 1024. */
  maxChunksPerParent?: number;
  /** Prose floor below which a code-heavy parent is lexical-only. Default 40. */
  minProseChars?: number;
};

export const EMBEDDING_CHUNK_DEFAULTS = {
  targetTokens: 200,
  maxTokens: 256,
  overlapTokens: 32,
  maxChunksPerParent: 1024,
  minProseChars: 40,
} as const;
