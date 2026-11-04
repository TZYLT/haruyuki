import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmbeddingEndpointClient,
  type EmbeddingEndpointError,
  type EmbeddingEndpointOptions,
  type EmbeddingEndpointRequestImpl,
  isAllowedEndpointUrl,
  isEmbeddingEndpointError,
  listEmbeddingEndpointModels,
  normalizeEndpointBaseUrl,
  probeEmbeddingEndpoint,
  testEmbeddingEndpoint,
  verifyEmbeddingEndpoint,
} from "./endpoint-client";

const API_KEY = "sk-haruyuki-endpoint-test-0123456789abcdef";
const UNIT_VECTOR = [1, 0, 0] as const;
const UNIT_VECTOR_Y = [0, 1, 0] as const;

const ORIGINAL_ENV = {
  HARUYUKI_HOME: process.env.HARUYUKI_HOME,
  LETTA_LOCAL_BACKEND_DIR: process.env.LETTA_LOCAL_BACKEND_DIR,
};

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isolateHarnessHome(): void {
  const sandbox = makeTempDir("hryk-w4-c6-");
  process.env.HARUYUKI_HOME = join(sandbox, "home");
  process.env.LETTA_LOCAL_BACKEND_DIR = join(sandbox, "local-backend");
}

function restoreEnv(key: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

beforeEach(() => {
  isolateHarnessHome();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

afterAll(() => {
  restoreEnv("HARUYUKI_HOME");
  restoreEnv("LETTA_LOCAL_BACKEND_DIR");
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Local 127.0.0.1 mock server (no public network anywhere in this file)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface MockResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly hang?: boolean;
}

interface MockServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startMockServer(
  handler: (request: RecordedRequest) => MockResponse,
): Promise<MockServer> {
  const sockets = new Set<net.Socket>();
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve());
      request.on("error", () => resolve());
    });
    const recorded: RecordedRequest = {
      method: request.method ?? "",
      path: request.url ?? "/",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(recorded);
    const result = handler(recorded);
    if (result.hang === true) return;
    const text =
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body ?? {});
    response.writeHead(result.status ?? 200, {
      "content-type": "application/json",
    });
    response.end(text);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let closed = false;
  const handle: MockServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
  cleanups.push(() => handle.close());
  return handle;
}

function requestAt(server: MockServer, index: number): RecordedRequest {
  const request = server.requests[index];
  if (request === undefined) {
    throw new Error(
      `Expected request #${index}, only ${server.requests.length}`,
    );
  }
  return request;
}

function parseJsonBody(request: RecordedRequest): Record<string, unknown> {
  const parsed: unknown = JSON.parse(request.body);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Request body is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requestedInputs(request: RecordedRequest): unknown[] {
  const input = parseJsonBody(request).input;
  return Array.isArray(input) ? input : [input];
}

function openAiEmbeddingsBody(
  inputs: readonly unknown[],
  vector: readonly number[],
): unknown {
  return {
    object: "list",
    model: "text-embedding-3-small",
    data: inputs.map((_entry, index) => ({
      object: "embedding",
      index,
      embedding: [...vector],
    })),
  };
}

async function startOpenAiServer(
  vector: readonly number[] = UNIT_VECTOR,
): Promise<MockServer> {
  return await startMockServer((request) => {
    if (request.method === "GET" && request.path === "/v1/models") {
      return {
        body: {
          object: "list",
          data: [
            {
              object: "model",
              id: "text-embedding-3-small",
              owned_by: "openai",
            },
          ],
        },
      };
    }
    if (request.method === "POST" && request.path === "/v1/embeddings") {
      return { body: openAiEmbeddingsBody(requestedInputs(request), vector) };
    }
    return {
      status: 404,
      body: {
        error: { message: `unexpected ${request.method} ${request.path}` },
      },
    };
  });
}

async function startOllamaServer(
  vector: readonly number[] = UNIT_VECTOR,
): Promise<MockServer> {
  return await startMockServer((request) => {
    if (request.method === "GET" && request.path === "/api/tags") {
      return {
        body: {
          models: [
            {
              name: "nomic-embed-text:latest",
              model: "nomic-embed-text:latest",
              details: { family: "nomic-bert" },
            },
          ],
        },
      };
    }
    if (request.method === "GET" && request.path === "/api/version") {
      return { body: { version: "0.5.1" } };
    }
    if (request.method === "POST" && request.path === "/api/embed") {
      const inputs = requestedInputs(request);
      return {
        body: {
          model: "nomic-embed-text:latest",
          embeddings: inputs.map(() => [...vector]),
        },
      };
    }
    return {
      status: 404,
      body: {
        error: { message: `unexpected ${request.method} ${request.path}` },
      },
    };
  });
}

function openAiConfig(
  server: MockServer,
  overrides: Partial<EmbeddingEndpointOptions> = {},
): EmbeddingEndpointOptions {
  return {
    kind: "openai",
    baseUrl: server.baseUrl,
    model: "text-embedding-3-small",
    dimensions: 3,
    apiKey: API_KEY,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function ollamaConfig(
  server: MockServer,
  overrides: Partial<EmbeddingEndpointOptions> = {},
): EmbeddingEndpointOptions {
  return {
    kind: "ollama",
    baseUrl: server.baseUrl,
    model: "nomic-embed-text",
    dimensions: 3,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to throw");
}

function asEndpointError(error: unknown): EmbeddingEndpointError {
  if (!isEmbeddingEndpointError(error)) {
    throw new Error(`Expected EmbeddingEndpointError, got ${String(error)}`);
  }
  return error;
}

// ---------------------------------------------------------------------------
// URL allow-list
// ---------------------------------------------------------------------------

describe("endpoint URL allow-list", () => {
  test("accepts https URLs and keeps an explicit path", () => {
    expect(normalizeEndpointBaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1",
    );
    expect(isAllowedEndpointUrl("https://embed.example.com")).toBe(true);
  });

  test("accepts loopback http hosts only", () => {
    expect(normalizeEndpointBaseUrl("http://localhost:11434")).toBe(
      "http://localhost:11434/",
    );
    expect(normalizeEndpointBaseUrl("http://127.0.0.1:1234/v1")).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(normalizeEndpointBaseUrl("http://[::1]:8080")).toBe(
      "http://[::1]:8080/",
    );
    expect(isAllowedEndpointUrl("http://192.168.1.5:11434")).toBe(false);
  });

  test("rejects remote plain-http, non-http schemes and lookalike hosts", () => {
    for (const raw of [
      "http://example.com/v1",
      "http://localhost.evil.com:11434",
      "ftp://127.0.0.1:1234",
      "file:///tmp/embed",
      "",
      "not a url",
    ]) {
      const error = asEndpointError(
        (() => {
          try {
            normalizeEndpointBaseUrl(raw);
          } catch (caught) {
            return caught;
          }
          throw new Error(`Expected ${raw} to be rejected`);
        })(),
      );
      expect(error.kind).toBe("allowlist");
    }
  });

  test("rejects embedded credentials without echoing them", () => {
    const error = asEndpointError(
      (() => {
        try {
          normalizeEndpointBaseUrl(
            "https://alice:supersecret@embed.example.com",
          );
        } catch (caught) {
          return caught;
        }
        throw new Error("Expected credentials to be rejected");
      })(),
    );
    expect(error.kind).toBe("allowlist");
    expect(error.message).not.toContain("supersecret");
  });

  test("rejects query strings and fragments", () => {
    for (const raw of [
      "https://embed.example.com/v1?api_key=leak",
      "https://embed.example.com/v1#fragment",
    ]) {
      const error = asEndpointError(
        (() => {
          try {
            normalizeEndpointBaseUrl(raw);
          } catch (caught) {
            return caught;
          }
          throw new Error("Expected the URL to be rejected");
        })(),
      );
      expect(error.kind).toBe("allowlist");
      expect(error.message).not.toContain("leak");
    }
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible protocol
// ---------------------------------------------------------------------------

describe("OpenAI-compatible endpoint", () => {
  test("probes TCP reachability without an HTTP request", async () => {
    const server = await startOpenAiServer();
    const probe = await probeEmbeddingEndpoint(openAiConfig(server));
    expect(probe.reachable).toBe(true);
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(probe.url).toBe(`${server.baseUrl}/`);
    expect(server.requests).toHaveLength(0);
  });

  test("lists models through GET /v1/models with bearer auth", async () => {
    const server = await startOpenAiServer();
    const listed = await listEmbeddingEndpointModels(openAiConfig(server));
    expect(listed.models.map((model) => model.id)).toEqual([
      "text-embedding-3-small",
    ]);
    expect(listed.models[0]?.ownedBy).toBe("openai");
    expect(listed.version).toBeUndefined();
    const request = requestAt(server, 0);
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/models");
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("does not double the /v1 prefix when the base URL already has it", async () => {
    const server = await startOpenAiServer();
    await listEmbeddingEndpointModels(
      openAiConfig(server, { baseUrl: `${server.baseUrl}/v1/` }),
    );
    expect(requestAt(server, 0).path).toBe("/v1/models");
  });

  test("sends a test embedding and validates dimension and norm", async () => {
    const server = await startOpenAiServer();
    const result = await testEmbeddingEndpoint(openAiConfig(server));
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.dimensions).toBe(3);
    expect(result.norm).toBeCloseTo(1, 6);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const request = requestAt(server, 0);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/embeddings");
    expect(request.headers["content-type"]).toBe("application/json");
    const body = parseJsonBody(request);
    expect(body.model).toBe("text-embedding-3-small");
    expect(requestedInputs(request)).toHaveLength(1);
  });

  test("verifies probe, list and test embedding in one flow", async () => {
    const server = await startOpenAiServer();
    const result = await verifyEmbeddingEndpoint(openAiConfig(server));
    expect(result.kind).toBe("openai");
    expect(result.egress).toBe(true);
    expect(result.baseUrl).toBe(`${server.baseUrl}/`);
    expect(result.models).toHaveLength(1);
    expect(result.dimensions).toBe(3);
    expect(result.probeLatencyMs).toBeGreaterThanOrEqual(0);
    expect(server.requests.map((request) => request.path)).toEqual([
      "/v1/models",
      "/v1/embeddings",
    ]);
  });

  test("embeds batches and preserves the server's index order", async () => {
    const server = await startMockServer((request) => {
      if (request.method === "POST" && request.path === "/v1/embeddings") {
        // Reply out of order: index 1 first, then index 0.
        return {
          body: {
            object: "list",
            data: [
              { object: "embedding", index: 1, embedding: [...UNIT_VECTOR_Y] },
              { object: "embedding", index: 0, embedding: [...UNIT_VECTOR] },
            ],
          },
        };
      }
      return { status: 404, body: { error: { message: "unexpected" } } };
    });
    const client = createEmbeddingEndpointClient(openAiConfig(server));
    const vectors = await client.embed(["alpha", "beta"]);
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0] ?? [])).toEqual([...UNIT_VECTOR]);
    expect(Array.from(vectors[1] ?? [])).toEqual([...UNIT_VECTOR_Y]);
    expect(server.requests).toHaveLength(1);
    expect(requestedInputs(requestAt(server, 0))).toEqual(["alpha", "beta"]);
  });

  test("returns no results for an empty batch without touching the network", async () => {
    const server = await startOpenAiServer();
    const client = createEmbeddingEndpointClient(openAiConfig(server));
    const vectors = await client.embed([]);
    expect(vectors).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ollama native protocol
// ---------------------------------------------------------------------------

describe("Ollama native endpoint", () => {
  test("lists tags and reads the daemon version", async () => {
    const server = await startOllamaServer();
    const listed = await listEmbeddingEndpointModels(ollamaConfig(server));
    expect(listed.models.map((model) => model.id)).toEqual([
      "nomic-embed-text:latest",
    ]);
    expect(listed.models[0]?.ownedBy).toBe("nomic-bert");
    expect(listed.version).toBe("0.5.1");
    expect(server.requests.map((request) => request.path)).toEqual([
      "/api/tags",
      "/api/version",
    ]);
  });

  test("posts a test embedding to /api/embed without an auth header", async () => {
    const server = await startOllamaServer();
    const result = await testEmbeddingEndpoint(ollamaConfig(server));
    expect(result.dimensions).toBe(3);
    expect(result.norm).toBeCloseTo(1, 6);
    const request = requestAt(server, 0);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/embed");
    expect(request.headers.authorization).toBeUndefined();
    const body = parseJsonBody(request);
    expect(body.model).toBe("nomic-embed-text");
    expect(requestedInputs(request)).toHaveLength(1);
  });

  test("verifies the full native flow", async () => {
    const server = await startOllamaServer();
    const result = await verifyEmbeddingEndpoint(ollamaConfig(server));
    expect(result.kind).toBe("ollama");
    expect(result.version).toBe("0.5.1");
    expect(result.models).toHaveLength(1);
    expect(result.egress).toBe(true);
    expect(server.requests.map((request) => request.path)).toEqual([
      "/api/tags",
      "/api/version",
      "/api/embed",
    ]);
  });

  test("embeds query text through the long-lived client", async () => {
    const server = await startOllamaServer();
    const client = createEmbeddingEndpointClient(ollamaConfig(server));
    const vectors = await client.embed(["hello"]);
    expect(vectors).toHaveLength(1);
    expect(Array.from(vectors[0] ?? [])).toEqual([...UNIT_VECTOR]);
    expect(client.circuitState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

describe("embedding validation", () => {
  test("rejects a vector whose dimension differs from the declaration", async () => {
    const server = await startOpenAiServer(UNIT_VECTOR);
    const error = asEndpointError(
      await captureError(() =>
        testEmbeddingEndpoint(openAiConfig(server, { dimensions: 5 })),
      ),
    );
    expect(error.kind).toBe("dimension");
    expect(error.message).toContain("3 dimensions");
    expect(error.message).toContain("5 were declared");
  });

  test("accepts an unknown declared dimension and reports the observed one", async () => {
    const server = await startOpenAiServer(UNIT_VECTOR);
    const result = await testEmbeddingEndpoint(
      openAiConfig(server, { dimensions: undefined }),
    );
    expect(result.dimensions).toBe(3);
  });

  test("rejects a vector outside the 1±0.01 norm band", async () => {
    const server = await startOpenAiServer([0.5, 0.5]);
    const error = asEndpointError(
      await captureError(() =>
        testEmbeddingEndpoint(openAiConfig(server, { dimensions: 2 })),
      ),
    );
    expect(error.kind).toBe("norm");
    expect(error.message).toContain("outside 1");
  });

  test("rejects a malformed JSON response", async () => {
    const server = await startMockServer(() => ({
      body: "this is not json",
    }));
    const error = asEndpointError(
      await captureError(() => testEmbeddingEndpoint(openAiConfig(server))),
    );
    expect(error.kind).toBe("response");
  });

  test("rejects a response without embedding data", async () => {
    const server = await startMockServer(() => ({ body: { data: [{}] } }));
    const error = asEndpointError(
      await captureError(() => testEmbeddingEndpoint(openAiConfig(server))),
    );
    expect(error.kind).toBe("response");
  });
});

// ---------------------------------------------------------------------------
// Failure classification and retry policy
// ---------------------------------------------------------------------------

describe("failure classification and retries", () => {
  test("maps 401 to auth and never retries it", async () => {
    const server = await startMockServer(() => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${API_KEY}` } },
    }));
    const error = asEndpointError(
      await captureError(() => testEmbeddingEndpoint(openAiConfig(server))),
    );
    expect(error.kind).toBe("auth");
    expect(error.statusCode).toBe(401);
    expect(error.attempts).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(error.message).toContain("HTTP 401");
    expect(error.message).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  test("maps 403 to auth", async () => {
    const server = await startMockServer(() => ({ status: 403, body: {} }));
    const error = asEndpointError(
      await captureError(() => testEmbeddingEndpoint(openAiConfig(server))),
    );
    expect(error.kind).toBe("auth");
    expect(server.requests).toHaveLength(1);
  });

  test("does not retry other 4xx responses", async () => {
    const server = await startMockServer(() => ({
      status: 404,
      body: { error: { message: "model not found" } },
    }));
    const error = asEndpointError(
      await captureError(() =>
        testEmbeddingEndpoint(openAiConfig(server, { model: "missing-model" })),
      ),
    );
    expect(error.kind).toBe("http-4xx");
    expect(error.message).toContain("model not found");
    expect(server.requests).toHaveLength(1);
  });

  test("retries 429 with exponential backoff and then succeeds", async () => {
    let calls = 0;
    const server = await startMockServer((request) => {
      calls += 1;
      if (calls === 1) {
        return { status: 429, body: { error: { message: "slow down" } } };
      }
      return {
        body: openAiEmbeddingsBody(requestedInputs(request), UNIT_VECTOR),
      };
    });
    const result = await testEmbeddingEndpoint(openAiConfig(server));
    expect(result.dimensions).toBe(3);
    expect(server.requests).toHaveLength(2);
  });

  test("retries 5xx at most twice", async () => {
    const server = await startMockServer(() => ({
      status: 503,
      body: { error: { message: "unavailable" } },
    }));
    const error = asEndpointError(
      await captureError(() => testEmbeddingEndpoint(openAiConfig(server))),
    );
    expect(error.kind).toBe("http-5xx");
    expect(error.attempts).toBe(3);
    expect(server.requests).toHaveLength(3);
  });

  test("honours maxRetries: 0", async () => {
    const server = await startMockServer(() => ({ status: 500, body: {} }));
    const error = asEndpointError(
      await captureError(() =>
        testEmbeddingEndpoint(openAiConfig(server, { maxRetries: 0 })),
      ),
    );
    expect(error.kind).toBe("http-5xx");
    expect(server.requests).toHaveLength(1);
  });

  test("times out a hanging request without retrying", async () => {
    const server = await startMockServer(() => ({ hang: true }));
    const error = asEndpointError(
      await captureError(() =>
        testEmbeddingEndpoint(openAiConfig(server, { timeoutMs: 100 })),
      ),
    );
    expect(error.kind).toBe("timeout");
    expect(server.requests).toHaveLength(1);
  });

  test("maps a refused connection to network", async () => {
    const server = await startMockServer(() => ({ body: {} }));
    const baseUrl = server.baseUrl;
    await server.close();
    const error = asEndpointError(
      await captureError(() =>
        probeEmbeddingEndpoint({
          kind: "openai",
          baseUrl,
          model: "text-embedding-3-small",
        }),
      ),
    );
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  test("opens after three failures, skips requests, then recovers on a probe", async () => {
    let mode: "ok" | "fail" = "fail";
    const server = await startMockServer((request) => {
      if (mode === "fail")
        return { status: 500, body: { error: { message: "boom" } } };
      return {
        body: openAiEmbeddingsBody(requestedInputs(request), UNIT_VECTOR),
      };
    });
    let now = 1_000;
    const client = createEmbeddingEndpointClient(
      openAiConfig(server, {
        maxRetries: 0,
        breakerThreshold: 3,
        breakerCooldownMs: 5_000,
        now: () => now,
      }),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = asEndpointError(
        await captureError(() => client.embed(["hello"])),
      );
      expect(error.kind).toBe("http-5xx");
    }
    expect(client.circuitState()).toBe("open");
    expect(server.requests).toHaveLength(3);

    const openError = asEndpointError(
      await captureError(() => client.embed(["hello"])),
    );
    expect(openError.kind).toBe("circuit-open");
    expect(server.requests).toHaveLength(3);

    now += 5_000;
    expect(client.circuitState()).toBe("half-open");

    mode = "ok";
    const vectors = await client.embed(["hello"]);
    expect(vectors).toHaveLength(1);
    expect(client.circuitState()).toBe("closed");
    expect(server.requests).toHaveLength(4);
  });

  test("a failed recovery probe reopens the circuit", async () => {
    const server = await startMockServer(() => ({ status: 500, body: {} }));
    let now = 0;
    const client = createEmbeddingEndpointClient(
      openAiConfig(server, {
        maxRetries: 0,
        breakerThreshold: 1,
        breakerCooldownMs: 1_000,
        now: () => now,
      }),
    );
    await captureError(() => client.embed(["hello"]));
    expect(client.circuitState()).toBe("open");

    now += 1_000;
    expect(client.circuitState()).toBe("half-open");
    const error = asEndpointError(
      await captureError(() => client.embed(["hello"])),
    );
    expect(error.kind).toBe("http-5xx");
    expect(client.circuitState()).toBe("open");

    const skipped = asEndpointError(
      await captureError(() => client.embed(["hello"])),
    );
    expect(skipped.kind).toBe("circuit-open");
  });

  test("does not count a caller-side abort toward the breaker", async () => {
    const requestImpl: EmbeddingEndpointRequestImpl = async () => {
      const error = new Error("The embedding request budget was exhausted.");
      (error as { code?: string }).code = "ABORT_ERR";
      throw error;
    };
    const client = createEmbeddingEndpointClient({
      kind: "openai",
      baseUrl: "http://127.0.0.1:9",
      model: "text-embedding-3-small",
      maxRetries: 0,
      breakerThreshold: 1,
      breakerCooldownMs: 5_000,
      requestImpl,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = asEndpointError(
        await captureError(() => client.embed(["hello"])),
      );
      expect(error.kind).toBe("aborted");
    }
    // Three budget aborts are not three endpoint failures (48-1 §6.9).
    expect(client.circuitState()).toBe("closed");
  });

  test("resetCircuit closes the breaker explicitly", async () => {
    let mode: "ok" | "fail" = "fail";
    const server = await startMockServer((request) => {
      if (mode === "fail") return { status: 500, body: {} };
      return {
        body: openAiEmbeddingsBody(requestedInputs(request), UNIT_VECTOR),
      };
    });
    const client = createEmbeddingEndpointClient(
      openAiConfig(server, { maxRetries: 0, breakerThreshold: 1 }),
    );
    await captureError(() => client.embed(["hello"]));
    expect(client.circuitState()).toBe("open");

    mode = "ok";
    client.resetCircuit();
    expect(client.circuitState()).toBe("closed");
    const vectors = await client.embed(["hello"]);
    expect(vectors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Redaction and config errors
// ---------------------------------------------------------------------------

describe("secret redaction", () => {
  test("redacts the API key from a transport error thrown by the request seam", async () => {
    const failingRequest: EmbeddingEndpointRequestImpl = async () => {
      throw new Error(`connect failed while using ${API_KEY}`);
    };
    const error = asEndpointError(
      await captureError(() =>
        testEmbeddingEndpoint({
          kind: "openai",
          baseUrl: "http://127.0.0.1:9",
          model: "text-embedding-3-small",
          apiKey: API_KEY,
          requestImpl: failingRequest,
        }),
      ),
    );
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("[REDACTED]");
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  test("never places the API key in the request URL", async () => {
    const server = await startOpenAiServer();
    await listEmbeddingEndpointModels(openAiConfig(server));
    for (const request of server.requests) {
      expect(request.path).not.toContain(API_KEY);
      expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    }
  });

  test("rejects invalid config with a config error", async () => {
    for (const options of [
      {
        kind: "openai" as const,
        baseUrl: "http://127.0.0.1:9",
        model: "  ",
      },
      {
        kind: "openai" as const,
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        dimensions: 0,
      },
    ]) {
      const error = asEndpointError(
        await captureError(() => testEmbeddingEndpoint(options)),
      );
      expect(error.kind).toBe("config");
    }
  });
});
