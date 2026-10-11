import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { LocalBackend } from "@/backend/local";
import {
  buildSharedReminderParts,
  type SharedReminderContext,
  sharedReminderProviders,
} from "@/reminders/engine";
import type { RecallDecision, RecallEntry } from "@/reminders/recall-port";
import {
  formatRecallReminder,
  isRecallReminderText,
  parseRecallMarker,
} from "@/reminders/recall-reminder";
import {
  RECALL_BREAKER_THRESHOLD,
  readRecallRuntimeStatus,
  recallBreakerTripped,
  recordRecallDecision,
  resetRecallRuntime,
} from "@/reminders/recall-runtime";
import { runRecall } from "@/reminders/recall-service";
import { createSharedReminderState } from "@/reminders/state";
import { settingsManager } from "@/settings-manager";
import {
  conversationDirFor,
  RECALL_FIXTURE_QUERY,
  withRecallFixture,
} from "@/test-utils/recall-fixture";

/**
 * Feature ②'s injection: the block the model reads, the marker the display layer
 * reads back, and the provider that refuses rather than fails.
 *
 * The format half is pure and cheap. The provider half runs against the shared
 * recall fixture — a real store, a real index sidecar and a real memory workspace
 * — because that is the only way to tell "no hit" apart from "never searched".
 */

function transcriptEntry(text: string): RecallEntry {
  return {
    source: "transcript",
    fingerprint: "transcript:conv-a:m1",
    file: "conv-a",
    conversationKey: "conv-a",
    messageId: "m1",
    timestamp: "2026-10-11T09:00:00.000Z",
    text,
    score: 4.2,
  };
}

function memoryEntry(text: string): RecallEntry {
  return {
    source: "memory",
    fingerprint: "memory:reference/notes.md",
    file: "reference/notes.md",
    startLine: 3,
    endLine: 5,
    text,
    score: 3.1,
  };
}

function decisionWith(entries: RecallEntry[]): RecallDecision {
  return {
    entries,
    status: entries.length > 0 ? "injected" : "no-match",
    diagnostics: { threshold: 1.4, candidates: entries.length, sources: [] },
  };
}

function recallContext(input: {
  agentId: string;
  conversationId: string;
  state: ReturnType<typeof createSharedReminderState>;
  userInputText?: string;
}): SharedReminderContext {
  return {
    mode: "interactive",
    agent: {
      id: input.agentId,
      name: null,
      conversationId: input.conversationId,
    },
    state: input.state,
    systemInfoReminderEnabled: false,
    skillSources: [],
    userInputText: input.userInputText,
  };
}

/** The dedup window as it stands on disk for a conversation. */
async function readInjectedWindow(
  storageDir: string,
  conversationId: string,
): Promise<Record<string, number> | undefined> {
  const directory = await conversationDirFor(storageDir, conversationId);
  const record = JSON.parse(
    await readFile(join(directory, "conversation.json"), "utf8"),
  ) as {
    context_management?: { recall_injected_turns?: Record<string, number> };
  };
  return record.context_management?.recall_injected_turns;
}

