import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { __testSetBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { settingsManager } from "@/settings-manager";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import {
  type NoProviderDeps,
  NoProviderEmptyState,
} from "./NoProviderEmptyState";

/**
 * `--no-provider`'s empty state, judged on the frame (T-07, R-07.3–R-07.5).
 *
 * What has to be true is visible: the explanation and the two connection routes
 * paint, a message sent in this state gets the connect hint instead of silence,
 * an appearing provider creates the default agent and leaves the empty state
 * (Q-44), and a creation failure stays here with one readable line instead of
 * exiting.
 */

const ENTER = "\r";

const tempHome = mkdtempSync(join(tmpdir(), "hryk-t07-empty-home-"));
const tempBackend = mkdtempSync(join(tmpdir(), "hryk-t07-empty-backend-"));
console.log(
  `[T-07 empty state] temp dirs: HARUYUKI_HOME=${tempHome} LETTA_LOCAL_BACKEND_DIR=${tempBackend}`,
);

let previousHome: string | undefined;
let previousBackendDir: string | undefined;
let previousBackendMode: BackendMode;

beforeEach(async () => {
  previousHome = process.env.HARUYUKI_HOME;
  previousBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
  process.env.HARUYUKI_HOME = tempHome;
  process.env.LETTA_LOCAL_BACKEND_DIR = tempBackend;

  await settingsManager.reset();
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  __testSetBackend(new FakeHeadlessBackend());
  await settingsManager.initialize();
});

afterEach(() => {
  clearAvailableModelsCache();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  if (previousBackendDir === undefined)
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = previousBackendDir;
  resetInkTtyState();
});

const idleDeps: Partial<NoProviderDeps> = {
  listConnectedProviders: async () => [],
  completeConnection: async () => ({
    kind: "error",
    message: "unused",
  }),
  pollIntervalMs: 60_000,
};

function mount(
  deps: Partial<NoProviderDeps>,
  onConnected: (agentId: string) => void,
): InkTty {
  return mountInkTty(
    <NoProviderEmptyState onConnected={onConnected} deps={deps} />,
    { columns: 110, rows: 34 },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForText(
  tty: InkTty,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await tty.text();
    if (text.includes(needle)) return text;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for "${needle}". Frame:\n${text}`);
}

describe("the --no-provider empty state", () => {
  test("paints the explanation and both connection routes", async () => {
    const tty = mount(idleDeps, () => {});
    try {
      const text = await tty.text();
      expect(text).toContain("Haruyuki is not connected");
      expect(text).toContain("no agent and no model");
      expect(text).toContain("/config connect");
      expect(text).toContain("haruyuki connect <provider>");
    } finally {
      tty.stop();
    }
  });

  test("a message sent in the empty state gets the connect hint, not silence", async () => {
    const tty = mount(idleDeps, () => {});
    try {
      await tty.press("h", "e", "l", "l", "o");
      await tty.press(ENTER);
      const text = await waitForText(tty, "Not connected yet");
      expect(text).toContain("connect a provider before sending messages");
      expect(text).toContain("/config connect");
    } finally {
      tty.stop();
    }
  });

  test("Enter on an empty line opens the reused provider selector", async () => {
    const tty = mount(idleDeps, () => {});
    try {
      await tty.press(ENTER);
      const text = await waitForText(tty, "Connect your LLM API keys");
      expect(text).toContain("Amazon Bedrock");
    } finally {
      tty.stop();
    }
  });

  test("Ctrl+C leaves the empty state instead of typing into it", async () => {
    const cancels: string[] = [];
    const tty = mountInkTty(
      <NoProviderEmptyState
        onConnected={() => {}}
        onCancel={() => cancels.push("cancel")}
        deps={idleDeps}
      />,
      { columns: 110, rows: 34 },
    );
    try {
      await tty.press("\u0003");
      const deadline = Date.now() + 2000;
      while (cancels.length === 0 && Date.now() < deadline) await sleep(20);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });

  test("a provider appearing in the store creates the default agent and leaves the empty state", async () => {
    const connected: string[] = [];
    const tty = mount(
      {
        listConnectedProviders: async () => ["deepseek"],
        completeConnection: async () => ({
          kind: "connected",
          agentId: "agent-from-connect",
        }),
        pollIntervalMs: 10,
      },
      (agentId) => connected.push(agentId),
    );
    try {
      const deadline = Date.now() + 5000;
      while (connected.length === 0 && Date.now() < deadline) await sleep(20);
      expect(connected).toEqual(["agent-from-connect"]);
    } finally {
      tty.stop();
    }
  });

  test("a failed auto-continue stays in the empty state with the error and stops polling", async () => {
    let attempts = 0;
    const tty = mount(
      {
        listConnectedProviders: async () => ["deepseek"],
        completeConnection: async () => {
          attempts += 1;
          return {
            kind: "error",
            message:
              "Provider connected, but creating the default agent failed: catalog empty",
          };
        },
        pollIntervalMs: 10,
      },
      () => {
        throw new Error("must not enter the session after a failed continue");
      },
    );
    try {
      await waitForText(tty, "creating the default agent failed");
      const attemptsAfterFailure = attempts;
      await sleep(100);
      expect(attempts).toBe(attemptsAfterFailure);
      expect(attempts).toBe(1);
    } finally {
      tty.stop();
    }
  });
});
