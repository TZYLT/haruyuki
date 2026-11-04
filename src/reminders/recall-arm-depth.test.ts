/**
 * The two arms must be built at the same candidate depth (48-1 §6.7, P-02).
 *
 * Feature ②' s lexical pool is `candidateLimit` per source (12) and that is the
 * embedding-off contract: `runRecall` without a vector source must behave exactly
 * as 0.5.1 did. When the vector arm fuses, the requirement raises both arms to
 * `recallEmbeddingCandidateDepth` (50); a 12-deep lexical arm voting against a
 * 50-deep vector arm is precisely the unequal-depth state P-02 forbids, because
 * RRF ranks by position.
 *
 * This file drives the real `runRecall` against a synthetic store with more
 * matching messages than either depth, so the per-source pool size is observable
 * through `diagnostics.candidates` (the flat candidate list handed to selection).
 * Nothing touches the harness: temp store, temp `HARUYUKI_HOME` /
 * `LETTA_LOCAL_BACKEND_DIR` (docs/31 §1.2 A2), no model and no memory files.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { rebuildConversationIndex } from "@/backend/local/recall-index";
import type {
  RecallBackendPort,
  RecallSourcePort,
} from "@/reminders/recall-port";
import { RECALL_DEFAULTS } from "@/reminders/recall-port";
import { runRecall } from "@/reminders/recall-service";

const AGENT_ID = "agent-depth";
const HISTORY_KEY = "history";
const CURRENT_CONVERSATION_ID = "conversation-current";
const QUERY = "财务系统每日对账";
/** More matching messages than either candidate depth, so 12 vs 50 is visible. */
const MESSAGE_COUNT = 20;

const MESSAGES: readonly RecallMessageText[] = Array.from(
  { length: MESSAGE_COUNT },
  (_unused, index) => ({
    id: `m${index + 1}`,
    role: "user" as const,
    ts: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    text: `财务系统每日对账，第 ${index + 1} 条台账记录写入当日汇总。`,
  }),
);

let homeDir: string;
let backendDir: string;
let previousHome: string | undefined;
let previousBackend: string | undefined;
const createdRoots: string[] = [];

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "haru-arm-depth-home-"));
  backendDir = mkdtempSync(join(tmpdir(), "haru-arm-depth-backend-"));
  previousHome = process.env.HARUYUKI_HOME;
  previousBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = backendDir;
});

afterAll(() => {
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

/** A local store with one indexed conversation of {@link MESSAGES}. */
function createStore(): string {
  const root = mkdtempSync(join(tmpdir(), "haru-arm-depth-"));
  createdRoots.push(root);
  const storageDir = join(root, "storage");
  const conversationDir = join(storageDir, "conversations", HISTORY_KEY);
  mkdirSync(conversationDir, { recursive: true });
  writeFileSync(
    join(conversationDir, "conversation.json"),
    JSON.stringify({
      id: `conversation-${HISTORY_KEY}`,
      agent_id: AGENT_ID,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(conversationDir, "messages.jsonl"),
    `${MESSAGES.map((message) =>
      JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.text,
        metadata: { created_at: message.ts },
      }),
    ).join("\n")}\n`,
  );
  const rebuilt = rebuildConversationIndex({
    conversationDir,
    identity: {
      conversationKey: HISTORY_KEY,
      conversationId: `conversation-${HISTORY_KEY}`,
      agentId: AGENT_ID,
    },
  });
  if ("error" in rebuilt) {
    throw new Error(
      `could not build the depth fixture index: ${rebuilt.error}`,
    );
  }
  return storageDir;
}

function backendFor(storageDir: string): RecallBackendPort {
  return {
    getLocalStorageDir: () => storageDir,
    getInContextMessageIds: async () => [],
    settleRecallDedup: () => ({ suppressed: new Set<string>(), window: {} }),
  };
}

/** A vector arm that contributes nothing: the arm is attached but silent. */
function silentVectorArm(): RecallSourcePort {
  return {
    id: "vector",
    arm: "vector",
    async search() {
      return {
        candidates: [],
        diagnostic: {
          source: "vector",
          status: "empty",
          candidates: 0,
          reason: "the vector space has no units",
        },
      };
    },
  };
}

async function recall(
  storageDir: string,
  overrides: {
    vectorSource?: RecallSourcePort;
    fusion?: { vectorWeight?: number; candidateDepth?: number };
  } = {},
) {
  return runRecall({
    backend: backendFor(storageDir),
    agentId: AGENT_ID,
    conversationId: CURRENT_CONVERSATION_ID,
    userText: QUERY,
    currentTurn: 1,
    dryRun: true,
    options: {
      limit: 3,
      candidateLimit: RECALL_DEFAULTS.candidateLimit,
    },
    ...(overrides.vectorSource === undefined
      ? {}
      : { vectorSource: overrides.vectorSource }),
    ...(overrides.fusion === undefined ? {} : { fusion: overrides.fusion }),
  });
}

describe("the two arms are built at the same candidate depth", () => {
  test("the embedding-off path keeps feature ②'s 12 per source, bit for bit", async () => {
    const storageDir = createStore();
    const decision = await recall(storageDir);

    expect(decision.status).toBe("injected");
    // 12 is ②'s per-source pool; the fixture has 20 matching messages so the cut
    // is observable. Off path = no vector source = this is the baseline.
    expect(decision.diagnostics.candidates).toBe(
      RECALL_DEFAULTS.candidateLimit,
    );
    expect(decision.timedOut).toBeUndefined();
  });

  test("a fusing turn raises the lexical arm to the vector depth", async () => {
    const storageDir = createStore();
    const baseline = await recall(storageDir);
    const fused = await recall(storageDir, { vectorSource: silentVectorArm() });

    // The fusion depth is 50 by default and the fixture only has 20 matching
    // messages, so the lexical pool is no longer cut at 12.
    expect(fused.diagnostics.candidates).toBe(MESSAGE_COUNT);
    expect(fused.diagnostics.candidates).toBeGreaterThan(
      baseline.diagnostics.candidates,
    );
    // The extra depth must not change what is injected: the top three by score
    // are the same prefix either way.
    expect(fused.entries.map((entry) => entry.fingerprint)).toEqual(
      baseline.entries.map((entry) => entry.fingerprint),
    );
    expect(fused.status).toBe(baseline.status);
  });

  test("weight 0 is lexical-only and stays at ②'s depth", async () => {
    const storageDir = createStore();
    const baseline = await recall(storageDir);
    const weightZero = await recall(storageDir, {
      vectorSource: silentVectorArm(),
      fusion: { vectorWeight: 0 },
    });

    // `vectorWeight: 0` says "lexical only", and the merge drops the vector arm,
    // so there is no second arm to equalise with: the turn keeps ②'s pool.
    expect(weightZero.diagnostics.candidates).toBe(
      RECALL_DEFAULTS.candidateLimit,
    );
    expect(weightZero.entries.map((entry) => entry.fingerprint)).toEqual(
      baseline.entries.map((entry) => entry.fingerprint),
    );
  });

  test("an explicit depth moves both arms together", async () => {
    const storageDir = createStore();
    const decision = await recall(storageDir, {
      vectorSource: silentVectorArm(),
      fusion: { candidateDepth: 7 },
    });

    // A depth below ②'s pool cannot un-build sources below it: the arm is built
    // at `max(12, depth)` and fusion cuts both arms to 7, which is the equal-depth
    // state the requirement asks for.
    expect(decision.diagnostics.candidates).toBe(
      RECALL_DEFAULTS.candidateLimit,
    );
  });
});