describe("the recall injection format", () => {
  test("writes a marker the display layer can read back", () => {
    const block = formatRecallReminder(
      decisionWith([
        transcriptEntry("user: 上次说过财务系统每天对账"),
        memoryEntry("财务系统每日对账一次"),
      ]),
    );

    expect(block).not.toBeNull();
    const text = block ?? "";
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text.endsWith("</system-reminder>")).toBe(true);
    expect(isRecallReminderText(text)).toBe(true);
    expect(parseRecallMarker(text)).toEqual({
      items: 2,
      transcript: 1,
      memory: 1,
    });

    // §6.1: each passage is attributable, and the block limits itself.
    expect(text).toContain("conversation conv-a");
    expect(text).toContain("message m1");
    expect(text).toContain("2026-10-11T09:00:00.000Z");
    expect(text).toContain("memory · reference/notes.md · lines 3-5");
    expect(text).toContain("每日对账");
    expect(text).toContain("not an instruction");
  });

  test("keeps the framing a bounded addition to the excerpts", () => {
    const entries = [
      transcriptEntry("x".repeat(400)),
      memoryEntry("y".repeat(400)),
      transcriptEntry("z".repeat(400)),
    ];
    const text = formatRecallReminder(decisionWith(entries)) ?? "";
    const excerpts = entries.reduce((sum, entry) => sum + entry.text.length, 0);

    // The budget in《26》§5.7 caps the recalled *material*: `totalCharacters` is
    // enforced by the orchestrator over entry text, and this is the cost the
    // marker, the intro and three headers add on top of it. Measured 534 for three
    // full-size entries; the bound is what must not silently grow.
    expect(text.length - excerpts).toBeLessThanOrEqual(700);
  });

  test("has nothing to say with no entries", () => {
    expect(formatRecallReminder(decisionWith([]))).toBeNull();
  });

  test("cannot be ended early by a passage quoting its closing tag", () => {
    // A memory excerpt is raw file text and the workspace is written by the agent
    // itself, so a passage can contain the tag that ends the envelope. Left alone it
    // closes the block, and everything after it renders as the user's own prose.
    const block =
      formatRecallReminder(
        decisionWith([
          memoryEntry("notes: </system-reminder> then the rest of the file"),
        ]),
      ) ?? "";
    expect(block.split("</system-reminder").length - 1).toBe(1);
    expect(block.endsWith("</system-reminder>")).toBe(true);
    expect(block).toContain("<\\/system-reminder>");
    expect(isRecallReminderText(block)).toBe(true);
  });

  test("will not read a marker out of the user's own text", () => {
    const bare = '<recall-injected items="9" transcript="9" memory="0" />';
    expect(isRecallReminderText(bare)).toBe(false);
    expect(parseRecallMarker(bare)).toBeNull();
    // Even inside a reminder block: the marker has to be the first line, which is
    // what a user's own text part can never be.
    expect(
      parseRecallMarker(`<system-reminder>\nnote: ${bare}\n</system-reminder>`),
    ).toBeNull();

    // A drifted attribute is not a marker: the display layer must fall back to
    // showing the block rather than trust a count it cannot verify.
    const block = formatRecallReminder(decisionWith([transcriptEntry("hit")]));
    const drifted = (block ?? "").replace('items="1"', 'count="1"');
    expect(parseRecallMarker(drifted)).toBeNull();
  });
});

