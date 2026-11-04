/**
 * Tokenizer half of the embedding worker (C3, extended by C8).
 *
 * `@huggingface/tokenizers` moved its API between releases, so this module owns
 * one place that knows the current contract:
 *
 * 1. Since 0.2.0 the only documented entry point is
 *    `new Tokenizer(tokenizerJson, tokenizerConfig)`, built from the two parsed
 *    JSON files the model manifest installs next to the ONNX weights. There is
 *    no path-based constructor and no `fromFile` export — probing for one was
 *    the bug that made every real build fail with "exposes no loadable entry
 *    point".
 * 2. An older release exposed other shapes, so a module without a `Tokenizer`
 *    constructor still falls back to the legacy `fromFile(path)` / `new
 *    Module(path)` probe; a genuine mismatch remains a typed init error.
 *
 * The rest of this file normalises the package's `{ ids, attention_mask }`
 * encoding into the worker's `TokenizedSequence`, and carries the model's
 * `pad_token_id` into the batching layer.
 *
 * Layer: `backend/local/embedding/`; imports node builtins and sibling
 * embedding modules only.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TokenizedSequence, truncateSequence } from "./featurize";
import { importRuntimeModule } from "./runtime-module-import";
import { isRecord } from "./worker-protocol";

export interface EmbeddingTokenizer {
  encode(
    text: string,
    options?: { readonly maxTokens?: number },
  ): TokenizedSequence;
  readonly padTokenId?: number;
}

export type EmbeddingTokenizerLoader = (options: {
  readonly runtimeDir: string;
  readonly tokenizerPath: string;
}) => Promise<EmbeddingTokenizer>;

/**
 * Dynamic `@huggingface/tokenizers` loader.
 *
 * Reads `tokenizer.json` and its sibling `tokenizer_config.json` from the model
 * directory, then instantiates the documented `Tokenizer(json, config)` class.
 */
export function createHuggingFaceTokenizerLoader(): EmbeddingTokenizerLoader {
  return async ({ runtimeDir, tokenizerPath }) => {
    const loaded = await importRuntimeModule(
      runtimeDir,
      "@huggingface/tokenizers",
    );
    const tokenizerJson = readJsonFile(tokenizerPath, "tokenizer.json");
    const configPath = join(dirname(tokenizerPath), "tokenizer_config.json");
    const tokenizerConfig = existsSync(configPath)
      ? readJsonFile(configPath, "tokenizer_config.json")
      : {};
    const instance = instantiateTokenizer({
      loaded,
      tokenizerPath,
      tokenizerJson,
      tokenizerConfig,
    });
    const adapted = adaptTokenizer(instance);
    const padTokenId = resolvePadTokenId(tokenizerConfig, adapted.padTokenId);
    return padTokenId === undefined ? adapted : { ...adapted, padTokenId };
  };
}

/**
 * Instantiate a tokenizer from an already imported `@huggingface/tokenizers`
 * module and the parsed model JSON. Exported so the regression test can pin the
 * 0.2.0 `new Tokenizer(json, config)` contract without a downloaded runtime.
 */
export function createTokenizerFromModule(
  loaded: unknown,
  tokenizerJson: unknown,
  tokenizerConfig: unknown,
): EmbeddingTokenizer {
  return adaptTokenizer(
    instantiateTokenizer({
      loaded,
      tokenizerPath: "",
      tokenizerJson,
      tokenizerConfig,
    }),
  );
}

