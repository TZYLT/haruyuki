import { afterEach, describe, expect, test } from "bun:test";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { FeedbackDialog } from "./FeedbackDialog";

/**
 * `/feedback`'s one line: the frame it always drew, the field it now shares, and
 * the two ways out. The draft is a real editor, so a pasted message lands — this
 * dialog carried a `PasteAwareTextInput` already, but nothing pinned it.
 */

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;

afterEach(resetInkTtyState);

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function mountFeedback(): {
  tty: ReturnType<typeof mountInkTty>;
  submitted: string[];
  cancels: string[];
} {
  const submitted: string[] = [];
  const cancels: string[] = [];
  const tty = mountInkTty(
    <FeedbackDialog
      onSubmit={(message) => submitted.push(message)}
      onCancel={() => cancels.push("cancel")}
    />,
    { columns: 90, rows: 30 },
  );
  return { tty, submitted, cancels };
}

describe("FeedbackDialog", () => {
  test("draws the header and the prompt it always drew", async () => {
    const { tty } = mountFeedback();
    try {
      const rows = await tty.rows();
      expect(rows[0]).toBe("> /feedback");
      expect(/^─{10,}$/.test(rows[1] ?? "")).toBe(true);
      expect(rows[3]).toBe("  Enter your feedback:");
      const painted = await tty.text();
      expect(painted).toContain("Enter to submit · Esc cancel");
    } finally {
      tty.stop();
    }
  });

  test("submits the trimmed message on Enter", async () => {
    const { tty, submitted } = mountFeedback();
    try {
      await tty.press("n", "i", "c", "e", " ", "w", "o", "r", "k");
      await settle();
      await tty.press(ENTER);
      expect(submitted).toEqual(["nice work"]);
    } finally {
      tty.stop();
    }
  });

  test("a pasted message lands in the field", async () => {
    const { tty, submitted } = mountFeedback();
    try {
      await tty.press(PASTE("pasted feedback"));
      expect(await tty.text()).toContain("pasted feedback");
      await tty.press(ENTER);
      expect(submitted).toEqual(["pasted feedback"]);
    } finally {
      tty.stop();
    }
  });

  test("an empty message paints the reason and submits nothing", async () => {
    const { tty, submitted } = mountFeedback();
    try {
      await tty.press(ENTER);
      expect(await tty.text()).toContain("Feedback message cannot be empty");
      expect(submitted).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both close it", async () => {
    const { tty, cancels } = mountFeedback();
    try {
      await tty.press(ESC);
      expect(cancels).toEqual(["cancel"]);
      await tty.press(CTRL_C);
      expect(cancels).toEqual(["cancel", "cancel"]);
    } finally {
      tty.stop();
    }
  });
});
