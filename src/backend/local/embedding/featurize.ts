/**
 * Tokenizer-agnostic featurization for the built-in embedding runtime (C3).
 *
 * **What this module is.** The onnxruntime session produces raw hidden states:
 * one vector per token, `[sequence, token, dimension]`. Turning that into one
 * embedding per input is arithmetic, not model plumbing, so it lives here as
 * pure functions that never touch a tokenizer, ORT, the filesystem or a clock:
 *
 * 1. **Mask-weighted mean pooling** — pad positions must not contribute, so the
 *    attention mask is the pooling weight (48-1 §6.4). A mask whose weights sum
 *    to zero has no defined mean and is rejected rather than silently returned
 *    as a zero vector.
 * 2. **L2 normalization** — the index stores one vector per chunk and retrieval
 *    is an inner product, which equals cosine only for unit vectors (48-1
 *    §6.4/§6.3). A zero-norm row cannot be normalized; after normalization the
 *    norm must be 1 ± 1e-6, and C6's endpoint check allows 1 ± 0.01.
 * 3. **Batch assembly** — greedy packing of tokenized sequences into inference
 *    batches capped by both a sequence count and a token count. The token cap
 *    is the cancellation granularity: ORT's `session.run` cannot be preempted,
 *    so a batch is the longest uninterruptible unit (48-2 §4.4: ≤1,700 tokens
 *    ≈200 ms).
 * 4. **Vector framing** — `Float32Array` ↔ base64 (little-endian, explicit
 *    `DataView` endianness so the wire format does not depend on the host CPU).
 *    The worker returns vectors as base64 strings instead of JSON number arrays:
 *    a 512-dim float vector is 2,732 base64 chars versus ~6,000 chars of JSON,
 *    and the bytes are exact.
 *
 * **Why pure and injected.** `worker-entry.ts` calls these functions per batch;
 * `worker-client.ts` calls the decoder on every response. Keeping the arithmetic
 * here means the worker tests use a fake session/tokenizer and still exercise
 * the real pooling and normalization code (no ORT, no network).
 *
 * **Determinism.** No randomness, no time, no locale, no environment reads.
 * Given the same hidden states and mask, every function returns bit-identical
 * output. Iteration order is the caller's input order; nothing is sorted.
 *
 * Layer: `backend/local/`. Imports only `node:buffer`; no domain imports.
 */

import { Buffer } from "node:buffer";

/** Default cap on sequences packed into one inference batch. */
export const DEFAULT_BATCH_MAX_SIZE = 8;

/**
 * Default cap on tokens packed into one inference batch (48-2 §4.4: 8.8k tok/s
 * → ≤1,700 token/批 ≈200 ms, which is also the cancel granularity).
 */
export const DEFAULT_BATCH_MAX_TOKENS = 1_700;

/** Why a featurization input was refused. */
export type FeaturizeErrorKind =
  | "invalid-argument"
  | "invalid-mask"
  | "invalid-shape"
  | "invalid-vector"
  | "non-finite"
  | "zero-norm";

/**
 * Typed featurization failure. `kind` is stable API: the worker maps it to an
 * error-frame code, so callers must not have to parse the message.
 */
export class FeaturizeError extends Error {
  readonly kind: FeaturizeErrorKind;

  constructor(kind: FeaturizeErrorKind, message: string) {
    super(message);
    this.name = "FeaturizeError";
    this.kind = kind;
  }
}

/**
 * One tokenized text as handed over by a tokenizer adapter. `attentionMask`
 * defaults to all ones; `tokenTypeIds` is optional because the BGE models do not
 * take segment ids.
 */
export interface TokenizedSequence {
  readonly inputIds: readonly number[];
  readonly attentionMask?: readonly number[];
  readonly tokenTypeIds?: readonly number[];
}

/** Options for {@link maskedMeanPool}: one sequence's row-major hidden state. */
export interface MaskedPoolOptions {
  /** Token count (rows) in `hidden`. */
  readonly tokens: number;
  /** Hidden size (columns) in `hidden`. */
  readonly dim: number;
  /** One weight per token; typically a 0/1 attention mask. */
  readonly mask: readonly number[];
}

