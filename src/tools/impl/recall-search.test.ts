/**
 * `RecallSearch` — contract, degradation, delay disclosure and one replay on a
 * real B2 index (48-3 §13.9.2, 48-4 D-24).
 *
 * Everything here runs against the real on-disk index format, the real B4
 * passage mapping and the real space resolver, with a deterministic fake encoder:
 * no model, no network and no harness data. Every directory is a fresh OS temp
 * root and `HARUYUKI_HOME` / `LETTA_LOCAL_BACKEND_DIR` are redirected for the
 * duration of the file (docs/31 §1.2 A2).
 *
 * What the tests pin down, in order:
 * - the contract: `query` required, `scope` defaults to `both`, `limit` defaults
 *   to 5 and is capped at 20;
 * - a real f32 B2 index replay: transcript + memory hits, scores and locators;
 * - scope partitioning and that an explicit lookup includes the current
 *   conversation (no in-context exclusion);
 * - no lexical fallback: embedding off, unbuilt index and an encoder that
 *   returns no vector are three actionable errors, never an empty success;
 * - delay disclosure: as-of is the *oldest* searched unit, lag is printed, and a
 *   stale index carries the "run a build" line;
 * - hidden conversations are excluded by the shared unit lister;
 * - a real int8 space is searchable too.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunkPlan,
} from "@/backend/local/embedding-chunk";
import type { EmbeddingQueryEncoder } from "@/backend/local/embedding-encoder";
import {
  type EmbeddingIndexPointer,
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
  writeEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import { buildMemoryVectorFilePlan } from "@/backend/local/embedding-memory";
import { writeEmbeddingQuantIndex } from "@/backend/local/embedding-quant-format";
import {
  type EmbeddingSpaceIdentity,
  resolveEmbeddingSpace,
} from "@/backend/local/embedding-space";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { readRecallMessageTexts } from "@/backend/local/recall-snippets";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";
import {
  RECALL_SEARCH_DEFAULT_LIMIT,
  RECALL_SEARCH_MAX_LIMIT,
  type RecallSearchDeps,
  recall_search,
  resetRecallSearchEncoderCacheForTests,
  validateRecallSearchArgs,
} from "./recall-search";

const DIMENSIONS = 8;
const AGENT_ID = "agent-recall-search";
const MODEL_ID = "fixture-embedding";
const QUERY = "the retry backoff policy is exponential with jitter";
const MEMORY_FILE = "reference/notes.md";

// --- isolated environment -------------------------------------------------

let homeDir: string;
let backendDir: string;
let previousHome: string | undefined;
let previousBackend: string | undefined;
const createdRoots: string[] = [];

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "haru-recall-search-home-"));
  backendDir = mkdtempSync(join(tmpdir(), "haru-recall-search-backend-"));
  previousHome = process.env.HARUYUKI_HOME;
  previousBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = backendDir;
});

afterAll(async () => {
  await resetRecallSearchEncoderCacheForTests();
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousBackend === undefined) delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = previousBackend;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(backendDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- fixture --------------------------------------------------------------

type Fixture = {
  root: string;
  /** Vector root passed as `deps.root`; never the real harness one. */
  vectorsRoot: string;
  storageDir: string;
  /** Exactly what the tool derives: `<storage>/memfs/<agent>/memory`. */
  memoryDir: string;
};

type FixtureMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Whole seconds added to 2026-01-01T00:00:00Z. */
  second?: number;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "haru-recall-search-"));
  createdRoots.push(root);
  const storageDir = join(root, "storage");
  const memoryDir = getLocalBackendMemoryFilesystemRoot(AGENT_ID, storageDir);
  mkdirSync(memoryDir, { recursive: true });
  return {
    root,
    vectorsRoot: join(root, "recall-vectors"),
    storageDir,
    memoryDir,
  };
}

