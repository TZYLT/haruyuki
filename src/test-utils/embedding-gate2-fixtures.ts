/**
 * Fixtures for the feature-48 **gate 2** L1 end-to-end evidence tests.
 *
 * Gate 2 proves the two delivery paths (external endpoint and built-in model)
 * and the three surfaces (headless / TUI / websocket) against the real modules:
 * C6's HTTP client, B2's on-disk index, E2's vector arm, E3's fusion, C3's
 * worker client, C4's install marker, A3's runner, A4's host and A5's status
 * projection. Everything here exists to keep that real:
 *
 * - **Isolation** (docs/31 §1.2 A2): one temp root per test file; `HOME`,
 *   `HARUYUKI_HOME` and `LETTA_LOCAL_BACKEND_DIR` are redirected into it and
 *   restored on the way out. No test ever reads the real harness data.
 * - **No network but loopback**: the endpoint mock is a real `127.0.0.1` HTTP
 *   server (C6's default `node:http` transport is exercised, not stubbed).
 * - **No model runtime**: the built-in path uses a small plain-JS worker script
 *   run by `process.execPath` (C3's real spawn + JSON-Lines protocol) and C4's
 *   real install marker written with a synthetic manifest sized to a few bytes.
 * - **Deterministic embeddings**: the same FNV-1a + LCG + L2 vector as
 *   `embedding-fixture.ts`, which is what lets an index built through the
 *   endpoint or the worker be queried with cosine 1.
 *
 * Layer: `test-utils/` — imported only by tests.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstallManifest } from "@/backend/local/embedding/model-download-install";
import { MODEL_INSTALL_MANIFEST_FILE_NAME } from "@/backend/local/embedding/model-download-types";
import {
  type EmbeddingModelManifest,
  getBuiltinModelManifest,
} from "@/backend/local/embedding/model-manifest";
import { EmbeddingWorkerClient } from "@/backend/local/embedding/worker-client";
import type { EmbeddingWorkerClientOptions } from "@/backend/local/embedding/worker-client-types";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunkOptions,
  type EmbeddingChunkPlan,
} from "@/backend/local/embedding-chunk";
import {
  type EmbeddingIndexCoverage,
  embeddingChunkRecordsFromPlan,
} from "@/backend/local/embedding-format";
import {
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
  LOCAL_TRANSCRIPT_SCHEMA_VERSION,
} from "@/backend/local/local-transcript";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import {
  type RecallMessageText,
  rebuildConversationIndex,
} from "@/backend/local/recall-index";
import type { RecallBackendPort } from "@/reminders/recall-port";
import type { RecallVectorParentPort } from "@/reminders/recall-vector-source";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";

/** Width every gate-2 fixture uses; small so vectors are cheap to diff. */
export const GATE2_DIMENSIONS = 8;

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

export type Gate2Environment = {
  /** Temp root holding home + local-backend directories. */
  root: string;
  homeDir: string;
  localBackendDir: string;
  /** Restores the three environment variables captured at creation. */
  restore: () => void;
  /** Removes this fixture's temp root (its own mkdtemp path only). */
  cleanup: () => void;
};

/**
 * Create an isolated harness root and redirect the three path variables into
 * it. Callers restore in `afterAll`; `cleanup()` only ever deletes the
 * `mkdtemp` directory this call returned.
 */
