import { afterEach, describe, expect, test } from "bun:test";
import { Box } from "ink";
import { ConfirmOptions } from "@/cli/overlay/confirm";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The shared confirmation rows.
 *
 * Three delete confirmations in this tree each carried their own copy of this
 * markup, and two of them were styled differently on purpose (M4's ruling: both
 * were already shipping). P7 unified them on the list row's shape — ASCII `> `,
 * accent, bold — because U+276F is missing from some fonts and the marker is the
 * only thing telling the user which row Enter fires on (《38》§11.8 ④).
 *
 * What is pinned here is that shape and the alignment it produces: the unselected
 * rows are blanked to the marker's width, so the labels stack. The colours are not
 * asserted, and cannot be: this test process paints with colour disabled, so a
 * frame carries no SGR at all.
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
  test("paints the one shape: `> ` marker and aligned labels", async () => {
    expect(
      await optionsFrame(
        <Box marginTop={1} flexDirection="column">
          <ConfirmOptions options={MCP_OPTIONS} selectedIndex={0} />
        </Box>,
      ),
    ).toEqual(["", "> Yes, remove", "  No, cancel"]);
  });

  test("a face gets no second variant to pass", async () => {
    // The old API took `marker` / `selectedColor` / `boldSelected`. The shape is
    // the component's now, so the same props list renders the same rows for every
    // caller — the /hooks confirmation and the /mcp one included.
    expect(
      await optionsFrame(
        <ConfirmOptions options={HOOK_OPTIONS} selectedIndex={0} />,
      ),
    ).toEqual(["> Yes, delete", "  No, cancel"]);
  });

  test("the marker follows the selected option", async () => {
    expect(
      await optionsFrame(
        <ConfirmOptions options={HOOK_OPTIONS} selectedIndex={1} />,
      ),
    ).toEqual(["  Yes, delete", "> No, cancel"]);
    expect(
      await optionsFrame(
        <ConfirmOptions options={MCP_OPTIONS} selectedIndex={1} />,
      ),
    ).toEqual(["  Yes, remove", "> No, cancel"]);
  });

  test("paints nothing for an empty option list", async () => {
    expect(
      await optionsFrame(<ConfirmOptions options={[]} selectedIndex={0} />),
    ).toEqual([]);
  });
});
