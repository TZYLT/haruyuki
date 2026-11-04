import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DownloadFileOptions } from "./download-http";
import { downloadToFile } from "./download-http";
import {
  defaultDownloadStagingDir,
  EmbeddingModelDownloadError,
  type EmbeddingModelDownloader,
  type EmbeddingModelDownloadProgress,
  type FetchEmbeddingModelOptions,
  fetchEmbeddingModel,
  importModelFromDirectory,
  isEmbeddingModelInstalled,
  MODEL_INSTALL_MANIFEST_FILE_NAME,
  readEmbeddingModelInstallManifest,
  readEmbeddingModelNegativeCache,
  uninstallEmbeddingModel,
} from "./model-download";
import {
  BGE_ZH_LICENSE,
  type EmbeddingModelFile,
  type EmbeddingModelManifest,
} from "./model-manifest";

// ---------------------------------------------------------------------------
// Fixtures and a 127.0.0.1-only mock server. Nothing in this file resolves a
// public hostname.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      const closable = server as http.Server & {
        closeAllConnections?: () => void;
      };
      closable.closeAllConnections?.();
    });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

const TOKENIZER_BODY = Buffer.from(
  JSON.stringify({ version: "1.0", model: { type: "BPE" } }),
);
const WEIGHTS_BODY = (() => {
  const body = Buffer.alloc(4_096);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (index * 37 + 11) % 256;
  }
  return body;
})();
const CONFIG_BODY = Buffer.from("{}");

const BODIES = new Map<string, Buffer>([
  ["tokenizer.json", TOKENIZER_BODY],
  ["onnx/model.onnx", WEIGHTS_BODY],
  ["config.json", CONFIG_BODY],
]);

interface RequestRecord {
  readonly pathname: string;
  readonly range: string | null;
}

interface RouteResult {
  readonly body?: Buffer;
  readonly status?: number;
  readonly delayMs?: number;
}

interface MockServer {
  readonly origin: string;
  readonly requests: RequestRecord[];
  readonly server: http.Server;
}

async function startMockServer(
  handler: (request: RequestRecord) => RouteResult | Promise<RouteResult>,
): Promise<MockServer> {
  const requests: RequestRecord[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const record: RequestRecord = {
      pathname: url.pathname,
      range:
        typeof request.headers.range === "string"
          ? request.headers.range
          : null,
    };
    requests.push(record);
    void (async () => {
      const route = await handler(record);
      if (route.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, route.delayMs));
      }
      if (route.status !== undefined) {
        response.writeHead(route.status).end();
        return;
      }
      const body = route.body ?? Buffer.alloc(0);
      const start = parseRangeStart(record.range);
      if (start !== null && start > 0 && start < body.length) {
        response
          .writeHead(206, {
            "content-type": "application/octet-stream",
            "content-length": body.length - start,
            "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
            "accept-ranges": "bytes",
          })
          .end(body.subarray(start));
        return;
      }
      response
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": body.length,
          "accept-ranges": "bytes",
        })
        .end(body);
    })().catch(() => {
      response.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server did not bind a TCP port");
  }
  return { origin: `http://127.0.0.1:${address.port}`, requests, server };
}

function parseRangeStart(range: string | null): number | null {
  if (range === null) return null;
  const match = /^bytes=(\d+)-$/.exec(range);
  if (match === null) return null;
  return Number(match[1]);
}

/** Map `/primary/acme/test-model/<path>` back to its fixture body. */
function bodyFor(request: RequestRecord): RouteResult {
  const relative = request.pathname.replace(
    /^\/(?:primary|mirror)\/acme\/test-model\//,
    "",
  );
  const body = BODIES.get(relative);
  return body === undefined ? { status: 404 } : { body };
}

function isPrimary(request: RequestRecord): boolean {
  return request.pathname.startsWith("/primary/");
}

interface FixtureOptions {
  readonly pinned?: boolean;
  readonly includeOptionalConfig?: boolean;
}

interface Fixture {
  readonly manifest: EmbeddingModelManifest;
}

