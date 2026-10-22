import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { clearAllSubagents, registerSubagent } from "@/agent/subagent-state";
import type { FocusedApprovalView } from "@/cli/app/FocusedApproval";
import { ViewportPanel } from "@/cli/app/ViewportPanel";

/** A focused approval whose tool call is nowhere in the transcript. */
const APPROVAL: FocusedApprovalView = {
  currentApproval: {
    toolCallId: "ap-1",
    toolName: "MysteryTool",
    toolArgs: JSON.stringify({ key: "value" }),
  },
  currentApprovalContext: undefined,
  precomputedDiffsRef: { current: new Map() },
  handleApproveCurrent: async () => {},
  handleApproveAlways: async () => {},
  handleDenyCurrent: async () => {},
  handleCancelApprovals: () => {},
  showApprovalPreview: true,
  openOverlay: () => ({
    id: "cmd-test",
    input: "/test",
    update: () => {},
    finish: () => {},
    fail: () => {},
  }),
};

class CaptureStream extends Writable {
  columns = 60;
  rows = 20;
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

/** Renders the panel and returns the escaped frame it wrote. */
async function renderPanel(approvalIsDrawn: boolean): Promise<{
  frame: string;
  cleanup: () => void;
}> {
  const stdout = new CaptureStream();
  const instance = render(
    <ViewportPanel
      panelRef={{ current: null }}
      approvalIsDrawn={approvalIsDrawn}
      approval={APPROVAL}
    />,
    {
      stdout: stdout as CaptureStream & NodeJS.WriteStream,
      stdin: createInputStream(),
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await wait();

  return {
    frame: stdout.chunks.join(""),
    cleanup: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

afterEach(() => {
  clearAllSubagents();
});

describe("ViewportPanel", () => {
  test("renders nothing while no subagent runs", async () => {
    const { frame, cleanup } = await renderPanel(true);

    try {
      expect(frame).not.toContain("Running");
      expect(frame).not.toContain("MysteryTool");
    } finally {
      cleanup();
    }
  });

  test("shows the running subagent group", async () => {
    registerSubagent("sub-1", "task", "search the docs");

    const { frame, cleanup } = await renderPanel(true);

    try {
      expect(frame).toContain("Running");
      expect(frame).toContain("search the docs");
    } finally {
      cleanup();
    }
  });

  test("pins the focused approval when the band does not draw it", async () => {
    const { frame, cleanup } = await renderPanel(false);

    try {
      expect(frame).toContain("MysteryTool");
    } finally {
      cleanup();
    }
  });

  test("leaves the approval to the band when the band already draws it", async () => {
    const { frame, cleanup } = await renderPanel(true);

    try {
      expect(frame).not.toContain("MysteryTool");
    } finally {
      cleanup();
    }
  });
});