function timestamp(second = 0): string {
  return `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
}

/**
 * One conversation in the modern local-backend layout.
 *
 * `hidden` is written into `conversation.json` because that is the record the
 * shared unit lister reads — the same rule passive recall applies.
 */
function writeConversation(
  fixture: Fixture,
  conversationKey: string,
  messages: readonly FixtureMessage[],
  options: { agentId?: string; hidden?: boolean } = {},
): void {
  const conversationDir = join(
    fixture.storageDir,
    "conversations",
    conversationKey,
  );
  mkdirSync(conversationDir, { recursive: true });
  writeFileSync(
    join(conversationDir, "conversation.json"),
    `${JSON.stringify({
      id: `conversation-${conversationKey}`,
      agent_id: options.agentId ?? AGENT_ID,
      ...(options.hidden === true ? { hidden: true } : {}),
    })}
`,
    "utf8",
  );
  writeFileSync(
    join(conversationDir, "messages.jsonl"),
    `${messages
      .map((message) =>
        JSON.stringify({
          id: message.id,
          role: message.role,
          content: message.text,
          metadata: { created_at: timestamp(message.second) },
        }),
      )
      .join("\n")}
`,
    "utf8",
  );
}

function writeMemory(fixture: Fixture, path: string, content: string): void {
  const target = join(fixture.memoryDir, ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function coverageOf(plans: readonly EmbeddingChunkPlan[]): {
  embeddedChars: number;
  recallableChars: number;
  ratio: number;
} {
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

/** Endpoint settings: no built-in manifest, no network (the encoder is a fake). */
function settingsFor(
  overrides: Partial<ResolvedEmbeddingSettings> = {},
): ResolvedEmbeddingSettings {
  return {
    enabled: true,
    backend: "endpoint",
    model: MODEL_ID,
    endpoint: {
      kind: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      model: MODEL_ID,
      dimensions: DIMENSIONS,
    },
    weight: 0.5,
    candidateDepth: 50,
    chunkTarget: 200,
    chunkMax: 256,
    chunkOverlap: 32,
    maxChunksPerMessage: 1024,
    threads: 0,
    gpu: "auto",
    quantization: "float32",
    calibration: null,
    keepSpaces: 2,
    ...overrides,
  };
}

function spaceFor(
  fixture: Fixture,
  settings: ResolvedEmbeddingSettings,
): EmbeddingSpaceIdentity {
  return resolveEmbeddingSpace(AGENT_ID, settings, {
    root: fixture.vectorsRoot,
  });
}

/** Writes a real B2 index for one conversation. */
function indexTranscript(
  fixture: Fixture,
  settings: ResolvedEmbeddingSettings,
  conversationKey: string,
  quant: "f32" | "int8" = "f32",
): { targetText: string; unitDir: string; pointer: EmbeddingIndexPointer } {
  const space = spaceFor(fixture, settings);
  const messages = readRecallMessageTexts(
    join(fixture.storageDir, "conversations", conversationKey),
  );
  if (messages.length === 0) {
    throw new Error("the fixture conversation has no recallable text");
  }
  const plans = messages.map((message) =>
    buildEmbeddingChunkPlan({ parentId: message.id, text: message.text }),
  );
  const chunks = plans.flatMap((plan) => plan.chunks);
  const unit = {
    agentId: AGENT_ID,
    spaceId: space.spaceId,
    conversationKey,
  };
  const unitDir = embeddingVectorUnitDir(unit, { root: fixture.vectorsRoot });
  const base = {
    unitDir,
    unit,
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan)),
    vectors: chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
    coverage: coverageOf(plans),
  };
  const written =
    quant === "int8"
      ? writeEmbeddingQuantIndex(base)
      : writeEmbeddingIndex(base);
  return {
    targetText: chunks[0]?.text ?? "",
    unitDir,
    pointer: written.pointer,
  };
}

/** Writes a real B2 index for one memory file. */
function indexMemory(
  fixture: Fixture,
  settings: ResolvedEmbeddingSettings,
  path: string,
  quant: "f32" | "int8" = "f32",
): { targetText: string; unitDir: string; pointer: EmbeddingIndexPointer } {
  const space = spaceFor(fixture, settings);
  const plan = buildMemoryVectorFilePlan(fixture.memoryDir, path, {
    gitRevision: "recall-search-test",
  });
  if (plan === undefined) {
    throw new Error(`the fixture memory file ${path} is unreadable`);
  }
  const unit = {
    agentId: AGENT_ID,
    spaceId: space.spaceId,
    memoryFileKey: plan.signature.fileKey,
  };
  const unitDir = embeddingVectorUnitDir(unit, { root: fixture.vectorsRoot });
  const chunks = plan.parents.flatMap((parent) => parent.plan.chunks);
  const base = {
    unitDir,
    unit,
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records: plan.parents.flatMap((parent) => parent.records),
    vectors: chunks.map((chunk) => fakeEmbeddingVector(chunk.text, DIMENSIONS)),
    coverage: coverageOf(plan.parents.map((parent) => parent.plan)),
  };
  const written =
    quant === "int8"
      ? writeEmbeddingQuantIndex(base)
      : writeEmbeddingIndex(base);
  return {
    targetText: chunks[0]?.text ?? "",
    unitDir,
    pointer: written.pointer,
  };
}

/** Deterministic encoder: the query's own fake vector, so a stored chunk of the
 * same text scores cosine 1. No worker, no model, no network. */
function fakeEncoder(): EmbeddingQueryEncoder {
  return {
    id: "fake:recall-search",
    async encodeQuery(text: string): Promise<Float32Array | null> {
      return fakeEmbeddingVector(text, DIMENSIONS);
    },
    async encodeBatch(
      texts: readonly string[],
    ): Promise<(Float32Array | null)[]> {
      return texts.map((text) => fakeEmbeddingVector(text, DIMENSIONS));
    },
    async dispose(): Promise<void> {
      // Nothing to stop.
    },
  };
}

function depsFor(
  fixture: Fixture,
  settings: ResolvedEmbeddingSettings,
  overrides: Partial<RecallSearchDeps> = {},
): RecallSearchDeps {
  return {
    agentId: AGENT_ID,
    storageDir: fixture.storageDir,
    root: fixture.vectorsRoot,
    settings,
    encoder: fakeEncoder(),
    ...overrides,
  };
}

// --- the argument contract -------------------------------------------------

describe("contract", () => {
  test("query is required and must not be empty", () => {
    const missing = validateRecallSearchArgs({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.content).toContain("`query`");

    const empty = validateRecallSearchArgs({ query: "   " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.content).toContain("empty");
  });

  test("scope defaults to both and rejects unknown values", () => {
    const defaults = validateRecallSearchArgs({ query: QUERY });
    expect(defaults).toEqual({
      ok: true,
      query: QUERY,
      scope: "both",
      limit: RECALL_SEARCH_DEFAULT_LIMIT,
    });
    expect(RECALL_SEARCH_DEFAULT_LIMIT).toBe(5);

    const memory = validateRecallSearchArgs({ query: QUERY, scope: "memory" });
    expect(memory.ok).toBe(true);
    if (memory.ok) expect(memory.scope).toBe("memory");

    const bad = validateRecallSearchArgs({ query: QUERY, scope: "summary" });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.content).toContain('"transcript", "memory", "both"');
  });

  test("limit defaults to 5 and is capped at 20", () => {
    expect(RECALL_SEARCH_MAX_LIMIT).toBe(20);
    const max = validateRecallSearchArgs({
      query: QUERY,
      limit: RECALL_SEARCH_MAX_LIMIT,
    });
    expect(max.ok).toBe(true);
    if (max.ok) expect(max.limit).toBe(20);

    for (const bad of [0, 21, 2.5, -3]) {
      const result = validateRecallSearchArgs({ query: QUERY, limit: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.content).toContain("between 1 and 20");
    }
  });

  test("an unknown limit type is refused, not coerced", () => {
    const result = validateRecallSearchArgs({ query: QUERY, limit: "3" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.content).toContain("whole number");
  });
});

// --- a real B2 index replay ------------------------------------------------

describe("real B2 index replay", () => {
  test("answers from transcript and memory with source, score, line and snippet", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "history", [
      { id: "m1", role: "user", text: QUERY, second: 1 },
    ]);
    writeMemory(
      fixture,
      MEMORY_FILE,
      `# Reference

${QUERY}
`,
    );
    indexTranscript(fixture, settings, "history");
    indexMemory(fixture, settings, MEMORY_FILE);

    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings),
    );

    expect(result.status).toBe("success");
    // Delay disclosure comes first, on every answer.
    expect(result.content.split("\n")[0]).toStartWith("Index as of ");
    expect(result.content).toContain("lag 0s");
    expect(result.content).toContain("· f32 · 2 unit(s)");
    expect(result.content).toContain('3 hit(s) for "' + QUERY + '"');
    expect(result.content).toContain("scope both");
    // Transcript locator: the conversation and the message's 1-based ordinal.
    expect(result.content).toMatch(
      /\[transcript\] conversation history · message #1 · 2026-01-01T00:00:01\.000Z · score 1\.000/,
    );
    // Memory locator: the workspace path and its file line span.
    expect(result.content).toMatch(
      /\[memory\] reference\/notes\.md L\d+(-L\d+)? · score 1\.000/,
    );
    // The snippet is the live parent text, not a stored copy.
    expect(result.content).toContain(QUERY);
  });

  test("default limit returns at most five hits", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    for (let index = 0; index < 7; index += 1) {
      const key = `conversation-${index}`;
      writeConversation(fixture, key, [
        { id: `m-${index}`, role: "user", text: QUERY },
      ]);
      indexTranscript(fixture, settings, key);
    }

    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings),
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("5 hit(s)");
    expect(result.content).not.toContain("6. [transcript]");
  });

  test("scope partitions the corpora", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "history", [
      { id: "m1", role: "user", text: QUERY },
    ]);
    writeMemory(
      fixture,
      MEMORY_FILE,
      `# Reference

${QUERY}
`,
    );
    indexTranscript(fixture, settings, "history");
    indexMemory(fixture, settings, MEMORY_FILE);

    const memoryOnly = await recall_search(
      { query: QUERY, scope: "memory" },
      depsFor(fixture, settings),
    );
    expect(memoryOnly.status).toBe("success");
    expect(memoryOnly.content).toContain("[memory]");
    expect(memoryOnly.content).not.toContain("[transcript]");

    const transcriptOnly = await recall_search(
      { query: QUERY, scope: "transcript" },
      depsFor(fixture, settings),
    );
    expect(transcriptOnly.status).toBe("success");
    expect(transcriptOnly.content).toContain("[transcript]");
    expect(transcriptOnly.content).not.toContain("[memory]");
  });

  test("an explicit lookup includes the current conversation", async () => {
    // The tool has no in-context exclusion: passive recall drops messages the
    // model can already see, but asking explicitly is a request to see them.
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "current", [
      { id: "m1", role: "assistant", text: QUERY },
    ]);
    indexTranscript(fixture, settings, "current");

    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings),
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain("[transcript] conversation current");
  });

  test("a scope with nothing indexed says so instead of returning no matches", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "history", [
      { id: "m1", role: "user", text: QUERY },
    ]);
    indexTranscript(fixture, settings, "history");

    const result = await recall_search(
      { query: QUERY, scope: "memory" },
      depsFor(fixture, settings),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain('Nothing is indexed for scope "memory"');
    expect(result.content).toContain("/recall embedding build");
  });
});

// --- degradation: errors, never a lexical fallback ------------------------

describe("degradation", () => {
  test("embedding off is an actionable error, not an empty success", async () => {
    const fixture = createFixture();
    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settingsFor({ enabled: false, endpoint: null })),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("Vector recall is off");
    expect(result.content).toContain("/recall embedding on");
    expect(result.content).toContain("never silently falls back to lexical");
  });

  test("an unbuilt index is an error that names the build command", async () => {
    const fixture = createFixture();
    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settingsFor()),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("Index: not built");
    expect(result.content).toContain("has not been built");
    expect(result.content).toContain("/recall embedding build");
    expect(result.content).toContain('never reported as "no matches"');
  });

  test("an encoder with no vector is an error, and the as-of line survives", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "history", [
      { id: "m1", role: "user", text: QUERY },
    ]);
    const written = indexTranscript(fixture, settings, "history");

    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings, {
        encoder: {
          id: "fake:no-vector",
          async encodeQuery() {
            return null;
          },
          async encodeBatch() {
            return [];
          },
          async dispose() {},
        },
      }),
    );

    expect(result.status).toBe("error");
    expect(result.content).toContain(
      `Index as of ${written.pointer.updatedAt}`,
    );
    expect(result.content).toContain("returned no query vector");
    expect(result.content).toContain("/recall embedding connect");
    expect(result.content).toContain("Nothing falls back to lexical search");
  });

  test("an unreadable index is an error that says to rebuild", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "history", [
      { id: "m1", role: "user", text: QUERY },
    ]);
    const written = indexTranscript(fixture, settings, "history");
    // Corrupt the committed pointer so the unit is listed but unusable: the
    // summary falls back to "not built" and the answer must not claim empty.
    writeFileSync(join(written.unitDir, "current.json"), "{not json\n", "utf8");

    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("/recall embedding build");
  });
});

// --- delay disclosure ------------------------------------------------------

describe("delay disclosure", () => {
  test("as-of is the oldest searched unit and stale lag is actionable", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "older", [
      { id: "m-older", role: "user", text: QUERY },
    ]);
    writeConversation(fixture, "newer", [
      { id: "m-newer", role: "user", text: QUERY },
    ]);
    const older = indexTranscript(fixture, settings, "older");
    indexTranscript(fixture, settings, "newer");

    // Backdate one committed unit; the answer's guarantee must follow the
    // oldest, not the newest.
    const oldestIso = new Date(
      Date.parse(older.pointer.updatedAt) - 900_000,
    ).toISOString();
    writeEmbeddingIndexPointer(older.unitDir, {
      ...older.pointer,
      updatedAt: oldestIso,
    });

    const fresh = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings, {
        now: () => Date.parse(oldestIso) + 30_000,
      }),
    );
    expect(fresh.status).toBe("success");
    expect(fresh.content.split("\n")[0]).toContain(`Index as of ${oldestIso}`);
    expect(fresh.content).toContain("lag 30s");
    expect(fresh.content).not.toContain("The index is behind");

    const stale = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings, {
        now: () => Date.parse(oldestIso) + 400_000,
      }),
    );
    expect(stale.status).toBe("success");
    expect(stale.content).toContain(`Index as of ${oldestIso}`);
    expect(stale.content).toContain("lag 6m 40s");
    expect(stale.content).toContain("The index is behind");
    expect(stale.content).toContain("/recall embedding build");
  });
});

// --- hidden conversations --------------------------------------------------

describe("hidden conversations", () => {
  test("a hidden conversation's index is excluded from results", async () => {
    const fixture = createFixture();
    const settings = settingsFor();
    writeConversation(fixture, "visible", [
      { id: "m-visible", role: "user", text: QUERY },
    ]);
    writeConversation(
      fixture,
      "hidden",
      [{ id: "m-hidden", role: "user", text: QUERY }],
      { hidden: true },
    );
    indexTranscript(fixture, settings, "visible");
    indexTranscript(fixture, settings, "hidden");

    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings),
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("[transcript] conversation visible");
    expect(result.content).not.toContain("hidden");
    expect(result.content).toContain("1 hit(s)");
    // The as-of/coverage line describes only the unit actually searched.
    expect(result.content).toContain("· f32 · 1 unit(s)");
  });
});

// --- int8 spaces -----------------------------------------------------------

describe("int8 space", () => {
  test("dispatches on space.quantization and searches the quant index", async () => {
    const fixture = createFixture();
    const settings = settingsFor({ quantization: "int8" });
    writeConversation(fixture, "history", [
      { id: "m1", role: "user", text: QUERY },
    ]);
    const written = indexTranscript(fixture, settings, "history", "int8");

    const result = await recall_search(
      { query: QUERY },
      depsFor(fixture, settings),
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("· int8 ·");
    expect(result.content).toContain("[transcript] conversation history");
    expect(result.content).toContain("score 1.000");
    // The pointer on disk says int8, proving the quant writer/reader path ran.
    const pointer = JSON.parse(
      readFileSync(join(written.unitDir, "current.json"), "utf8"),
    ) as { quant: string };
    expect(pointer.quant).toBe("int8");
  });

  test("an int8 memory space is searchable too", async () => {
    const fixture = createFixture();
    const settings = settingsFor({ quantization: "int8" });
    writeMemory(
      fixture,
      MEMORY_FILE,
      `# Reference

${QUERY}
`,
    );
    indexMemory(fixture, settings, MEMORY_FILE, "int8");

    const result = await recall_search(
      { query: QUERY, scope: "memory" },
      depsFor(fixture, settings),
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain("· int8 ·");
    expect(result.content).toContain("[memory] reference/notes.md");
  });
});