function makeFixture(
  server: MockServer,
  options: FixtureOptions = {},
): Fixture {
  const required = [
    { path: "tokenizer.json", body: TOKENIZER_BODY },
    { path: "onnx/model.onnx", body: WEIGHTS_BODY },
  ];
  const files: EmbeddingModelFile[] = required.map(
    ({ path: filePath, body }) => ({
      path: filePath,
      bytes: body.length,
      sha256: options.pinned === false ? null : sha256(body),
    }),
  );
  if (options.includeOptionalConfig === true) {
    files.push({
      path: "config.json",
      bytes: CONFIG_BODY.length,
      sha256: null,
      optional: true,
    });
  }
  return {
    manifest: {
      id: "test-model",
      displayName: "test model",
      repository: "acme/test-model",
      dimensions: 384,
      maxTokens: 256,
      inputNames: ["input_ids", "attention_mask"],
      pooling: "mean",
      normalize: true,
      queryInstruction: null,
      documentInstruction: null,
      license: BGE_ZH_LICENSE,
      files,
      sources: [
        {
          id: "primary",
          kind: "hf",
          urlTemplate: `${server.origin}/primary/{repo}/{path}`,
        },
        {
          id: "mirror",
          kind: "hf",
          urlTemplate: `${server.origin}/mirror/{repo}/{path}`,
        },
      ],
      quantization: "fp32",
      integrityPinned: options.pinned !== false,
    },
  };
}

function modelOptions(
  root: string,
  manifest: EmbeddingModelManifest,
  overrides: Partial<FetchEmbeddingModelOptions> = {},
): FetchEmbeddingModelOptions {
  return {
    manifest,
    modelDir: join(root, "model"),
    stateFile: join(root, "state", "model-download-state.json"),
    diskFreeBytes: () => Number.MAX_SAFE_INTEGER,
    env: {},
    ...overrides,
  };
}

async function rejectionKind(
  promise: Promise<unknown>,
): Promise<EmbeddingModelDownloadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmbeddingModelDownloadError) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

function modelPath(modelDir: string): string {
  return join(modelDir, "onnx", "model.onnx");
}

// ---------------------------------------------------------------------------
// Download flow
// ---------------------------------------------------------------------------

