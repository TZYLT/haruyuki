import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_WORKER_PROTOCOL_VERSION,
  type EmbeddingWorkerReadyFrame,
  isEmbeddingWorkerRequestType,
  MAX_TEXT_CHARS,
  MAX_TEXTS_PER_REQUEST,
  normalizeInitOptions,
  optionalPositiveInteger,
  parseEmbeddingWorkerFrame,
  requireEmbedTexts,
  requireStringArray,
  requireText,
  splitEmbeddingWorkerLines,
  truncateMessage,
  WorkerRequestError,
} from "./worker-protocol";

async function* chunks(
  ...values: (string | Uint8Array)[]
): AsyncGenerator<string | Uint8Array> {
  for (const value of values) yield value;
}

async function collect(
  source: AsyncIterable<string | Uint8Array>,
): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of splitEmbeddingWorkerLines(source)) lines.push(line);
  return lines;
}

const READY: EmbeddingWorkerReadyFrame = {
  type: "ready",
  protocol: EMBEDDING_WORKER_PROTOCOL_VERSION,
  pid: 1234,
  runtime: "bun",
  startedAt: 1_700_000_000_000,
};

describe("parseEmbeddingWorkerFrame", () => {
  test("parses a ready frame", () => {
    expect(parseEmbeddingWorkerFrame(JSON.stringify(READY))).toEqual(READY);
  });

  test("parses result frames with arbitrary result payloads", () => {
    const frame = parseEmbeddingWorkerFrame(
      JSON.stringify({ type: "result", id: 7, result: { dim: 512 } }),
    );
    expect(frame).toEqual({ type: "result", id: 7, result: { dim: 512 } });
  });

  test("parses typed error frames, including requestType", () => {
    const frame = parseEmbeddingWorkerFrame(
      JSON.stringify({
        type: "error",
        id: null,
        error: { code: "protocol", message: "bad", requestType: "embed" },
      }),
    );
    expect(frame).toEqual({
      type: "error",
      id: null,
      error: { code: "protocol", message: "bad", requestType: "embed" },
    });
  });

  test("defaults the error message when the worker omits it", () => {
    const frame = parseEmbeddingWorkerFrame(
      JSON.stringify({ type: "error", id: 3, error: { code: "internal" } }),
    );
    expect(frame).toMatchObject({
      type: "error",
      error: { message: "unknown error" },
    });
  });

  test("rejects empty, non-JSON and non-object frames", () => {
    expect(() => parseEmbeddingWorkerFrame("  ")).toThrow(/empty frame/);
    expect(() => parseEmbeddingWorkerFrame("not json")).toThrow(/not JSON/);
    expect(() => parseEmbeddingWorkerFrame("[1,2]")).toThrow(/not an object/);
  });

  test("rejects malformed ready frames", () => {
    expect(() =>
      parseEmbeddingWorkerFrame(JSON.stringify({ ...READY, protocol: "1" })),
    ).toThrow(/malformed ready/);
    expect(() =>
      parseEmbeddingWorkerFrame(JSON.stringify({ ...READY, runtime: "deno" })),
    ).toThrow(/malformed ready/);
  });

  test("rejects result frames without an id", () => {
    expect(() =>
      parseEmbeddingWorkerFrame(JSON.stringify({ type: "result", result: 1 })),
    ).toThrow(/without an id/);
  });

  test("rejects error frames with a bad id or no code", () => {
    expect(() =>
      parseEmbeddingWorkerFrame(
        JSON.stringify({ type: "error", id: "x", error: { code: "internal" } }),
      ),
    ).toThrow(/bad id/);
    expect(() =>
      parseEmbeddingWorkerFrame(
        JSON.stringify({ type: "error", id: 1, error: {} }),
      ),
    ).toThrow(/without a code/);
  });

  test("rejects unknown frame types", () => {
    expect(() =>
      parseEmbeddingWorkerFrame(JSON.stringify({ type: "progress", id: 1 })),
    ).toThrow(/unknown frame type/);
  });
});

