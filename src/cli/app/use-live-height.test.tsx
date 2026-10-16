/**
 * Guards the append shell's overflow estimate against the transcript display
 * state it has to follow: the keystroke that expands reasoning (ctrl+t) or
 * reminders (ctrl+r) is handled outside React, so the estimate only changes if
 * the hook subscribes to the display store. Measuring an expanded body as its
 * collapsed header is exactly how the overflow heuristic stopped noticing that
 * the screen had filled up.
 */
import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import {
  resetTranscriptDisplayState,
  setThinkingExpanded,
} from "@/cli/components/transcript-display-state";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { RECALL_DISPLAY_DEFAULT } from "@/reminders/recall-display";
import { RECALL_MARKER_TAG } from "@/reminders/recall-reminder";
import type { StaticItem } from "./types";
import {
  estimateLiveHeight,
  type LiveHeightInput,
  type LiveHeightOptions,
  useEstimatedLiveHeight,
} from "./use-live-height";

const COLUMNS = 40;
const ROWS = 12;

/** Header, input area, status bar and margins. */
const FIXED_BUFFER = 20;
const LINES_PER_SUBAGENT = 4;

const EMPTY_DIFFS = new Map();

/** What the caller knows; the display state is read from the transcript store. */
function input(overrides: Partial<LiveHeightInput> = {}): LiveHeightInput {
  return {
    items: [],
    columns: COLUMNS,
    terminalRows: ROWS,
    diffs: EMPTY_DIFFS,
    expandedToolCallId: null,
    lastShellToolCallId: null,
    subagentCount: 0,
    ...overrides,
  };
}

/** The pure entry point, with every display-state value spelled out. */
function measured(
  overrides: Partial<LiveHeightOptions> = {},
): LiveHeightOptions {
  return {
    ...input(),
    reasoningExpanded: false,
    systemRemindersVisible: false,
    systemRemindersExpanded: false,
    recallDisplay: RECALL_DISPLAY_DEFAULT,
    ...overrides,
  };
}

const REASONING_BODY = Array.from(
  { length: 12 },
  (_, index) => `thought line ${index}`,
).join("\n");

const REASONING: StaticItem = {
  kind: "reasoning",
  id: "reasoning",
  phase: "finished",
  text: REASONING_BODY,
};

const REMINDER_USER: StaticItem = {
  kind: "user",
  id: "user",
  text: `hello\n${SYSTEM_REMINDER_OPEN}\nnote line\n${SYSTEM_REMINDER_CLOSE}`,
};

function reminderBlock(body = "recalled passage"): string {
  return `${SYSTEM_REMINDER_OPEN}\n<${RECALL_MARKER_TAG} items="3" transcript="2" memory="1" />\n${body}\n${SYSTEM_REMINDER_CLOSE}`;
}

describe("estimateLiveHeight", () => {
  test("counts the fixed buffer with nothing to measure", () => {
    expect(estimateLiveHeight(measured())).toBe(FIXED_BUFFER);
  });

  test("adds the per-subagent rows on top", () => {
    expect(estimateLiveHeight(measured({ subagentCount: 3 }))).toBe(
      FIXED_BUFFER + 3 * LINES_PER_SUBAGENT,
    );
  });

  test("a visible reminder block is taller than a hidden one", () => {
    const hidden = estimateLiveHeight(measured({ items: [REMINDER_USER] }));
    const visible = estimateLiveHeight(
      measured({ items: [REMINDER_USER], systemRemindersVisible: true }),
    );

    expect(visible).toBeGreaterThan(hidden);
  });

  test("an expanding reminder block is taller than its collapsed header", () => {
    const collapsed = estimateLiveHeight(
      measured({ items: [REMINDER_USER], systemRemindersVisible: true }),
    );
    const expanded = estimateLiveHeight(
      measured({
        items: [REMINDER_USER],
        systemRemindersVisible: true,
        systemRemindersExpanded: true,
      }),
    );

    expect(expanded).toBeGreaterThan(collapsed);
  });

  test("a silent recall tier drops the recall block", () => {
    const item: StaticItem = {
      kind: "user",
      id: "recall",
      text: reminderBlock(),
    };

    expect(
      estimateLiveHeight(measured({ items: [item], recallDisplay: "summary" })),
    ).toBeGreaterThan(
      estimateLiveHeight(measured({ items: [item], recallDisplay: "silent" })),
    );
  });

  test("an expanded reasoning body is measured, spacer included", () => {
    // Gap + header collapsed; gap + header + one-row spacer + twelve body rows
    // expanded. The twelve body rows are the ones the append shell used to miss.
    expect(estimateLiveHeight(measured({ items: [REASONING] }))).toBe(
      FIXED_BUFFER + 2,
    );
    expect(
      estimateLiveHeight(
        measured({ items: [REASONING], reasoningExpanded: true }),
      ),
    ).toBe(FIXED_BUFFER + 15);
  });
});

class CaptureStream extends Writable {
  columns = COLUMNS;
  rows = ROWS;
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

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("useEstimatedLiveHeight", () => {
  test("re-measures when ctrl+t expands a reasoning body", async () => {
    resetTranscriptDisplayState();

    const reported = { height: 0 };

    function Probe() {
      reported.height = useEstimatedLiveHeight(input({ items: [REASONING] }));
      return <Text>measuring</Text>;
    }

    const instance = render(<Probe />, {
      stdout: new CaptureStream() as CaptureStream & NodeJS.WriteStream,
      stdin: createInputStream(),
      patchConsole: false,
      exitOnCtrlC: false,
    });

    try {
      await wait();
      const collapsed = reported.height;

      setThinkingExpanded(true);
      await wait();

      expect(collapsed).toBe(FIXED_BUFFER + 2);
      // Twelve body rows plus the spacer the expanded form adds.
      expect(reported.height - collapsed).toBe(13);
    } finally {
      instance.unmount();
      instance.cleanup();
      resetTranscriptDisplayState();
    }
  });
});
