import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRecallDeadline,
  freezeRecallDeadline,
} from "@/reminders/recall-deadline";
import type {
  RecallCandidate,
  RecallQueryTerms,
  RecallSourceOutcome,
  RecallSourcePort,
  RecallSourceRequest,
  RecallSourceStatus,
} from "@/reminders/recall-port";
import { recallQueryTerms } from "@/reminders/recall-query";
import {
  readRecallRuntimeStatus,
  recordRecallDecision,
  resetRecallRuntime,
} from "@/reminders/recall-runtime";
import { searchRecallPhases } from "@/reminders/recall-service";
import { buildRecallSources } from "@/reminders/recall-sources";

/**
 * A1's contract: the port is asynchronous and carries the raw query; the turn's
 * `timedOut` is the lexical arm's verdict, frozen before the vector arm runs.
 *
 * The phase boundary is the part worth pinning. The vector arm is allowed to
 * overrun its budget and degrade (`degraded`), and that must not read as a
 * timeout — `recall-runtime.ts` counts a `timedOut` turn as a failure and trips
 * the breaker after three, so folding a slow encoder into the flag would switch
 * a working feature off. `searchRecallPhases` is the seam that makes this
 * observable without a store: both arms are ordinary ports.
 *
 * No store and no harness paths: the sources are fakes and the deadline's clock
 * is a local variable. The environment is still pointed at fresh temp
 * directories and restored afterwards, so importing the backend modules cannot
 * resolve a real harness root.
 */

const QUERY: RecallQueryTerms = {
  rawText: "the ledger is reconciled daily",
  terms: ["ledger", "reconciled"],
  phrases: [],
};

const SCOPE = { agentId: "agent-a", currentConversationId: "conversation-a" };

let homeDir: string;
let backendDir: string;
let previousHome: string | undefined;
let previousBackend: string | undefined;

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "haru-recall-async-home-"));
  backendDir = await mkdtemp(join(tmpdir(), "haru-recall-async-backend-"));
  previousHome = process.env.HARUYUKI_HOME;
  previousBackend = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = backendDir;
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousBackend === undefined) delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = previousBackend;
  resetRecallRuntime();
  await rm(homeDir, { recursive: true, force: true });
  await rm(backendDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRecallRuntime();
});

function candidate(): RecallCandidate {
  return {
    source: "transcript",
    fingerprint: "transcript:history:1",
    file: "history",
    conversationKey: "history",
    messageId: "m1",
    text: "the ledger is reconciled daily",
    score: 1,
  };
}

function outcome(status: RecallSourceStatus): RecallSourceOutcome {
  const candidates = status === "searched" ? [candidate()] : [];
  return {
    candidates,
    diagnostic: {
      source: "transcript",
      status,
      candidates: candidates.length,
      ...(status === "searched"
        ? {}
        : { reason: "the transcript source could not run" }),
    },
  };
}

/** A lexical source whose body runs `onSearch` and then reports one hit. */
function lexicalSource(onSearch: () => void = () => {}): RecallSourcePort {
  return {
    id: "transcript",
    arm: "lexical",
    async search() {
      onSearch();
      return outcome("searched");
    },
  };
}

/** A vector source that reports the arm's own budget degradation. */
function vectorSource(onSearch: () => void = () => {}): RecallSourcePort {
  return {
    id: "memory",
    arm: "vector",
    async search() {
      onSearch();
      return {
        candidates: [],
        diagnostic: {
          source: "memory",
          status: "degraded",
          candidates: 0,
          reason: "the vector arm ran out of its query budget",
        },
      };
    },
  };
}

describe("the recall port is asynchronous", () => {
  test("both real lexical sources declare their arm and answer with a promise", async () => {
    const sources = buildRecallSources({
      storageDir: join(homeDir, "no-such-store"),
      memoryDir: join(homeDir, "no-such-memory"),
      excludedMessageIds: new Set(),
      candidateLimit: 5,
      neighbors: 1,
      excerptLines: 1,
    });

    expect(sources.map((source) => source.arm)).toEqual(["lexical", "lexical"]);

    const request: RecallSourceRequest = { terms: QUERY, scope: SCOPE };
    const pending = sources[0]?.search(request);
    expect(pending).toBeInstanceOf(Promise);
    // The body is unchanged: a missing store is still a contained failure, not a
    // rejected promise the caller has to catch.
    const result = await pending;
    expect(result?.diagnostic.source).toBe("transcript");
    expect(result?.diagnostic.status).not.toBe("searched");
    expect(result?.candidates).toEqual([]);
  });
});

