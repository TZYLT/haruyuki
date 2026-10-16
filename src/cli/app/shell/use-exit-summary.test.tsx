import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import type { SessionStatsSnapshot } from "@/agent/stats";
import {
  registeredExitSummary,
  resetExitSummaryRegistration,
} from "@/cli/app/exit-summary";
import { useExitSummaryAfterTeardown } from "@/cli/app/shell/use-exit-summary";

const STATS: SessionStatsSnapshot = {
  sessionStartMs: 0,
  totalWallMs: 1_000,
  totalApiMs: 500,
  usage: {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    stepCount: 1,
  },
};

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 30));

function mount(showExitStats: boolean) {
  function Probe() {
    useExitSummaryAfterTeardown({
      showExitStats,
      sessionStatsRef: { current: { getSnapshot: () => STATS } },
      agentName: null,
      agentId: "agent-1",
      conversationId: "default",
    });
    return <Text>ready</Text>;
  }

  return render(<Probe />, {
    stdout: new CaptureStream() as CaptureStream & NodeJS.WriteStream,
    stdin: createInputStream(),
    patchConsole: false,
    exitOnCtrlC: false,
  });
}

afterEach(() => {
  resetExitSummaryRegistration();
});

describe("useExitSummaryAfterTeardown", () => {
  test("registers the shell's summary once the exit stats are drawn", async () => {
    const instance = mount(true);

    try {
      await wait();

      const summary = registeredExitSummary()?.exitSummary ?? "";
      expect(summary).toContain("Resume this agent with:");
      expect(summary).toContain("haruyuki --agent agent-1");
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  test("registers nothing while the session is still running", async () => {
    const instance = mount(false);

    try {
      await wait();
      expect(registeredExitSummary()).toBeUndefined();
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  test("unregisters when the shell unmounts", async () => {
    const instance = mount(true);
    await wait();
    expect(registeredExitSummary()).toBeDefined();

    instance.unmount();
    instance.cleanup();

    expect(registeredExitSummary()).toBeUndefined();
  });
});