function readJsonFile(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${label} at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse ${label} at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

interface InstantiateTokenizerOptions {
  readonly loaded: unknown;
  readonly tokenizerPath: string;
  readonly tokenizerJson: unknown;
  readonly tokenizerConfig: unknown;
}

function instantiateTokenizer(options: InstantiateTokenizerOptions): unknown {
  const { loaded, tokenizerPath, tokenizerJson, tokenizerConfig } = options;
  const tokenizerClass = resolveTokenizerClass(loaded);
  if (tokenizerClass !== undefined) {
    // Documented `@huggingface/tokenizers` API: the constructor takes the
    // parsed tokenizer.json and tokenizer_config.json objects. Errors surface
    // unchanged so the init frame says what the model file actually got wrong.
    return new (
      tokenizerClass as new (
        json: unknown,
        config: unknown,
      ) => unknown
    )(tokenizerJson, tokenizerConfig);
  }
  for (const candidate of [
    loaded,
    isRecord(loaded) ? loaded.default : undefined,
  ]) {
    const fromFile = isRecord(candidate) ? candidate.fromFile : undefined;
    if (typeof fromFile === "function") {
      return (fromFile as (this: unknown, path: string) => unknown).call(
        candidate,
        tokenizerPath,
      );
    }
    if (typeof candidate !== "function") continue;
    try {
      return new (candidate as new (path: string) => unknown)(tokenizerPath);
    } catch {}
  }
  throw new Error(
    "The installed @huggingface/tokenizers exposes no loadable entry point.",
  );
}

function resolveTokenizerClass(loaded: unknown): unknown {
  for (const candidate of [
    loaded,
    isRecord(loaded) ? loaded.default : undefined,
  ]) {
    if (!isRecord(candidate)) continue;
    const tokenizer = candidate.Tokenizer;
    if (typeof tokenizer === "function") return tokenizer;
  }
  return undefined;
}

function resolvePadTokenId(
  tokenizerConfig: unknown,
  fallback: number | undefined,
): number | undefined {
  const record = isRecord(tokenizerConfig) ? tokenizerConfig : null;
  const candidate = record?.pad_token_id ?? record?.padTokenId;
  if (
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 0
  ) {
    return candidate;
  }
  return fallback;
}

function adaptTokenizer(instance: unknown): EmbeddingTokenizer {
  const record = isRecord(instance) ? instance : null;
  if (record === null || typeof record.encode !== "function") {
    throw new Error(
      "The installed @huggingface/tokenizers does not expose encode().",
    );
  }
  const encode = (
    record.encode as (this: unknown, text: string) => unknown
  ).bind(record);
  const padTokenId = record.padTokenId ?? record.pad_token_id;
  return {
    encode(text, options) {
      const encoded = encode(text);
      if (encoded instanceof Promise) {
        throw new Error(
          "This tokenizer only offers asynchronous encode(); the worker requires a synchronous one.",
        );
      }
      const sequence = normalizeTokenizedSequence(encoded);
      return options?.maxTokens === undefined
        ? sequence
        : truncateSequence(sequence, options.maxTokens);
    },
    ...(typeof padTokenId === "number" ? { padTokenId } : {}),
  };
}

function toNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    throw new Error(`Tokenizer field ${label} is not a numeric array.`);
  }
  const view = value as ArrayLike<number | bigint>;
  const numbers: number[] = [];
  for (let index = 0; index < view.length; index += 1) {
    const numeric = Number(view[index]);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Tokenizer field ${label} contains a non-finite id.`);
    }
    numbers.push(numeric);
  }
  return numbers;
}

function readSequenceField(
  record: Record<string, unknown>,
  keys: readonly string[],
  methods: readonly string[],
): number[] | null {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return toNumberArray(value, key);
  }
  for (const method of methods) {
    const value = record[method];
    if (typeof value !== "function") continue;
    const produced = (value as (this: unknown) => unknown).call(record);
    if (produced !== undefined && produced !== null) {
      return toNumberArray(produced, method);
    }
  }
  return null;
}

function normalizeTokenizedSequence(raw: unknown): TokenizedSequence {
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    const inputIds = toNumberArray(raw, "input_ids");
    if (inputIds.length === 0)
      throw new Error("The tokenizer produced no tokens.");
    return { inputIds };
  }
  if (!isRecord(raw)) {
    throw new Error("The tokenizer returned an unexpected encoding shape.");
  }
  const inputIds = readSequenceField(
    raw,
    ["input_ids", "ids"],
    ["getIds", "get_ids"],
  );
  if (inputIds === null || inputIds.length === 0) {
    throw new Error("The tokenizer encoding has no input_ids.");
  }
  const attentionMask = readSequenceField(
    raw,
    ["attention_mask", "attentionMask"],
    ["getAttentionMask", "get_attention_mask"],
  );
  return attentionMask === null ? { inputIds } : { inputIds, attentionMask };
}
