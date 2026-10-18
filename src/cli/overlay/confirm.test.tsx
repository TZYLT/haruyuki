import { afterEach, describe, expect, test } from "bun:test";
import { Box } from "ink";
import { colors } from "@/cli/components/colors";
import { ConfirmOptions, TypedConfirmPrompt } from "@/cli/overlay/confirm";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The shared confirmation rows.
 *
 * Three delete confirmations in this tree each carried their own copy of this
 * markup, two of them styled differently. What is pinned here is that the shared
 * renderer reproduces **both** of them: the `/mcp` shape (`> ` marker, bold and
 * coloured whole row) and the `/hooks` shape (`❯ ` marker, coloured marker and
 * label, upright row). The rows were proven identical to the checked-out
 * pre-batch markup — including the full overlay for the typed confirmation, see
 * `AgentSelectorViews.test.tsx` — before the copies were deleted.
 *
 * The colours are not asserted, and cannot be: this test process paints with
 * colour disabled, so a frame carries no SGR at all. What is asserted is the
 * marker, its width on the unselected rows (which is what keeps the two variants'
 * alignment) and the labels.
 */

afterEach(resetInkTtyState);

const MCP_OPTIONS = [
  { key: "remove", label: "Yes, remove" },
  { key: "cancel", label: "No, cancel" },
];
const HOOK_OPTIONS = [
  { key: "delete", label: "Yes, delete" },
  { key: "cancel", label: "No, cancel" },
];

async function optionsFrame(
  element: React.ReactElement,
  columns = 60,
): Promise<string[]> {
  const tty = mountInkTty(element, { columns, rows: 30 });
  try {
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

describe("ConfirmOptions", () => {
  test("paints the /mcp variant: `> ` marker, bold and coloured row", async () => {
    expect(
      await optionsFrame(
        <Box marginTop={1} flexDirection="column">
          <ConfirmOptions
            options={MCP_OPTIONS}
            selectedIndex={0}
            marker="> "
            selectedColor={colors.selector.itemHighlighted}
            boldSelected
          />
        </Box>,
      ),
    ).toEqual(["", "> Yes, remove", "  No, cancel"]);
  });

  test("paints the /hooks variant: `❯ ` marker, coloured marker and label", async () => {
    expect(
      await optionsFrame(
        <ConfirmOptions options={HOOK_OPTIONS} selectedIndex={0} />,
      ),
    ).toEqual(["❯ Yes, delete", "  No, cancel"]);
  });

  test("the marker follows the selected option in both variants", async () => {
    expect(
      await optionsFrame(
        <ConfirmOptions options={HOOK_OPTIONS} selectedIndex={1} />,
      ),
    ).toEqual(["  Yes, delete", "❯ No, cancel"]);
    expect(
      await optionsFrame(
        <ConfirmOptions options={MCP_OPTIONS} selectedIndex={1} marker="> " />,
      ),
    ).toEqual(["  Yes, remove", "> No, cancel"]);
  });

  test("paints nothing for an empty option list", async () => {
    expect(
      await optionsFrame(<ConfirmOptions options={[]} selectedIndex={0} />),
    ).toEqual([]);
  });
});

describe("TypedConfirmPrompt", () => {
  test("shows the placeholder while empty and the value once typed", async () => {
    expect(
      await optionsFrame(
        <TypedConfirmPrompt value="" placeholder="(type the agent's name)" />,
      ),
    ).toEqual(["> (type the agent's name)"]);

    expect(
      await optionsFrame(
        <TypedConfirmPrompt
          value="my-agent"
          placeholder="(type the agent's name)"
        />,
      ),
    ).toEqual(["> my-agent"]);
  });
});