/** Options for {@link poolBatch}: a whole batch's row-major hidden state. */
export interface PooledBatchOptions {
  /** Row-major `[sequences, tokens, dim]` hidden state. */
  readonly hidden: Float32Array;
  readonly sequences: number;
  readonly tokens: number;
  readonly dim: number;
  /** One mask per sequence, each `tokens` long. */
  readonly masks: readonly (readonly number[])[];
}

/** Options for {@link planTokenBatches}. */
export interface TokenBatchOptions {
  readonly maxBatchSize?: number;
  readonly maxBatchTokens?: number;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new FeaturizeError(
      "invalid-shape",
      `${label} must be a positive integer, received ${String(value)}.`,
    );
  }
  return value;
}

function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new FeaturizeError("non-finite", `${label} is not a finite number.`);
  }
  return value;
}

/**
 * Validate and resolve the attention mask for one tokenized sequence. Padding
 * is not represented in `inputIds`, so the mask is authoritative; a missing or
 * mistyped mask is an error rather than an all-ones guess.
 */
export function resolveAttentionMask(sequence: TokenizedSequence): number[] {
  const tokenCount = sequence.inputIds.length;
  const mask = sequence.attentionMask;
  if (mask === undefined) {
    return Array.from({ length: tokenCount }, () => 1);
  }
  if (mask.length !== tokenCount) {
    throw new FeaturizeError(
      "invalid-mask",
      `The attention mask has ${mask.length} entries for ${tokenCount} input ids.`,
    );
  }
  const resolved: number[] = [];
  for (let token = 0; token < tokenCount; token += 1) {
    const weight = mask[token] ?? 0;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new FeaturizeError(
        "invalid-mask",
        `Attention mask entry ${token} is not a non-negative finite number.`,
      );
    }
    resolved.push(weight);
  }
  return resolved;
}

/** Number of tokens one sequence contributes to a batch budget. */
export function countSequenceTokens(sequence: TokenizedSequence): number {
  assertPositiveInteger(
    sequence.inputIds.length,
    "A tokenized sequence must contain at least one token",
  );
  return sequence.inputIds.length;
}

/**
 * Truncate a sequence to `maxTokens` by keeping the leading tokens. Tokenizers
 * are expected to apply their own model-specific truncation (which keeps a
 * trailing `[SEP]`); this is the worker's hard safety cap so a hostile or
 * oversized input cannot inflate an inference batch without bound.
 */
export function truncateSequence(
  sequence: TokenizedSequence,
  maxTokens: number,
): TokenizedSequence {
  assertPositiveInteger(maxTokens, "maxTokens");
  if (sequence.inputIds.length <= maxTokens) return sequence;
  const truncated: TokenizedSequence = {
    inputIds: sequence.inputIds.slice(0, maxTokens),
    attentionMask: sequence.attentionMask?.slice(0, maxTokens),
  };
  return sequence.tokenTypeIds === undefined
    ? truncated
    : { ...truncated, tokenTypeIds: sequence.tokenTypeIds.slice(0, maxTokens) };
}

function poolRow(
  hidden: Float32Array,
  rowOffset: number,
  tokens: number,
  dim: number,
  mask: readonly number[],
): Float32Array {
  if (mask.length !== tokens) {
    throw new FeaturizeError(
      "invalid-mask",
      `The attention mask has ${mask.length} entries for ${tokens} tokens.`,
    );
  }
  const pooled = new Float32Array(dim);
  let totalWeight = 0;
  for (let token = 0; token < tokens; token += 1) {
    const weight = mask[token] ?? 0;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new FeaturizeError(
        "invalid-mask",
        `Attention mask entry ${token} is not a non-negative finite number.`,
      );
    }
    if (weight === 0) continue;
    totalWeight += weight;
    const base = rowOffset + token * dim;
    for (let axis = 0; axis < dim; axis += 1) {
      const value = assertFinite(
        hidden[base + axis] ?? 0,
        `Hidden state at token ${token}, axis ${axis}`,
      );
      pooled[axis] = (pooled[axis] ?? 0) + weight * value;
    }
  }
  if (totalWeight <= 0) {
    throw new FeaturizeError(
      "invalid-mask",
      "The attention mask sums to zero, so the mean is undefined.",
    );
  }
  for (let axis = 0; axis < dim; axis += 1) {
    pooled[axis] = (pooled[axis] ?? 0) / totalWeight;
  }
  return pooled;
}