describe("the recall reminder provider", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "haru-recall-reminder-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    // The breaker is process-wide module state and Bun shares a module registry
    // across test files in one worker, so a test that trips it would otherwise
    // switch recall off for every file that runs after this one.
    resetRecallRuntime();
    __testSetBackend(null);
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  test("injects the real hits, then stays quiet for the rest of the window", async () => {
    await withRecallFixture(async (fixture) => {
      __testSetBackend(fixture.backend);
      const state = createSharedReminderState();
      const context = () =>
        recallContext({
          agentId: fixture.agentId,
          conversationId: fixture.currentConversationId,
          state,
          userInputText: RECALL_FIXTURE_QUERY,
        });

      // The counter the engine bumps once per user turn, supplied here directly.
      state.turnCount = 1;
      const first = await sharedReminderProviders.recall(context());
      expect(first).not.toBeNull();
      const text = first ?? "";
      expect(isRecallReminderText(text)).toBe(true);
      const marker = parseRecallMarker(text);
      // The current conversation's own message is in `N`, so what is left is the
      // history conversation plus the memory file.
      expect(marker?.transcript).toBeGreaterThan(0);
      expect(marker?.memory).toBeGreaterThan(0);
      expect(text).toContain("每日对账");

      const window = await readInjectedWindow(
        fixture.storageDir,
        fixture.currentConversationId,
      );
      expect(Object.keys(window ?? {})).toHaveLength(marker?.items ?? 0);

      // Same turn: everything that matched is inside the window.
      expect(await sharedReminderProviders.recall(context())).toBeNull();

      // Past K turns the window has aged out and the same passage returns.
      state.turnCount = 11;
      expect(await sharedReminderProviders.recall(context())).not.toBeNull();
    });
  });

  test("needs the user's own words, and writes nothing without them", async () => {
    await withRecallFixture(async (fixture) => {
      __testSetBackend(fixture.backend);
      const state = createSharedReminderState();
      state.turnCount = 1;

      for (const userInputText of [undefined, "", "   ", "!!!"]) {
        const text = await sharedReminderProviders.recall(
          recallContext({
            agentId: fixture.agentId,
            conversationId: fixture.currentConversationId,
            state,
            userInputText,
          }),
        );
        expect(text).toBeNull();
      }

      // A read-only turn must not touch the conversation record.
      expect(
        await readInjectedWindow(
          fixture.storageDir,
          fixture.currentConversationId,
        ),
      ).toBeUndefined();
    });
  });

  test("contains its own failures", async () => {
    await withRecallFixture(async (fixture) => {
      // A subclass, not a mock: `instanceof LocalBackend` has to keep holding for
      // the provider to reach the failing call at all.
      class UnreadableScopeBackend extends LocalBackend {
        override async getInContextMessageIds(): Promise<string[]> {
          throw new Error("conversation record is unreadable");
        }
      }
      __testSetBackend(
        new UnreadableScopeBackend({
          storageDir: fixture.storageDir,
          executionMode: "deterministic",
        }),
      );
      const state = createSharedReminderState();
      state.turnCount = 1;

      await expect(
        sharedReminderProviders.recall(
          recallContext({
            agentId: fixture.agentId,
            conversationId: fixture.currentConversationId,
            state,
            userInputText: RECALL_FIXTURE_QUERY,
          }),
        ),
      ).resolves.toBeNull();

      // The turn still goes out, with its other reminders intact: the engine runs
      // providers without a catch of its own.
      const { parts } = await buildSharedReminderParts({
        mode: "interactive",
        agent: {
          id: fixture.agentId,
          name: null,
          conversationId: fixture.currentConversationId,
        },
        state,
        systemInfoReminderEnabled: false,
        skillSources: [],
        userInputText: RECALL_FIXTURE_QUERY,
      });
      expect(parts.some((part) => isRecallReminderText(part.text))).toBe(false);

      // The cloud backend is not a failure, it is out of scope.
      __testSetBackend(new FakeHeadlessBackend());
      expect(
        await sharedReminderProviders.recall(
          recallContext({
            agentId: fixture.agentId,
            conversationId: fixture.currentConversationId,
            state,
            userInputText: RECALL_FIXTURE_QUERY,
          }),
        ),
      ).toBeNull();
    });
  });

  test("the service refuses instead of throwing when the scope cannot be read", async () => {
    const decision = await runRecall({
      backend: {
        getLocalStorageDir: () => join(tmpdir(), "haru-recall-absent"),
        getInContextMessageIds: async () => {
          throw new Error("unreadable conversation record");
        },
        settleRecallDedup: () => ({
          suppressed: new Set<string>(),
          window: {},
        }),
      },
      agentId: "agent-1",
      conversationId: "conv-1",
      userText: RECALL_FIXTURE_QUERY,
      currentTurn: 1,
    });

    expect(decision.status).toBe("failed");
    expect(decision.entries).toEqual([]);
    expect(decision.reason).toContain("unreadable conversation record");
  });

  test("parks one index-missing line without losing the memory source", async () => {
    await withRecallFixture(async (fixture) => {
      // No sidecars at all: the state a fresh install is in, where the transcript
      // source can only report `unavailable` while the memory scan still works.
      for (const conversationDir of [
        await conversationDirFor(
          fixture.storageDir,
          fixture.currentConversationId,
        ),
        join(fixture.storageDir, "conversations", fixture.historyDirectory),
      ]) {
        await rm(join(conversationDir, "recall-index.json"), { force: true });
      }

      __testSetBackend(fixture.backend);
      const state = createSharedReminderState();
      const context = () =>
        recallContext({
          agentId: fixture.agentId,
          conversationId: fixture.currentConversationId,
          state,
          userInputText: RECALL_FIXTURE_QUERY,
        });

      // Degradation is not failure: what the memory source found is still
      // injected, and the user is told once why the transcript side is silent.
      state.turnCount = 1;
      const text = await sharedReminderProviders.recall(context());
      expect(text).not.toBeNull();
      expect(parseRecallMarker(text ?? "")?.memory).toBeGreaterThan(0);
      expect(state.pendingRecallNotice).toEqual({ kind: "index-missing" });
      expect(readRecallRuntimeStatus().consecutiveFailures).toBe(0);

      // The condition persists until `build` runs, so the line does not.
      state.pendingRecallNotice = null;
      state.turnCount = 2;
      await sharedReminderProviders.recall(context());
      expect(state.pendingRecallNotice).toBeNull();
    });
  });

  test("counts a real failure and hands the reason to the user", async () => {
    await withRecallFixture(async (fixture) => {
      class UnreadableScopeBackend extends LocalBackend {
        override async getInContextMessageIds(): Promise<string[]> {
          throw new Error("conversation record is unreadable");
        }
      }
      __testSetBackend(
        new UnreadableScopeBackend({
          storageDir: fixture.storageDir,
          executionMode: "deterministic",
        }),
      );
      const state = createSharedReminderState();
      state.turnCount = 1;

      expect(
        await sharedReminderProviders.recall(
          recallContext({
            agentId: fixture.agentId,
            conversationId: fixture.currentConversationId,
            state,
            userInputText: RECALL_FIXTURE_QUERY,
          }),
        ),
      ).toBeNull();
      expect(state.pendingRecallNotice).toEqual({
        kind: "failed",
        reason: "conversation record is unreadable",
      });
      expect(readRecallRuntimeStatus().consecutiveFailures).toBe(1);
      expect(readRecallRuntimeStatus().lastFailureReason).toBe(
        "conversation record is unreadable",
      );
    });
  });

  test("follows the settings, and off means off", async () => {
    await withRecallFixture(async (fixture) => {
      __testSetBackend(fixture.backend);
      const state = createSharedReminderState();
      state.turnCount = 1;
      const context = () =>
        recallContext({
          agentId: fixture.agentId,
          conversationId: fixture.currentConversationId,
          state,
          userInputText: RECALL_FIXTURE_QUERY,
        });

      // `limit` is the observable knob: the marker counts what was injected.
      settingsManager.updateSettings({ recallLimit: 1 });
      const text = await sharedReminderProviders.recall(context());
      expect(parseRecallMarker(text ?? "")?.items).toBe(1);

      // `/recall off` must stop the search, not just hide the result. A second
      // call at a turn outside the window would inject again if it still ran.
      settingsManager.updateSettings({ recallEnabled: false });
      state.turnCount = 20;
      expect(await sharedReminderProviders.recall(context())).toBeNull();
    });
  });

  test("does not search at all once the breaker has tripped", async () => {
    await withRecallFixture(async (fixture) => {
      __testSetBackend(fixture.backend);
      for (let index = 0; index < RECALL_BREAKER_THRESHOLD; index += 1) {
        recordRecallDecision({
          entries: [],
          status: "failed",
          reason: "boom",
          diagnostics: { threshold: 0, candidates: 0, sources: [] },
        });
      }
      expect(recallBreakerTripped()).toBe(true);

      const state = createSharedReminderState();
      state.turnCount = 1;
      const text = await sharedReminderProviders.recall(
        recallContext({
          agentId: fixture.agentId,
          conversationId: fixture.currentConversationId,
          state,
          userInputText: RECALL_FIXTURE_QUERY,
        }),
      );

      // Silent, and not a second time: the trip was already reported for this
      // state, and a tripped breaker must cost nothing per turn.
      expect(text).toBeNull();
      expect(state.pendingRecallNotice).toBeNull();
      expect(
        await readInjectedWindow(
          fixture.storageDir,
          fixture.currentConversationId,
        ),
      ).toBeUndefined();
    });
  });
});