describe("fetchEmbeddingModel", () => {
  test("downloads every file and commits atomically", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const phases: string[] = [];
    const result = await fetchEmbeddingModel(
      modelOptions(root, manifest, {
        onProgress: (progress: EmbeddingModelDownloadProgress) => {
          phases.push(progress.phase);
        },
      }),
    );

    expect(result.alreadyInstalled).toBe(false);
    expect(result.downloadedFiles).toBe(2);
    expect(result.resumedFiles).toBe(0);
    expect(result.integrity).toBe("sha256");
    expect(result.warnings).toEqual([]);
    expect(readFileSync(join(root, "model", "tokenizer.json"))).toEqual(
      TOKENIZER_BODY,
    );
    expect(readFileSync(modelPath(join(root, "model")))).toEqual(WEIGHTS_BODY);
    expect(existsSync(defaultDownloadStagingDir(join(root, "model")))).toBe(
      false,
    );
    const installed = result.installManifest;
    expect(installed.source).toBe("download");
    expect(installed.integrity).toBe("sha256");
    expect(installed.totalBytes).toBe(
      TOKENIZER_BODY.length + WEIGHTS_BODY.length,
    );
    expect(installed.files.map((file) => file.source)).toEqual([
      "primary",
      "primary",
    ]);
    expect(phases[0]).toBe("precheck");
    expect(phases).toContain("download");
    expect(phases).toContain("verify");
    expect(phases.at(-1)).toBe("commit");
  });

  test("falls back to the next source after a 404", async () => {
    const server = await startMockServer((request) =>
      isPrimary(request) ? { status: 404 } : bodyFor(request),
    );
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const result = await fetchEmbeddingModel(modelOptions(root, manifest));

    expect(result.installManifest.files.map((file) => file.source)).toEqual([
      "mirror",
      "mirror",
    ]);
    // One failed primary request then one mirror request per file.
    expect(server.requests.length).toBe(4);
    expect(server.requests[0]?.pathname).toStartWith("/primary/");
    expect(server.requests[1]?.pathname).toStartWith("/mirror/");
  });

  test("resumes a partial file with Range when the source is unchanged", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const staging = defaultDownloadStagingDir(join(root, "model"));
    const partPath = join(staging, "onnx", "model.onnx.part");
    mkdirSync(dirname(partPath), { recursive: true });
    const half = Math.floor(WEIGHTS_BODY.length / 2);
    writeFileSync(partPath, WEIGHTS_BODY.subarray(0, half));
    writeFileSync(
      `${partPath}.part.meta.json`,
      JSON.stringify({ sourceId: "primary" }),
    );

    const result = await fetchEmbeddingModel(modelOptions(root, manifest));
    expect(result.resumedFiles).toBe(1);
    expect(result.downloadedFiles).toBe(1);
    const onnxRequests = server.requests.filter((request) =>
      request.pathname.endsWith("/onnx/model.onnx"),
    );
    expect(onnxRequests).toHaveLength(1);
    expect(onnxRequests[0]?.range).toBe(`bytes=${half}-`);
    expect(readFileSync(modelPath(join(root, "model")))).toEqual(WEIGHTS_BODY);
  });

  test("restarts instead of concatenating when the source changes", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const staging = defaultDownloadStagingDir(join(root, "model"));
    const partPath = join(staging, "onnx", "model.onnx.part");
    mkdirSync(dirname(partPath), { recursive: true });
    writeFileSync(partPath, WEIGHTS_BODY.subarray(0, 100));
    writeFileSync(
      `${partPath}.part.meta.json`,
      JSON.stringify({ sourceId: "mirror" }),
    );

    const result = await fetchEmbeddingModel(modelOptions(root, manifest));
    expect(result.resumedFiles).toBe(0);
    const onnxRequest = server.requests.find((request) =>
      request.pathname.endsWith("/onnx/model.onnx"),
    );
    expect(onnxRequest?.range).toBeNull();
    expect(readFileSync(modelPath(join(root, "model")))).toEqual(WEIGHTS_BODY);
  });

  test("deletes a corrupt file and retries the next source", async () => {
    const corrupted = Buffer.from(WEIGHTS_BODY);
    const firstWeightByte = corrupted[0] ?? 0;
    corrupted[0] = firstWeightByte === 0 ? 1 : firstWeightByte - 1;
    const server = await startMockServer((request) => {
      if (isPrimary(request) && request.pathname.endsWith("/onnx/model.onnx")) {
        return { body: corrupted };
      }
      return bodyFor(request);
    });
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const result = await fetchEmbeddingModel(modelOptions(root, manifest));

    expect(result.installManifest.files.map((file) => file.source)).toEqual([
      "primary",
      "mirror",
    ]);
    expect(readFileSync(modelPath(join(root, "model")))).toEqual(WEIGHTS_BODY);
  });

  test("reports checksum when every source serves corrupt bytes", async () => {
    const corrupted = Buffer.from(TOKENIZER_BODY);
    const firstTokenizerByte = corrupted[0] ?? 0;
    corrupted[0] = firstTokenizerByte === 0 ? 1 : firstTokenizerByte - 1;
    const server = await startMockServer((request) => {
      if (request.pathname.endsWith("/tokenizer.json")) {
        return { body: corrupted };
      }
      return bodyFor(request);
    });
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const error = await rejectionKind(
      fetchEmbeddingModel(modelOptions(root, manifest)),
    );
    expect(error.kind).toBe("checksum");
    expect(error.failures).toHaveLength(2);
    expect(existsSync(join(root, "model"))).toBe(false);
  });

  test("refuses an unpinned manifest before any network access", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server, { pinned: false });
    const error = await rejectionKind(
      fetchEmbeddingModel(modelOptions(root, manifest)),
    );
    expect(error.kind).toBe("unverified");
    expect(error.message).toContain("tokenizer.json");
    expect(server.requests).toHaveLength(0);
    expect(existsSync(join(root, "model"))).toBe(false);
  });

  test("the built-in manifest is refused by default until its digests are pinned", async () => {
    const root = makeTempDir("hryk-model-download-");
    const error = await rejectionKind(
      fetchEmbeddingModel({
        modelDir: join(root, "bge-small-zh-v1.5"),
        stateFile: join(root, "state.json"),
        diskFreeBytes: false,
        env: {},
      }),
    );
    expect(error.kind).toBe("unverified");
    expect(error.modelId).toBe("bge-small-zh-v1.5");
  });

  test("size-only opt-in downloads, warns and records computed digests", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const warnings: string[] = [];
    const { manifest } = makeFixture(server, { pinned: false });
    const result = await fetchEmbeddingModel(
      modelOptions(root, manifest, {
        allowUnpinnedIntegrity: true,
        onWarning: (warning) => warnings.push(warning.code),
      }),
    );
    expect(result.integrity).toBe("size-only");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "integrity-unpinned",
    ]);
    expect(warnings).toEqual(["integrity-unpinned"]);
    expect(result.installManifest.integrity).toBe("size-only");
    for (const file of result.installManifest.files) {
      expect(file.sha256).toBe(
        sha256(BODIES.get(file.path) ?? Buffer.alloc(0)),
      );
    }
  });

  test("size-only verification still rejects a wrong-size body", async () => {
    const server = await startMockServer((request) => {
      if (request.pathname.endsWith("/tokenizer.json")) {
        return { body: Buffer.from("short") };
      }
      return bodyFor(request);
    });
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server, { pinned: false });
    const error = await rejectionKind(
      fetchEmbeddingModel(
        modelOptions(root, manifest, { allowUnpinnedIntegrity: true }),
      ),
    );
    expect(error.kind).toBe("checksum");
    expect(existsSync(join(root, "model"))).toBe(false);
  });

  test("fails fast when the disk lacks the model size plus headroom", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const error = await rejectionKind(
      fetchEmbeddingModel(
        modelOptions(root, manifest, { diskFreeBytes: () => 1_024 }),
      ),
    );
    expect(error.kind).toBe("disk");
    expect(error.message).toContain("MiB");
    expect(server.requests).toHaveLength(0);
    expect(existsSync(join(root, "model"))).toBe(false);
  });

  test("leaves no half-installed directory when a later file fails", async () => {
    const server = await startMockServer((request) =>
      request.pathname.endsWith("/onnx/model.onnx")
        ? { status: 404 }
        : bodyFor(request),
    );
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const error = await rejectionKind(
      fetchEmbeddingModel(modelOptions(root, manifest)),
    );
    expect(error.kind).toBe("download");
    expect(existsSync(join(root, "model"))).toBe(false);
  });

  test("discards a staging directory left after an interrupted commit", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const staging = defaultDownloadStagingDir(join(root, "model"));
    mkdirSync(join(staging, "onnx"), { recursive: true });
    writeFileSync(join(staging, "stale.bin"), "stale");
    writeFileSync(
      join(staging, MODEL_INSTALL_MANIFEST_FILE_NAME),
      JSON.stringify({ manifestVersion: 1 }),
    );

    const result = await fetchEmbeddingModel(modelOptions(root, manifest));
    expect(result.alreadyInstalled).toBe(false);
    expect(existsSync(join(root, "model", "stale.bin"))).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(modelPath(join(root, "model")))).toBe(true);
  });

  test("tolerates a missing optional file with a warning", async () => {
    const server = await startMockServer((request) =>
      request.pathname.endsWith("/config.json")
        ? { status: 404 }
        : bodyFor(request),
    );
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server, { includeOptionalConfig: true });
    const result = await fetchEmbeddingModel(modelOptions(root, manifest));
    expect(result.alreadyInstalled).toBe(false);
    expect(result.skippedFiles).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "optional-file-missing",
    ]);
    expect(existsSync(join(root, "model", "config.json"))).toBe(false);
  });

  test("is idempotent once installed and exposes read/uninstall", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const first = await fetchEmbeddingModel(modelOptions(root, manifest));
    const requestCount = server.requests.length;

    const second = await fetchEmbeddingModel(modelOptions(root, manifest));
    expect(second.alreadyInstalled).toBe(true);
    expect(second.downloadedFiles).toBe(0);
    expect(server.requests.length).toBe(requestCount);

    const marker = await readEmbeddingModelInstallManifest(manifest.id, {
      modelDir: first.modelDir,
    });
    expect(marker?.totalBytes).toBe(first.installManifest.totalBytes);
    expect(
      await isEmbeddingModelInstalled({ manifest, modelDir: first.modelDir }),
    ).toBe(true);

    expect(
      await uninstallEmbeddingModel(manifest.id, {
        modelDir: first.modelDir,
        manifest,
      }),
    ).toBe(true);
    expect(existsSync(first.modelDir)).toBe(false);
    expect(
      await isEmbeddingModelInstalled({ manifest, modelDir: first.modelDir }),
    ).toBe(false);
  });

  test("serialises concurrent fetches of the same model", async () => {
    const server = await startMockServer((request) => ({
      ...bodyFor(request),
      delayMs: 25,
    }));
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const [left, right] = await Promise.all([
      fetchEmbeddingModel(modelOptions(root, manifest)),
      fetchEmbeddingModel(modelOptions(root, manifest)),
    ]);
    expect(left.modelDir).toBe(right.modelDir);
    // Both callers observe the same promise, so each file is fetched once.
    expect(server.requests).toHaveLength(2);
  });

  test("cancellation keeps a resumable partial and the retry completes", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-download-");
    const { manifest } = makeFixture(server);
    const half = Math.floor(WEIGHTS_BODY.length / 2);
    const abortingDownload: EmbeddingModelDownloader = async (
      options: DownloadFileOptions,
    ) => {
      if (options.outputPath.endsWith("model.onnx.part")) {
        writeFileSync(options.outputPath, WEIGHTS_BODY.subarray(0, half), {
          flag: "w",
        });
        const abort = new Error("cancelled by test");
        abort.name = "AbortError";
        throw abort;
      }
      return downloadToFile(options);
    };

    const cancelled = await rejectionKind(
      fetchEmbeddingModel(
        modelOptions(root, manifest, { download: abortingDownload }),
      ),
    );
    expect(cancelled.kind).toBe("aborted");
    expect(existsSync(join(root, "model"))).toBe(false);
    const partPath = join(
      defaultDownloadStagingDir(join(root, "model")),
      "onnx",
      "model.onnx.part",
    );
    expect(statSync(partPath).size).toBe(half);

    const retried = await fetchEmbeddingModel(modelOptions(root, manifest));
    expect(retried.alreadyInstalled).toBe(false);
    const onnxRequest = server.requests.find((request) =>
      request.pathname.endsWith("/onnx/model.onnx"),
    );
    expect(onnxRequest?.range).toBe(`bytes=${half}-`);
    expect(readFileSync(modelPath(join(root, "model")))).toEqual(WEIGHTS_BODY);
  });

  test("defaults the model directory through the call-time cache resolver", async () => {
    const server = await startMockServer(bodyFor);
    const home = makeTempDir("hryk-model-home-");
    const previous = process.env.HARUYUKI_HOME;
    process.env.HARUYUKI_HOME = home;
    try {
      const { manifest } = makeFixture(server);
      const result = await fetchEmbeddingModel({
        manifest,
        diskFreeBytes: () => Number.MAX_SAFE_INTEGER,
        env: {},
      });
      expect(result.modelDir).toBe(
        join(home, "cache", "embedding", "models", "test-model"),
      );
      expect(existsSync(result.modelDir)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HARUYUKI_HOME;
      else process.env.HARUYUKI_HOME = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Negative cache
// ---------------------------------------------------------------------------

describe("negative cache", () => {
  test("skips a deterministic failure within the TTL and retries after it", async () => {
    const server = await startMockServer((request) =>
      isPrimary(request) ? { status: 404 } : bodyFor(request),
    );
    const root = makeTempDir("hryk-model-negative-");
    const { manifest } = makeFixture(server);
    let clock = 1_700_000_000_000;
    const options = modelOptions(root, manifest, { now: () => clock });

    await fetchEmbeddingModel(options);
    expect(server.requests.filter(isPrimary)).toHaveLength(2);

    server.requests.splice(0);
    await uninstallEmbeddingModel(manifest.id, {
      modelDir: join(root, "model"),
      manifest,
    });
    await fetchEmbeddingModel(options);
    expect(server.requests.filter(isPrimary)).toHaveLength(0);
    expect(server.requests).toHaveLength(2);

    const cache = await readEmbeddingModelNegativeCache(
      join(root, "state", "model-download-state.json"),
      () => clock,
    );
    expect(Object.keys(cache).some((key) => key.includes("primary"))).toBe(
      true,
    );

    // Past the one-hour deterministic TTL the mirror is tried again.
    server.requests.splice(0);
    clock += 3_700_000;
    await uninstallEmbeddingModel(manifest.id, {
      modelDir: join(root, "model"),
      manifest,
    });
    await fetchEmbeddingModel(options);
    expect(server.requests.filter(isPrimary)).toHaveLength(2);
  });

  test("caches transient failures for five minutes, never permanently", async () => {
    const server = await startMockServer((request) =>
      isPrimary(request) ? { status: 503 } : bodyFor(request),
    );
    const root = makeTempDir("hryk-model-negative-");
    const { manifest } = makeFixture(server);
    let clock = 1_700_000_000_000;
    const options = modelOptions(root, manifest, {
      now: () => clock,
      download: (downloadOptions) =>
        downloadToFile({ ...downloadOptions, maxRetries: 0 }),
    });

    await fetchEmbeddingModel(options);
    const primaryAfterFirst = server.requests.filter(isPrimary).length;
    expect(primaryAfterFirst).toBe(2);

    server.requests.splice(0);
    await uninstallEmbeddingModel(manifest.id, {
      modelDir: join(root, "model"),
      manifest,
    });
    clock += 60_000;
    await fetchEmbeddingModel(options);
    expect(server.requests.filter(isPrimary)).toHaveLength(0);

    server.requests.splice(0);
    await uninstallEmbeddingModel(manifest.id, {
      modelDir: join(root, "model"),
      manifest,
    });
    clock += 6 * 60_000;
    await fetchEmbeddingModel(options);
    expect(server.requests.filter(isPrimary)).toHaveLength(2);
  });

  test("tolerates a corrupt state file", async () => {
    const server = await startMockServer(bodyFor);
    const root = makeTempDir("hryk-model-negative-");
    const { manifest } = makeFixture(server);
    const stateFile = join(root, "state", "model-download-state.json");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, "{ this is not json");
    const result = await fetchEmbeddingModel(
      modelOptions(root, manifest, { stateFile }),
    );
    expect(result.alreadyInstalled).toBe(false);
    expect(existsSync(result.modelDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Offline import
// ---------------------------------------------------------------------------

describe("importModelFromDirectory", () => {
  function writeSourceDir(root: string): string {
    const source = join(root, "source");
    mkdirSync(join(source, "onnx"), { recursive: true });
    writeFileSync(join(source, "tokenizer.json"), TOKENIZER_BODY);
    writeFileSync(join(source, "onnx", "model.onnx"), WEIGHTS_BODY);
    return source;
  }

  test("imports a matching directory and commits it", async () => {
    const root = makeTempDir("hryk-model-import-");
    const source = writeSourceDir(root);
    const manifest = makeFixture({
      origin: "https://example.invalid",
      requests: [],
      server: {} as http.Server,
    }).manifest;
    const result = await importModelFromDirectory(source, {
      manifest,
      modelDir: join(root, "model"),
    });

    expect(result.alreadyInstalled).toBe(false);
    expect(result.importedFiles).toBe(2);
    expect(result.installManifest.source).toBe("manual");
    expect(readFileSync(join(root, "model", "tokenizer.json"))).toEqual(
      TOKENIZER_BODY,
    );
    // The user's source directory is never renamed or removed.
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(join(source, "onnx", "model.onnx"))).toEqual(
      WEIGHTS_BODY,
    );

    const second = await importModelFromDirectory(source, {
      manifest,
      modelDir: join(root, "model"),
    });
    expect(second.alreadyInstalled).toBe(true);
    expect(second.importedFiles).toBe(0);
  });

  test("rejects a wrong sha256 and leaves no install", async () => {
    const root = makeTempDir("hryk-model-import-");
    const source = writeSourceDir(root);
    const corrupt = Buffer.from(WEIGHTS_BODY);
    const fourthWeightByte = corrupt[3] ?? 0;
    corrupt[3] = fourthWeightByte === 0 ? 1 : fourthWeightByte - 1;
    writeFileSync(join(source, "onnx", "model.onnx"), corrupt);
    const { manifest } = makeFixture({
      origin: "https://example.invalid",
      requests: [],
      server: {} as http.Server,
    });

    const error = await rejectionKind(
      importModelFromDirectory(source, {
        manifest,
        modelDir: join(root, "model"),
      }),
    );
    expect(error.kind).toBe("checksum");
    expect(existsSync(join(root, "model"))).toBe(false);
    // The import copies into a random `.model.import-*` sibling and has no
    // resumable state, so a failed run must not leave that copy behind.
    expect(
      readdirSync(root).filter((entry) => entry.startsWith(".model.import-")),
    ).toEqual([]);
  });

  test("rejects a missing required file", async () => {
    const root = makeTempDir("hryk-model-import-");
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "tokenizer.json"), TOKENIZER_BODY);
    const { manifest } = makeFixture({
      origin: "https://example.invalid",
      requests: [],
      server: {} as http.Server,
    });

    const error = await rejectionKind(
      importModelFromDirectory(source, {
        manifest,
        modelDir: join(root, "model"),
      }),
    );
    expect(error.kind).toBe("io");
    expect(error.message).toContain("onnx/model.onnx");
    expect(existsSync(join(root, "model"))).toBe(false);
  });

  test("requires the unpinned opt-in", async () => {
    const root = makeTempDir("hryk-model-import-");
    const source = writeSourceDir(root);
    const { manifest } = makeFixture(
      {
        origin: "https://example.invalid",
        requests: [],
        server: {} as http.Server,
      },
      { pinned: false },
    );
    const error = await rejectionKind(
      importModelFromDirectory(source, {
        manifest,
        modelDir: join(root, "model"),
      }),
    );
    expect(error.kind).toBe("unverified");
    expect(existsSync(join(root, "model"))).toBe(false);
  });
});