/**
 * Mask-weighted mean pooling for one sequence: `sum(mask[t] * hidden[t][:]) /
 * sum(mask)`. Pad positions (`mask[t] === 0`) are skipped entirely.
 */
export function maskedMeanPool(
  hidden: Float32Array,
  options: MaskedPoolOptions,
): Float32Array {
  const tokens = assertPositiveInteger(options.tokens, "tokens");
  const dim = assertPositiveInteger(options.dim, "dim");
  if (hidden.length !== tokens * dim) {
    throw new FeaturizeError(
      "invalid-shape",
      `Expected ${tokens * dim} hidden values for ${tokens} tokens x ${dim} dimensions, received ${hidden.length}.`,
    );
  }
  return poolRow(hidden, 0, tokens, dim, options.mask);
}

/**
 * L2-normalize a vector. Returns a new array; a zero (or non-finite) norm is a
 * typed error because a unit vector that is zero cannot be stored in a cosine
 * index without silently becoming "no similarity to anything".
 */
export function l2Normalize(vector: Float32Array): Float32Array {
  assertPositiveInteger(vector.length, "A vector must have at least one axis");
  let sumOfSquares = 0;
  for (let axis = 0; axis < vector.length; axis += 1) {
    const value = assertFinite(vector[axis] ?? 0, `Vector axis ${axis}`);
    sumOfSquares += value * value;
  }
  if (!Number.isFinite(sumOfSquares)) {
    throw new FeaturizeError(
      "non-finite",
      "The vector norm overflows a double, so it cannot be normalized.",
    );
  }
  const norm = Math.sqrt(sumOfSquares);
  if (!(norm > 0)) {
    throw new FeaturizeError(
      "zero-norm",
      "The vector has zero norm and cannot be normalized.",
    );
  }
  const normalized = new Float32Array(vector.length);
  for (let axis = 0; axis < vector.length; axis += 1) {
    normalized[axis] = (vector[axis] ?? 0) / norm;
  }
  return normalized;
}

/**
 * Pool and normalize a whole inference batch: one unit vector per sequence, in
 * input order. This is the exact path the worker uses, so the worker tests
 * exercise real masking/normalization against a fake session.
 */
export function poolBatch(options: PooledBatchOptions): Float32Array[] {
  const sequences = assertPositiveInteger(options.sequences, "sequences");
  const tokens = assertPositiveInteger(options.tokens, "tokens");
  const dim = assertPositiveInteger(options.dim, "dim");
  if (options.hidden.length !== sequences * tokens * dim) {
    throw new FeaturizeError(
      "invalid-shape",
      `Expected ${sequences * tokens * dim} hidden values for ${sequences} sequences x ${tokens} tokens x ${dim} dimensions, received ${options.hidden.length}.`,
    );
  }
  if (options.masks.length !== sequences) {
    throw new FeaturizeError(
      "invalid-mask",
      `Expected ${sequences} attention masks, received ${options.masks.length}.`,
    );
  }
  const vectors: Float32Array[] = [];
  for (let sequence = 0; sequence < sequences; sequence += 1) {
    const mask = options.masks[sequence];
    if (mask === undefined) {
      throw new FeaturizeError(
        "invalid-mask",
        `Missing attention mask for sequence ${sequence}.`,
      );
    }
    const pooled = poolRow(
      options.hidden,
      sequence * tokens * dim,
      tokens,
      dim,
      mask,
    );
    vectors.push(l2Normalize(pooled));
  }
  return vectors;
}

/** Concatenate per-sequence vectors into one row-major `Float32Array`. */
export function flattenVectors(
  vectors: readonly Float32Array[],
  dimensions?: number,
): Float32Array {
  const dim = dimensions ?? vectors[0]?.length ?? 0;
  if (vectors.length > 0) {
    assertPositiveInteger(dim, "dimensions");
    for (let index = 0; index < vectors.length; index += 1) {
      const vector = vectors[index];
      if (vector === undefined || vector.length !== dim) {
        throw new FeaturizeError(
          "invalid-shape",
          `Vector ${index} has length ${vector?.length ?? 0}, expected ${dim}.`,
        );
      }
    }
  }
  const flat = new Float32Array(vectors.length * dim);
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];
    if (vector === undefined) continue;
    flat.set(vector, index * dim);
  }
  return flat;
}

