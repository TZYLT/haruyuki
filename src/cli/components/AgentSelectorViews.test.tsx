import { afterEach, describe, expect, test } from "bun:test";
import { AgentDeleteConfirmOverlay } from "@/cli/components/AgentSelectorViews";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The typed-name delete confirmation, judged on the frame.
 *
 * Two things are worth pinning. The frame's chrome: this view was one of
 * `OverlayShell`'s remaining consumers, and the frame it now draws is the same
 * markup (the full overlay was driven against the checked-out pre-batch version in
 * four states and came back row for row identical). And the footer's three
 * wordings, because they are the only place the user is told that Enter will do
 * the deed at all: `Enter to delete` appears **only** once the typed name matches,
 * which is the rule the parent component enforces before it deletes anything.
 */

afterEach(resetInkTtyState);

const SOLID = "─";
const COLUMNS = 100;

async function confirmFrame(props: {
  command?: string;
  displayName?: string;
  input: string;
  loading?: boolean;
}): Promise<string[]> {
  const tty = mountInkTty(
    <AgentDeleteConfirmOverlay
      command={props.command ?? "/resume"}
      displayName={props.displayName ?? "my-agent"}
      input={props.input}
      loading={props.loading ?? false}
      onInputChange={() => {}}
      onInputSubmit={() => {}}
    />,
    { columns: COLUMNS, rows: 40 },
  );
  try {
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

function frameRows(prompt: string, footer: string): string[] {
  return [
    "> /resume",
    SOLID.repeat(COLUMNS),
    "",
    "Delete agent",
    "",
    "  Are you sure you want to delete my-agent?",
    "  This action can not be undone.",
    "",
    prompt,
    "",
    footer,
  ];
}

describe("AgentDeleteConfirmOverlay", () => {
  test("asks for the name and offers no delete key while it is empty", async () => {
    expect(await confirmFrame({ input: "" })).toEqual(
      frameRows("> (type the agent's name)", "  Esc cancel"),
    );
  });

  test("offers Enter once the typed name matches", async () => {
    expect(await confirmFrame({ input: "my-agent" })).toEqual(
      frameRows("> my-agent", "  Enter to delete · Esc cancel"),
    );
  });

  test("keeps offering only Esc while the name does not match", async () => {
    expect(await confirmFrame({ input: "my-agen" })).toEqual(
      frameRows("> my-agen", "  Esc cancel"),
    );
  });

  test("says it is deleting while the delete is in flight", async () => {
    expect(await confirmFrame({ input: "my-agent", loading: true })).toEqual(
      frameRows("> my-agent", "  Deleting... · Esc cancel"),
    );
  });
});