describe("splitEmbeddingWorkerLines", () => {
  test("splits concatenated frames in one chunk", async () => {
    expect(await collect(chunks('{"a":1}\n{"b":2}\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  test("reassembles a frame split across chunks", async () => {
    expect(await collect(chunks('{"a":', "1}\n"))).toEqual(['{"a":1}']);
  });

  test("keeps a multi-byte character split across chunks intact", async () => {
    const bytes = new TextEncoder().encode('{"text":"嵌入"}\n');
    const splitAt = bytes.indexOf(0xe5) + 1;
    const lines = await collect(
      chunks(bytes.slice(0, splitAt), bytes.slice(splitAt)),
    );
    expect(lines).toEqual(['{"text":"嵌入"}']);
  });

  test("strips CRLF line endings", async () => {
    expect(await collect(chunks('{"a":1}\r\n'))).toEqual(['{"a":1}']);
  });

  test("emits a trailing line without a newline at end of stream", async () => {
    expect(await collect(chunks('{"a":1}\n{"b":2}'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  test("yields nothing for an empty stream", async () => {
    expect(await collect(chunks())).toEqual([]);
  });
});

describe("validators", () => {
  test("optionalPositiveInteger applies the fallback and rejects bad values", () => {
    expect(optionalPositiveInteger(undefined, "x", 5)).toBe(5);
    expect(optionalPositiveInteger(9, "x", 5)).toBe(9);
    for (const value of [0, -1, 1.5, "3"]) {
      expect(() => optionalPositiveInteger(value, "x", 5)).toThrow(
        WorkerRequestError,
      );
    }
  });

  test("requireText rejects empty or whitespace-only values", () => {
    expect(requireText("ok", "field")).toBe("ok");
    for (const value of ["", "   ", 3, null]) {
      expect(() => requireText(value, "field")).toThrow(/non-empty string/);
    }
  });

  test("requireEmbedTexts enforces count, type and length bounds", () => {
    expect(requireEmbedTexts(["a", "b"])).toEqual(["a", "b"]);
    expect(() => requireEmbedTexts([])).toThrow(/non-empty array/);
    expect(() => requireEmbedTexts("a")).toThrow(/non-empty array/);
    expect(() => requireEmbedTexts([1])).toThrow(/not a string/);
    expect(() =>
      requireEmbedTexts(
        Array.from({ length: MAX_TEXTS_PER_REQUEST + 1 }, () => "x"),
      ),
    ).toThrow(/at most/);
    expect(() => requireEmbedTexts(["x".repeat(MAX_TEXT_CHARS + 1)])).toThrow(
      /exceeds/,
    );
  });

  test("requireStringArray rejects empty or non-string entries", () => {
    expect(requireStringArray(["cpu"], "providers")).toEqual(["cpu"]);
    expect(() => requireStringArray([], "providers")).toThrow(
      /non-empty array/,
    );
    expect(() => requireStringArray(["cpu", ""], "providers")).toThrow(
      /non-empty strings/,
    );
  });

  test("WorkerRequestError carries a stable code", () => {
    const error = new WorkerRequestError("invalid-request", "nope");
    expect(error.code).toBe("invalid-request");
    expect(error.name).toBe("WorkerRequestError");
  });

  test("truncateMessage ellipsizes long text", () => {
    expect(truncateMessage("abc", 2)).toBe("ab…");
    expect(truncateMessage("abc", 10)).toBe("abc");
  });

  test("isEmbeddingWorkerRequestType accepts only known types", () => {
    for (const type of ["init", "embed", "cancel", "stats", "shutdown"]) {
      expect(isEmbeddingWorkerRequestType(type)).toBe(true);
    }
    for (const type of ["nope", 1, null, undefined]) {
      expect(isEmbeddingWorkerRequestType(type)).toBe(false);
    }
  });
});

describe("normalizeInitOptions", () => {
  const defaults = {
    maxTokens: 512,
    maxBatchSize: 8,
    maxBatchTokens: 1_700,
    warmupText: ".",
  };
  const base = {
    runtimeDir: "/cache/runtime/1.31.1",
    modelPath: "/cache/models/bge/model.onnx",
    tokenizerPath: "/cache/models/bge/tokenizer.json",
  };

  test("fills defaults for omitted tuning fields", () => {
    expect(normalizeInitOptions(base, defaults)).toEqual({
      ...base,
      maxTokens: 512,
      maxBatchSize: 8,
      maxBatchTokens: 1_700,
      intraOpThreads: undefined,
      executionProviders: undefined,
      pooling: "mean",
      warmupText: ".",
    });
  });

  test("preserves explicit values", () => {
    const options = normalizeInitOptions(
      {
        ...base,
        maxTokens: 128,
        maxBatchSize: 1,
        maxBatchTokens: 64,
        intraOpThreads: 2,
        executionProviders: ["dml", "cpu"],
        pooling: "last",
        warmupText: "hi",
      },
      defaults,
    );
    expect(options.maxTokens).toBe(128);
    expect(options.intraOpThreads).toBe(2);
    expect(options.executionProviders).toEqual(["dml", "cpu"]);
    expect(options.pooling).toBe("last");
    expect(options.warmupText).toBe("hi");
  });

  test("rejects missing required paths and bad tuning values", () => {
    expect(() =>
      normalizeInitOptions({ ...base, runtimeDir: "" }, defaults),
    ).toThrow(/runtimeDir/);
    expect(() =>
      normalizeInitOptions({ ...base, maxBatchTokens: 0 }, defaults),
    ).toThrow(/maxBatchTokens/);
    expect(() =>
      normalizeInitOptions({ ...base, executionProviders: [] }, defaults),
    ).toThrow(/executionProviders/);
    expect(() =>
      normalizeInitOptions(
        { ...base, pooling: "median" as unknown as "mean" },
        defaults,
      ),
    ).toThrow(/pooling/);
  });
});
