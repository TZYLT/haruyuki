import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import { useEffect } from "react";
import type { SessionStatsSnapshot } from "@/agent/stats";
import {
  exitSummaryLines,
  exitSummaryText,
  isExitSummaryResult,
  pendingExitSummaryText,
  registerExitSummary,
  registeredExitSummary,
  resetExitSummaryRegistration,
  setExitSummaryIo,
  useExitAfterSummary,
} from "./exit-summary";

const STATS: SessionStatsSnapshot = {
  sessionStartMs: 0,
  totalWallMs: 65_000,
  totalApiMs: 12_000,
  usage: {
    promptTokens: 1_500,
    completionTokens: 250,
    totalTokens: 1_750,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    stepCount: 7,
  },
  requestCount: 7,
};

function input(
  overrides: Partial<Parameters<typeof exitSummaryLines>[0]> = {},
) {
  return {
    stats: STATS,
    agentName: null,
    agentId: "agent-1",
    conversationId: "default",
    ...overrides,
  };
}

afterEach(() => {
  resetExitSummaryRegistration();
  setExitSummaryIo(null);
});

describe("exitSummaryLines", () => {
  test("labels the three stat rows", () => {
    const texts = exitSummaryLines(input()).map((line) => line.text);

    expect(texts[0]).toStartWith("Total duration (API):");
    expect(texts[1]).toStartWith("Total duration (wall):");
    expect(texts[2]).toStartWith("Session usage: 7 steps,");
    expect(texts[2]).toContain("1.5k input");
  });

  test("resumes by agent id, and the conversation only when it is not default", () => {
    expect(exitSummaryLines(input())).toContainEqual({
      id: "resume-agent",
      kind: "command",
      text: "haruyuki --agent agent-1",
    });
    expect(exitSummaryText(input())).not.toContain("--conv");

    const resumed = input({ conversationId: "conv-9" });
    expect(exitSummaryText(resumed)).toContain("haruyuki --conv conv-9");
    expect(exitSummaryText(resumed)).toContain(
      "Resume this conversation with:",
    );
  });

  test("the plain text keeps the blank separators the component draws", () => {
    const text = exitSummaryText(input({ conversationId: "conv-9" }));
    const lines = exitSummaryLines(input({ conversationId: "conv-9" }));

    expect(text.split("\n")).toHaveLength(lines.length);
    expect(text.split("\n").filter((line) => line === "").length).toBe(2);
  });
});

describe("exit summary registration", () => {
  test("nothing is registered by default", () => {
    expect(registeredExitSummary()).toBeUndefined();
  });

  test("a registered summary is produced at exit time, not at registration", () => {
    let counter = 0;
    registerExitSummary(() => `summary ${++counter}`);

    expect(registeredExitSummary()?.exitSummary).toBe("summary 1");
    expect(registeredExitSummary()?.exitSummary).toBe("summary 2");
  });

  test("unregistering removes it, and the unregister is idempotent", () => {
    const unregister = registerExitSummary(() => "first");
    expect(registeredExitSummary()?.exitSummary).toBe("first");

    unregister();
    unregister();
    expect(registeredExitSummary()).toBeUndefined();
  });

  test("an empty summary registers nothing to print", () => {
    registerExitSummary(() => "");
    expect(registeredExitSummary()).toBeUndefined();
  });
});

describe("pendingExitSummaryText", () => {
  test("wraps the payload in blank lines", () => {
    expect(pendingExitSummaryText({ exitSummary: "hello" })).toBe("\nhello\n");
  });

  test("is null for anything that is not a summary payload", () => {
    expect(pendingExitSummaryText(undefined)).toBeNull();
    expect(pendingExitSummaryText(null)).toBeNull();
    expect(pendingExitSummaryText("hello")).toBeNull();
    expect(pendingExitSummaryText({})).toBeNull();
    expect(pendingExitSummaryText({ exitSummary: 3 })).toBeNull();
    expect(pendingExitSummaryText({ other: "hello" })).toBeNull();
  });

  test("recognises the payload the core hands to Ink", () => {
    expect(isExitSummaryResult({ exitSummary: "x" })).toBe(true);
    expect(isExitSummaryResult({ exitSummary: 3 })).toBe(false);
  });
});

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
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

/** Leaves the alternate screen; Ink writes this while tearing down. */
const EXIT_ALTERNATE_SCREEN = "\u001B[?1049l";

describe("useExitAfterSummary", () => {
  test("leaves the alternate screen before writing, then exits", async () => {
    const stdout = new CaptureStream();
    const written: string[] = [];
    const exited: number[] = [];
    let screenLeftAtWrite = false;

    setExitSummaryIo({
      exit: (code) => {
        exited.push(code);
      },
      write: (text) => {
        screenLeftAtWrite = stdout.chunks
          .join("")
          .includes(EXIT_ALTERNATE_SCREEN);
        written.push(text);
      },
    });

    const exitApp = { current: () => {} };

    function Probe() {
      const exit = useExitAfterSummary();
      useEffect(() => {
        exitApp.current = exit;
      }, [exit]);
      return <Text>ready</Text>;
    }

    const unregister = registerExitSummary(() => "SESSION SUMMARY");
    const instance = render(<Probe />, {
      stdout: stdout as CaptureStream & NodeJS.WriteStream,
      stdin: createInputStream(),
      patchConsole: false,
      exitOnCtrlC: false,
      alternateScreen: true,
    });

    try {
      await wait();
      exitApp.current();
      await wait();

      expect(written).toEqual(["\nSESSION SUMMARY\n"]);
      expect(exited).toEqual([0]);
      // The whole point of the macrotask: Ink had already restored the primary
      // buffer, so the summary does not land on the screen it discarded.
      expect(screenLeftAtWrite).toBe(true);
    } finally {
      unregister();
      instance.unmount();
      instance.cleanup();
    }
  });
});