describe("the query carries the raw sentence", () => {
  test("recallQueryTerms keeps the verbatim input next to the parsed terms", () => {
    const query = recallQueryTerms("财务系统是怎么记账的");
    expect(query.rawText).toBe("财务系统是怎么记账的");
    expect(query.terms.length).toBeGreaterThan(0);
  });

  test("the service hands the same query object to every source", async () => {
    const seen: RecallSourceRequest[] = [];
    const recorder: RecallSourcePort = {
      id: "transcript",
      arm: "lexical",
      async search(request) {
        seen.push(request);
        return outcome("searched");
      },
    };

    const phases = await searchRecallPhases(
      [recorder, vectorSource()],
      QUERY,
      SCOPE,
      createRecallDeadline(1_000, () => 0),
    );

    expect(phases.candidates).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.terms).toBe(QUERY);
    expect(seen[0]?.terms.rawText).toBe(QUERY.rawText);
    expect(seen[0]?.scope).toEqual(SCOPE);
  });
});

describe("the deadline freezes at the phase boundary", () => {
  test("a frozen verdict stops following the clock it was built from", () => {
    let now = 0;
    const live = createRecallDeadline(1_000, () => now);
    const frozen = freezeRecallDeadline(live);

    expect(frozen.timeoutMs).toBe(1_000);
    expect(frozen.expired()).toBe(false);

    now = 5_000;
    expect(live.expired()).toBe(true);
    // The copy cannot be moved by the clock afterwards.
    expect(frozen.expired()).toBe(false);
  });

  test("a verdict already spent when frozen stays spent", () => {
    const frozen = freezeRecallDeadline({
      timeoutMs: 1_000,
      expired: () => true,
    });
    expect(frozen.expired()).toBe(true);
  });

  test("a clock that runs out during the vector arm is not the turn's timeout", async () => {
    let now = 0;
    const order: string[] = [];
    const phases = await searchRecallPhases(
      [
        lexicalSource(() => order.push("lexical")),
        vectorSource(() => {
          order.push("vector");
          // The encoder's own overrun: the arm spent the rest of the budget.
          now = 5_000;
        }),
      ],
      QUERY,
      SCOPE,
      createRecallDeadline(1_000, () => now),
    );

    expect(order).toEqual(["lexical", "vector"]);
    expect(phases.timedOut).toBe(false);
    expect(phases.candidates).toHaveLength(1);
    expect(
      phases.diagnostics.find((diagnostic) => diagnostic.source === "memory")
        ?.status,
    ).toBe("degraded");

    // The breaker's semantics are unchanged: a degraded vector arm is not a
    // failure, so a turn shaped like this must not be counted.
    expect(
      recordRecallDecision({
        entries: [],
        status: "no-match",
        diagnostics: {
          threshold: 0,
          candidates: 0,
          sources: phases.diagnostics,
        },
        timedOut: phases.timedOut,
      }),
    ).toBeNull();
    expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);
  });

  test("a clock that runs out during the lexical arm is the turn's timeout", async () => {
    let now = 0;
    const phases = await searchRecallPhases(
      [
        lexicalSource(() => {
          now = 5_000;
        }),
        vectorSource(),
      ],
      QUERY,
      SCOPE,
      createRecallDeadline(1_000, () => now),
    );

    // The freeze happens after the lexical loop, so this verdict is taken while
    // the clock is already past the budget.
    expect(phases.timedOut).toBe(true);
  });

  test("a source that throws leaves the other arm's candidates intact", async () => {
    const phases = await searchRecallPhases(
      [
        lexicalSource(),
        {
          id: "memory",
          arm: "vector",
          async search() {
            throw new Error("encoder offline");
          },
        },
      ],
      QUERY,
      SCOPE,
      createRecallDeadline(1_000, () => 0),
    );

    expect(phases.candidates).toHaveLength(1);
    expect(
      phases.diagnostics.find((diagnostic) => diagnostic.source === "memory"),
    ).toMatchObject({ status: "failed", reason: "encoder offline" });
    expect(phases.timedOut).toBe(false);
  });
});
