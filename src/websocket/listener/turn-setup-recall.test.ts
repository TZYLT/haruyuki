import { expect, test } from "bun:test";
import {
  setConversationId,
  setCurrentAgentId,
  setCurrentAgentName,
} from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { DEFAULT_PERMISSION_MODE } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import {
  RECALL_FIXTURE_QUERY,
  withRecallFixture,
} from "@/test-utils/recall-fixture";
import { TestDirectory } from "@/test-utils/test-fs";
import { isolateAmbientHaruyukiTestEnv } from "@/test-utils/test-process-env";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { prepareListenerTurn } from "./turn-setup";
import { finishListenerTurn } from "./turn-terminal";
import { __listenerWarmupTestUtils } from "./warmup";

/**
 * Feature ② on the websocket path, end to end: the listener is the one submit path
 * whose text extraction has to *choose* which message counts (`turn-setup.ts`),
 * and the TUI and headless paths are asserted separately in
 * `src/reminders/recall-reminder.test.ts` and the wiring checks next to them.
 *
 * The turn that matters here is the one with a real backend behind it, because the
 * provider reads `N` and the dedup window out of the conversation record: a fake
 * backend would answer every question with "nothing to inject" and prove nothing.
 */
test("turn setup recalls against the inbound user's own words", async () => {
  await withRecallFixture(async (fixture) => {
    const directory = new TestDirectory();
    const originalHome = process.env.HOME;
    const restoreEnv = isolateAmbientHaruyukiTestEnv();
    process.env.HOME = directory.path;
    await settingsManager.reset();
    __testSetBackend(fixture.backend);

    const listener = createRuntime();
    const socket: ListenerTransport = {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };
    // Keep remote MemFS/secrets hydration outside this local turn-setup fixture.
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: async () => false,
      ensureSecretsHydratedForAgent: async () => {},
    });
    __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
      async () => false,
    );
    listener.modAdapter = createListenerModAdapter({
      globalModsDirectory: directory.createDir("mods"),
      cacheDirectory: directory.createDir("cache"),
    });
    setActiveRuntime(listener);

    async function prepareTurn(text: string) {
      const runtime = getOrCreateScopedRuntime(
        listener,
        fixture.agentId,
        fixture.currentConversationId,
      );
      runtime.skillSources = [];
      const lease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: directory.path,
      });
      try {
        const result = await prepareListenerTurn({
          msg: {
            type: "message",
            agentId: fixture.agentId,
            conversationId: fixture.currentConversationId,
            messages: [{ role: "user", content: text }],
            clientToolset: { base: "default" },
          },
          runtime,
          agentId: fixture.agentId,
          conversationId: fixture.currentConversationId,
          workingDirectory: directory.path,
          permissionModeState: { mode: DEFAULT_PERMISSION_MODE },
          turnLease: lease,
        });
        expect(result.kind).toBe("ready");
        if (result.kind !== "ready")
          throw new Error("Turn setup was not ready");
        return JSON.stringify(result.turnInput.messages);
      } finally {
        finishListenerTurn(runtime, lease, {
          stopReason: "end_turn",
          socket,
          agentId: fixture.agentId,
          conversationId: fixture.currentConversationId,
        });
      }
    }

    try {
      await settingsManager.initialize();

      // A turn whose words do not match anything recalls nothing. This is what
      // makes the next assertion about the *inbound text* rather than about the
      // conversation happening to contain the query.
      expect(await prepareTurn("今天天气不错")).not.toContain(
        "<recall-injected",
      );

      const injected = await prepareTurn(RECALL_FIXTURE_QUERY);
      expect(injected).toContain("<recall-injected");
      expect(injected).toContain("每日对账");
      // Injection is a pure prepend: the user's own message is still there.
      expect(injected).toContain(RECALL_FIXTURE_QUERY);
    } finally {
      disposeListenerModAdapter(listener);
      __listenerWarmupTestUtils.resetWarmupDepsForTests();
      __listenerModAdapterTestUtils.resetForTests();
      clearCapturedToolExecutionContexts();
      setActiveRuntime(null);
      setCurrentAgentId(null);
      setCurrentAgentName(null);
      setConversationId(null);
      __testSetBackend(null);
      await settingsManager.reset();
      restoreEnv();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