/** Copy one `dim`-wide row out of a flat vector buffer. */
export function sliceVector(
  flat: Float32Array,
  index: number,
  dimensions: number,
): Float32Array {
  assertPositiveInteger(dimensions, "dimensions");
  if (!Number.isInteger(index) || index < 0) {
    throw new FeaturizeError(
      "invalid-argument",
      `Vector index must be a non-negative integer, received ${String(index)}.`,
    );
  }
  const start = index * dimensions;
  if (start + dimensions > flat.length) {
    throw new FeaturizeError(
      "invalid-shape",
      `Vector ${index} needs ${(index + 1) * dimensions} values, received ${flat.length}.`,
    );
  }
  return flat.slice(start, start + dimensions);
}

/**
 * Encode a vector as little-endian float32 base64 (the worker's wire format).
 * Values are validated so NaN/Infinity never reaches another process as an
 * unparseable number.
 */
export function encodeVectorBase64(vector: Float32Array): string {
  assertPositiveInteger(vector.length, "A vector must have at least one axis");
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let axis = 0; axis < vector.length; axis += 1) {
    bytes.writeFloatLE(
      assertFinite(vector[axis] ?? 0, `Vector axis ${axis}`),
      axis * 4,
    );
  }
  return bytes.toString("base64");
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode {@link encodeVectorBase64} output. The payload is remote-ish data (it
 * crossed a process boundary), so the shape is validated: strict base64, a whole
 * number of float32s, and an optional expected dimension. Trailing garbage is
 * refused instead of silently truncated the way `Buffer.from(x, "base64")`
 * would.
 */
export function decodeVectorBase64(
  encoded: string,
  dimensions?: number,
): Float32Array {
  if (typeof encoded !== "string") {
    throw new FeaturizeError(
      "invalid-vector",
      "The encoded vector is not a string.",
    );
  }
  const trimmed = encoded.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) {
    throw new FeaturizeError(
      "invalid-vector",
      "The encoded vector is not padded base64.",
    );
  }
  if (!BASE64_PATTERN.test(trimmed)) {
    throw new FeaturizeError(
      "invalid-vector",
      "The encoded vector contains characters outside the base64 alphabet.",
    );
  }
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length % 4 !== 0) {
    throw new FeaturizeError(
      "invalid-vector",
      `The encoded vector is ${bytes.length} bytes, not a whole number of float32 values.`,
    );
  }
  const dim = bytes.length / 4;
  if (dim === 0) {
    throw new FeaturizeError("invalid-vector", "The encoded vector is empty.");
  }
  if (dimensions !== undefined) {
    assertPositiveInteger(dimensions, "dimensions");
    if (dim !== dimensions) {
      throw new FeaturizeError(
        "invalid-vector",
        `The encoded vector has ${dim} dimensions, expected ${dimensions}.`,
      );
    }
  }
  const vector = new Float32Array(dim);
  for (let axis = 0; axis < dim; axis += 1) {
    const value = bytes.readFloatLE(axis * 4);
    if (!Number.isFinite(value)) {
      throw new FeaturizeError(
        "invalid-vector",
        `Encoded vector axis ${axis} is not finite.`,
      );
    }
    vector[axis] = value;
  }
  return vector;
}

/** Split `items` into consecutive chunks of at most `size` entries. */
export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new FeaturizeError(
      "invalid-argument",
      `Chunk size must be a positive integer, received ${String(size)}.`,
    );
  }
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * Greedily pack tokenized sequences into inference batches bounded by both a
 * sequence count and a token count. Order is preserved; a single sequence that
 * exceeds the token budget is still emitted (alone) so callers fail on the
 * model's own limits rather than dropping input. Empty input yields no batches.
 */