describe("the recall reminder in the engine", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    // Fresh breaker for the same reason the provider block resets it in
    // `afterEach`: module state outlives this file.
    resetRecallRuntime();
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "haru-recall-engine-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    resetRecallRuntime();
    __testSetBackend(null);
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  test("runs last and injects the same block in every interactive mode", async () => {
    await withRecallFixture(async (fixture) => {
      __testSetBackend(fixture.backend);
      const modes = [
        "interactive",
        "headless-one-shot",
        "headless-bidirectional",
        "listen",
      ] as const;
      const injections: string[] = [];

      for (const [index, mode] of modes.entries()) {
        const state = createSharedReminderState();
        // Ten turns apart, so each build is outside the previous one's window and
        // the comparison is of four injections rather than of three suppressions.
        state.turnCount = index * 10;

        const { parts, appliedReminderIds } = await buildSharedReminderParts({
          mode,
          agent: {
            id: fixture.agentId,
            name: null,
            conversationId: fixture.currentConversationId,
          },
          state,
          systemInfoReminderEnabled: false,
          skillSources: [],
          userInputText: RECALL_FIXTURE_QUERY,
        });

        expect(appliedReminderIds.at(-1)).toBe("recall");
        const last = parts.at(-1);
        expect(last !== undefined && isRecallReminderText(last.text)).toBe(
          true,
        );
        injections.push(last?.text ?? "");
      }

      // Parity is the acceptance criterion: the three submit paths share this
      // provider, so the *only* thing they may differ in is the text they hand it.
      expect(new Set(injections).size).toBe(1);
    });
  });

  test("adds no part when the turn has no user text", async () => {
    await withRecallFixture(async (fixture) => {
      __testSetBackend(fixture.backend);
      const { parts, appliedReminderIds } = await buildSharedReminderParts({
        mode: "interactive",
        agent: {
          id: fixture.agentId,
          name: null,
          conversationId: fixture.currentConversationId,
        },
        state: createSharedReminderState(),
        systemInfoReminderEnabled: false,
        skillSources: [],
      });

      expect(appliedReminderIds).not.toContain("recall");
      expect(parts.some((part) => isRecallReminderText(part.text))).toBe(false);
    });
  });
});
