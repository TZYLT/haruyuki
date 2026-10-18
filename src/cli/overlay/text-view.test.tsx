import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { OverlayFrame } from "./frame";
import { OverlayTextField, type OverlayTextFieldProps } from "./text-view";

/**
 * The text sub-view is judged on the row it paints and on the keys it does and
 * does not take.
 *
 * The reason this component exists is a behaviour, not a picture: nine overlays
 * appended keystrokes to a string by hand, so a paste into any of them was
 * dropped on the floor (`PasteAwareTextInput` is the only thing that receives
 * the paste channel; a hand-rolled appender is nobody). That is asserted here as
 * a paste that lands. The rest is the row: the marker, the mask, and `focus`
 * off leaving every key alone.
 *
 * Colours are not asserted and cannot be: this test process paints with colour
 * disabled (`confirm.test.tsx` records the same), so a frame carries no SGR.
 */

const BACKSPACE = "\u007f";
const ENTER = "\r";
const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;

interface Observed {
  value: string;
  submitted: string[];
}

function FieldProbe({
  observed,
  ...field
}: { observed: Observed } & Partial<OverlayTextFieldProps>) {
  const [value, setValue] = useState(field.value ?? "");
  return (
    <OverlayFrame command="/probe" title="Text">
      <OverlayTextField
        {...field}
        value={value}
        onChange={(next) => {
          observed.value = next;
          setValue(next);
        }}
        onSubmit={(text) => {
          observed.submitted.push(text);
        }}
      />
    </OverlayFrame>
  );
}

async function withField(
  run: (
    tty: ReturnType<typeof mountInkTty>,
    observed: Observed,
  ) => Promise<void>,
  field: Partial<OverlayTextFieldProps> = {},
): Promise<void> {
  const observed: Observed = { value: field.value ?? "", submitted: [] };
  const tty = mountInkTty(<FieldProbe observed={observed} {...field} />, {
    columns: 60,
    rows: 20,
  });
  try {
    await run(tty, observed);
  } finally {
    tty.stop();
  }
}

/** The row the editor paints on, found by what it holds. */
async function fieldRow(
  tty: ReturnType<typeof mountInkTty>,
  contains: string,
): Promise<string> {
  const rows = await tty.rows();
  return rows.find((row) => row.includes(contains)) ?? "";
}

afterEach(resetInkTtyState);

describe("OverlayTextField", () => {
  test("paints the marker before the editor, and types into it", async () => {
    await withField(async (tty, observed) => {
      expect(await fieldRow(tty, "> ")).toContain("> ");

      await tty.press("h", "i");
      expect(observed.value).toBe("hi");
      expect(await fieldRow(tty, "hi")).toContain("> hi");
    });
  });

  test("a pasted run lands in the field", async () => {
    // The regression this component exists for: the hand-rolled appenders had no
    // path from the paste channel to the value, so this text simply vanished.
    await withField(async (tty, observed) => {
      await tty.press(PASTE("pasted-key"));
      expect(observed.value).toBe("pasted-key");
      expect((await tty.text()).includes("pasted-key")).toBe(true);
    });
  });

  test("Backspace deletes and Enter submits what is in the field", async () => {
    await withField(async (tty, observed) => {
      await tty.press("a", "b", "c", BACKSPACE);
      expect(observed.value).toBe("ab");

      await tty.press(ENTER);
      expect(observed.submitted).toEqual(["ab"]);
    });
  });

  test("mask paints the value over with the mask character and never shows it", async () => {
    await withField(
      async (tty, observed) => {
        await tty.press("s", "e", "c", "r", "e", "t");
        expect(observed.value).toBe("secret");

        const painted = await tty.text();
        expect(painted.includes("secret")).toBe(false);
        expect(await fieldRow(tty, "******")).toContain("> ******");
      },
      { mask: "*" },
    );
  });

  test("marker null draws no marker at all", async () => {
    await withField(
      async (tty) => {
        const rows = await tty.rows();
        const body = rows[rows.indexOf("Text") + 1] ?? "";
        // The row is the editor's own content, with no `> ` in front of it.
        expect(body.startsWith("> ")).toBe(false);
      },
      { marker: null, value: "x" },
    );
  });

  test("focus off leaves every key to whoever owns it", async () => {
    await withField(
      async (tty, observed) => {
        await tty.press("h", "i", BACKSPACE);
        expect(observed.value).toBe("");
        expect(observed.submitted).toEqual([]);
      },
      { focus: false },
    );
  });
});