export function planTokenBatches(
  sequences: readonly TokenizedSequence[],
  options: TokenBatchOptions = {},
): TokenizedSequence[][] {
  const maxBatchSize =
    options.maxBatchSize === undefined
      ? DEFAULT_BATCH_MAX_SIZE
      : assertPositiveInteger(options.maxBatchSize, "maxBatchSize");
  const maxBatchTokens =
    options.maxBatchTokens === undefined
      ? DEFAULT_BATCH_MAX_TOKENS
      : assertPositiveInteger(options.maxBatchTokens, "maxBatchTokens");

  const batches: TokenizedSequence[][] = [];
  let current: TokenizedSequence[] = [];
  let currentTokens = 0;
  for (const sequence of sequences) {
    const tokens = countSequenceTokens(sequence);
    if (
      current.length > 0 &&
      (current.length >= maxBatchSize ||
        currentTokens + tokens > maxBatchTokens)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(sequence);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Total tokens across a set of sequences (a batch budget's used portion). */
export function sumSequenceTokens(
  sequences: readonly TokenizedSequence[],
): number {
  let total = 0;
  for (const sequence of sequences) total += countSequenceTokens(sequence);
  return total;
}

/** One padded inference batch plus the masks pooling needs. */
export interface PaddedTokenBatch {
  /** Row-major `[sequences, tokens]` token ids; padding uses `padTokenId`. */
  readonly inputIds: Int32Array;
  /** Row-major `[sequences, tokens]` 0/1 attention mask. */
  readonly attentionMask: Int32Array;
  /** One mask per sequence, padded to `tokens` with zeros. */
  readonly masks: readonly number[][];
  readonly sequences: number;
  /** Padded column count (the longest sequence in this batch). */
  readonly tokens: number;
  /** Unpadded token count, for throughput/budget accounting. */
  readonly tokenTotal: number;
}

/**
 * Pad tokenized sequences into one int32 batch. Pooling later multiplies by the
 * mask, so a pad position can never contribute; pad ids are only there to keep
 * the tensor rectangular. This is pure arithmetic on purpose: the worker tests
 * can assert masking without a model.
 */
export function padTokenBatch(
  sequences: readonly TokenizedSequence[],
  padTokenId = 0,
): PaddedTokenBatch {
  const rows = sequences.length;
  if (rows === 0) {
    throw new FeaturizeError(
      "invalid-shape",
      "A batch needs at least one sequence.",
    );
  }
  if (!Number.isInteger(padTokenId)) {
    throw new FeaturizeError(
      "invalid-argument",
      "padTokenId must be an integer.",
    );
  }
  let tokens = 0;
  for (const sequence of sequences) {
    tokens = Math.max(tokens, countSequenceTokens(sequence));
  }
  const inputIds = new Int32Array(rows * tokens);
  const attentionMask = new Int32Array(rows * tokens);
  const masks: number[][] = [];
  let tokenTotal = 0;
  for (let row = 0; row < rows; row += 1) {
    const sequence = sequences[row];
    if (sequence === undefined) continue;
    const ids = sequence.inputIds;
    const mask = resolveAttentionMask(sequence);
    const paddedMask = new Array<number>(tokens).fill(0);
    for (let token = 0; token < tokens; token += 1) {
      const index = row * tokens + token;
      if (token >= ids.length) {
        inputIds[index] = padTokenId;
        continue;
      }
      inputIds[index] = ids[token] ?? padTokenId;
      const weight = mask[token] ?? 1;
      attentionMask[index] = weight > 0 ? 1 : 0;
      paddedMask[token] = weight;
    }
    masks.push(paddedMask);
    tokenTotal += ids.length;
  }
  return {
    inputIds,
    attentionMask,
    masks,
    sequences: rows,
    tokens,
    tokenTotal,
  };
}

/**
 * Validate a token-level session output: a positive integer width and exactly
 * `sequences x tokens x dim` values. The worker maps this FeaturizeError onto an
 * error frame instead of letting a malformed tensor reach pooling.
 */
export function assertHiddenStateShape(
  hidden: Float32Array,
  sequences: number,
  tokens: number,
  dim: number,
): void {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new FeaturizeError(
      "invalid-shape",
      `The model returned an invalid output width: ${String(dim)}.`,
    );
  }
  const expected =
    assertPositiveInteger(sequences, "sequences") *
    assertPositiveInteger(tokens, "tokens") *
    dim;
  if (hidden.length !== expected) {
    throw new FeaturizeError(
      "invalid-shape",
      `The model returned ${hidden.length} values, expected ${expected}.`,
    );
  }
}