export function createGate2Environment(
  prefix = "haru-gate2-",
): Gate2Environment {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(root, "home");
  const localBackendDir = join(root, "local-backend");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(localBackendDir, { recursive: true });

  const previous = {
    HOME: process.env.HOME,
    HARUYUKI_HOME: process.env.HARUYUKI_HOME,
    LETTA_LOCAL_BACKEND_DIR: process.env.LETTA_LOCAL_BACKEND_DIR,
  };
  process.env.HOME = homeDir;
  process.env.HARUYUKI_HOME = homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = localBackendDir;

  return {
    root,
    homeDir,
    localBackendDir,
    restore: () => {
      restoreEnv("HOME", previous.HOME);
      restoreEnv("HARUYUKI_HOME", previous.HARUYUKI_HOME);
      restoreEnv("LETTA_LOCAL_BACKEND_DIR", previous.LETTA_LOCAL_BACKEND_DIR);
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// ---------------------------------------------------------------------------
// Temp transcript + memory fixtures (the real local store readers)
// ---------------------------------------------------------------------------

export type Gate2FixtureMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Whole seconds added to 2026-01-01T00:00:00Z. */
  second?: number;
};

/** One `pi-session-entry-jsonl` row, the format the live store writes. */
function gate2MessageRow(message: Gate2FixtureMessage): unknown {
  const second = message.second ?? 0;
  const timestamp = `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
  return {
    type: "message",
    id: `row-${message.id}`,
    parentId: null,
    timestamp,
    message: {
      id: message.id,
      role: message.role,
      content: [{ type: "text", text: message.text }],
    },
  };
}

/** The message list `readRecallMessageTexts` will report for {@link rows}. */
export function gate2MessageTexts(
  messages: readonly Gate2FixtureMessage[],
): RecallMessageText[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    ts: `2026-01-01T00:00:${String(message.second ?? 0).padStart(2, "0")}.000Z`,
    text: message.text,
  }));
}

/**
 * Writes one conversation in the modern local-backend layout and builds its
 * recall sidecar, so both the lexical and the vector arm read a real corpus.
 * Returns the conversation's directory key.
 */
export async function writeGate2Conversation(input: {
  storageDir: string;
  directory: string;
  conversationId: string;
  agentId: string;
  messages: readonly Gate2FixtureMessage[];
}): Promise<string> {
  const conversationDir = join(
    input.storageDir,
    "conversations",
    input.directory,
  );
  mkdirSync(conversationDir, { recursive: true });
  writeFileSync(
    join(conversationDir, "conversation.json"),
    `${JSON.stringify({ id: input.conversationId, agent_id: input.agentId })}\n`,
    "utf8",
  );
  writeFileSync(
    join(conversationDir, "manifest.json"),
    `${JSON.stringify({
      schema_version: LOCAL_TRANSCRIPT_SCHEMA_VERSION,
      message_format: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
      created_at: "2026-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(conversationDir, "messages.jsonl"),
    `${input.messages.map((message) => JSON.stringify(gate2MessageRow(message))).join("\n")}\n`,
    "utf8",
  );
  const rebuilt = rebuildConversationIndex({
    conversationDir,
    identity: {
      conversationKey: input.directory,
      conversationId: input.conversationId,
      agentId: input.agentId,
    },
  });
  if (!("sidecar" in rebuilt)) {
    throw new Error(`gate-2 conversation index failed: ${rebuilt.error}`);
  }
  return input.directory;
}

/** Writes a file into the fixture agent's memory workspace. */
export function writeGate2MemoryFile(input: {
  storageDir: string;
  agentId: string;
  path: string;
  content: string;
}): string {
  const memoryDir = getLocalBackendMemoryFilesystemRoot(
    input.agentId,
    input.storageDir,
  );
  const target = join(memoryDir, ...input.path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, input.content, "utf8");
  return target;
}

/** The memory workspace root for the fixture agent. */
export function gate2MemoryDir(storageDir: string, agentId: string): string {
  return getLocalBackendMemoryFilesystemRoot(agentId, storageDir);
}

// ---------------------------------------------------------------------------
// Mock embedding endpoint (real 127.0.0.1 HTTP; C6's own transport is used)
// ---------------------------------------------------------------------------

export type Gate2EndpointKind = "openai" | "ollama";

export type Gate2EmbedFunction = (
  text: string,
) => readonly number[] | Float32Array;

export type Gate2RecordedRequest = {
  method: string;
  path: string;
  body: string;
};

export type Gate2MockEndpoint = {
  kind: Gate2EndpointKind;
  baseUrl: string;
  requests: Gate2RecordedRequest[];
  close: () => Promise<void>;
};

type Gate2MockResponse = {
  status?: number;
  body?: unknown;
};

/**
 * Start a loopback-only mock that speaks both supported protocols.
 *
 * `embed` is injectable so a test can return a wrong-width or unnormalised
 * vector and prove C6 rejects it. The default returns the deterministic
 * fixture vector at {@link GATE2_DIMENSIONS}.
 */
export async function startGate2MockEndpoint(options: {
  kind: Gate2EndpointKind;
  model: string;
  dimensions?: number;
  embed?: Gate2EmbedFunction;
}): Promise<Gate2MockEndpoint> {
  const dimensions = options.dimensions ?? GATE2_DIMENSIONS;
  const embed =
    options.embed ?? ((text: string) => fakeEmbeddingVector(text, dimensions));
  const requests: Gate2RecordedRequest[] = [];
  const sockets = new Set<net.Socket>();

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded: Gate2RecordedRequest = {
        method: request.method ?? "",
        path: request.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const reply = replyFor(recorded, options.kind, options.model, embed);
      const payload =
        reply.body === undefined ? "" : JSON.stringify(reply.body);
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    });
    request.on("error", () => response.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the gate-2 mock endpoint did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    kind: options.kind,
    baseUrl,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function replyFor(
  request: Gate2RecordedRequest,
  kind: Gate2EndpointKind,
  model: string,
  embed: Gate2EmbedFunction,
): Gate2MockResponse {
  if (kind === "openai") {
    if (request.method === "GET" && request.path === "/v1/models") {
      return { body: { data: [{ id: model, owned_by: "gate2-mock" }] } };
    }
    if (request.method === "POST" && request.path === "/v1/embeddings") {
      const texts = readInputTexts(request.body);
      return {
        body: {
          data: texts.map((text, index) => ({
            index,
            embedding: [...embed(text)],
            object: "embedding",
          })),
        },
      };
    }
    return { status: 404, body: { error: "unknown path" } };
  }
  if (request.method === "GET" && request.path === "/api/tags") {
    return {
      body: { models: [{ name: model, details: { family: "gate2-mock" } }] },
    };
  }
  if (request.method === "GET" && request.path === "/api/version") {
    return { body: { version: "0.0.0-gate2-mock" } };
  }
  if (request.method === "POST" && request.path === "/api/embed") {
    return {
      body: {
        embeddings: readInputTexts(request.body).map((text) => [
          ...embed(text),
        ]),
      },
    };
  }
  return { status: 404, body: { error: "unknown path" } };
}

function readInputTexts(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { input?: unknown };
    const input = parsed.input;
    if (Array.isArray(input)) {
      return input.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
    if (typeof input === "string") return [input];
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// C4 install marker (offline; a synthetic manifest sized to a few bytes)
// ---------------------------------------------------------------------------

export type Gate2ModelInstall = {
  manifest: EmbeddingModelManifest;
  modelsDir: string;
  modelDir: string;
};

/**
 * Write a complete, verifiable C4 install without a download: a synthetic
 * manifest (spread from the built-in one, so licence/sources stay valid) with a
 * tiny ONNX file and tokenizer, plus the real `model-install.json` marker that
 * `isEmbeddingModelInstalled` validates.
 */
export function writeGate2ModelInstall(input: {
  modelsDir: string;
  modelId?: string;
  dimensions?: number;
  weightsBytes?: number;
}): Gate2ModelInstall {
  const base = getBuiltinModelManifest();
  const modelId = input.modelId ?? `${base.id}-gate2`;
  const dimensions = input.dimensions ?? GATE2_DIMENSIONS;
  const weights = Buffer.alloc(input.weightsBytes ?? 64, 0x5a);
  const tokenizer = Buffer.from(
    JSON.stringify({ model: { type: "BPE" }, added_tokens: [] }),
    "utf8",
  );
  const sha256 = (bytes: Buffer): string =>
    createHash("sha256").update(bytes).digest("hex");
  const files = [
    {
      path: "onnx/model.onnx",
      bytes: weights.byteLength,
      sha256: sha256(weights),
    },
    {
      path: "tokenizer.json",
      bytes: tokenizer.byteLength,
      sha256: sha256(tokenizer),
    },
  ];
  const manifest: EmbeddingModelManifest = {
    ...base,
    id: modelId,
    dimensions,
    files,
    integrityPinned: true,
  };
  const modelDir = join(input.modelsDir, modelId);
  mkdirSync(join(modelDir, "onnx"), { recursive: true });
  writeFileSync(join(modelDir, "onnx", "model.onnx"), weights);
  writeFileSync(join(modelDir, "tokenizer.json"), tokenizer);

  const staged = files.map((file) => ({
    file: { ...file },
    digest: file.sha256,
    bytes: file.bytes,
    source: "manual",
  }));
  const install = buildInstallManifest(
    manifest,
    staged,
    { integrity: "sha256", missingSha256: [], missingBytes: [] },
    "manual",
    () => Date.parse("2026-01-01T00:00:00.000Z"),
  );
  writeFileSync(
    join(modelDir, MODEL_INSTALL_MANIFEST_FILE_NAME),
    `${JSON.stringify(install, null, 2)}\n`,
    "utf8",
  );
  return { manifest, modelsDir: input.modelsDir, modelDir };
}

// ---------------------------------------------------------------------------
// C3 fake worker (a real child process running the real JSON-Lines protocol)
// ---------------------------------------------------------------------------

/**
 * Write the plain-JS worker C3 spawns. It keeps a tiny stdin/stdout JSON-Lines
 * loop and answers `ready`/`init`/`embed`/`cancel`/`stats`/`shutdown` with the
 * same deterministic vector as {@link fakeEmbeddingVector} — so the built-in
 * path exercises the real worker client (spawn, handshake, framing, base64
 * vectors) without any ONNX runtime.
 */
export function writeGate2FakeWorkerScript(
  dir: string,
  dimensions: number = GATE2_DIMENSIONS,
): string {
  const scriptPath = join(dir, "gate2-fake-embedding-worker.js");
  const source = `"use strict";
// Gate-2 fake embedding worker: real JSON-Lines protocol, deterministic vectors.
const DIMENSIONS = ${dimensions};
let stdout = process.stdout;
let embeds = 0;
function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
function vectorFor(text) {
  const vector = new Float32Array(DIMENSIONS);
  let state = hashText(text) || 0x9e3779b9;
  let sumOfSquares = 0;
  for (let index = 0; index < DIMENSIONS; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = (state / 0xffffffff) * 2 - 1;
    vector[index] = value;
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares);
  const bytes = Buffer.allocUnsafe(DIMENSIONS * 4);
  for (let index = 0; index < DIMENSIONS; index += 1) {
    bytes.writeFloatLE(norm > 0 ? vector[index] / norm : vector[index], index * 4);
  }
  return bytes.toString("base64");
}
function send(frame) {
  stdout.write(JSON.stringify(frame) + "\\n");
}
function reply(id, result) {
  send({ type: "result", id, result });
}
function handle(frame) {
  const id = frame.id;
  if (frame.type === "init") {
    reply(id, { dim: DIMENSIONS, runtime: "bun", maxTokens: 512, warmupMs: 1 });
    return;
  }
  if (frame.type === "embed") {
    const texts = Array.isArray(frame.texts) ? frame.texts : [];
    embeds += texts.length;
    reply(id, {
      vectors: texts.map(vectorFor),
      dim: DIMENSIONS,
      cancelled: false,
      texts: texts.length,
      tokens: texts.reduce((total, text) => total + String(text).length, 0),
      batches: texts.length > 0 ? 1 : 0,
      elapsedMs: 1,
    });
    return;
  }
  if (frame.type === "cancel") {
    reply(id, { cancelled: 0, targets: [] });
    return;
  }
  if (frame.type === "stats") {
    reply(id, {
      initialized: true,
      modelPath: null,
      tokenizerPath: null,
      runtime: "bun",
      dim: DIMENSIONS,
      maxTokens: 512,
      maxBatchSize: 32,
      maxBatchTokens: 1700,
      inits: 1,
      embeds,
      texts: embeds,
      tokens: embeds,
      batches: embeds,
      errors: 0,
      cancelled: 0,
      totalEmbedMs: 0,
      lastEmbedMs: 0,
      textsPerSecond: 0,
      tokensPerSecond: 0,
      uptimeMs: Date.now(),
      queueDepth: 0,
      pendingRequestId: null,
    });
    return;
  }
  if (frame.type === "shutdown") {
    reply(id, { uptimeMs: Date.now(), embeds });
    process.exit(0);
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (line.length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // A malformed request is a test bug; the client would time out visibly.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
send({
  type: "ready",
  protocol: 1,
  pid: process.pid,
  runtime: "bun",
  startedAt: Date.now(),
});
`;
  writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

/** A worker client with gate-2-sized timeouts (no watchdog retries in tests). */
export function createGate2WorkerClient(
  workerPath: string,
): EmbeddingWorkerClient {
  const options: EmbeddingWorkerClientOptions = {
    workerPath,
    execPath: process.execPath,
    handshakeTimeoutMs: 10_000,
    initTimeoutMs: 10_000,
    firstStartHandshakeTimeoutMs: 10_000,
    firstStartInitTimeoutMs: 10_000,
    embedTimeoutMs: 10_000,
    controlTimeoutMs: 10_000,
    killGraceMs: 1_000,
    restart: false,
  };
  return new EmbeddingWorkerClient(options);
}

// ---------------------------------------------------------------------------
// Chunk plans / index writing / recall ports
// ---------------------------------------------------------------------------

/** One transcript unit's plans, the way A4's units provider builds them. */
export function gate2TranscriptPlans(
  messages: readonly RecallMessageText[],
  options?: EmbeddingChunkOptions,
): { plans: EmbeddingChunkPlan[]; chunks: number } {
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan(
      { parentId: message.id, text: message.text },
      options,
    ),
  );
  let chunks = 0;
  for (const plan of plans) chunks += plan.chunks.length;
  return { plans, chunks };
}

/** Aggregate coverage over plans, the shape B2's writer expects. */
export function gate2Coverage(
  plans: readonly EmbeddingChunkPlan[],
): EmbeddingIndexCoverage {
  let embeddedChars = 0;
  let recallableChars = 0;
  for (const plan of plans) {
    embeddedChars += plan.coverage.embeddedChars;
    recallableChars += plan.coverage.recallableChars;
  }
  return {
    embeddedChars,
    recallableChars,
    ratio: recallableChars === 0 ? 0 : embeddedChars / recallableChars,
  };
}

/** Record inputs for one transcript unit's plans. */
export function gate2TranscriptRecords(plans: readonly EmbeddingChunkPlan[]) {
  return plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan));
}

/** In-memory E2 parent port over a message list (drift is a text edit). */
export function createGate2ParentPort(input: {
  messages: () => readonly RecallMessageText[];
}): RecallVectorParentPort {
  return {
    transcriptMessages: () => input.messages(),
    memoryParent: () => undefined,
  };
}

/** The narrow backend the service needs; no store, no dedup window. */
export function createGate2RecallBackend(
  storageDir: string,
): RecallBackendPort {
  return {
    getLocalStorageDir: () => storageDir,
    async getInContextMessageIds() {
      return [];
    },
    settleRecallDedup() {
      return { suppressed: new Set<string>(), window: {} };
    },
  };
}

/** Poll a predicate with a hard deadline; fails with its label on timeout. */
export async function gate2WaitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`gate-2 fixture timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
