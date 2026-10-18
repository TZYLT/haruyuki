import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { PinDialog, validateAgentName } from "./PinDialog";

/**
 * `/pin`'s two views and the keys between them.
 *
 * The dialog had no test at all, and it is the one place the two text paths meet:
 * a default-named agent goes straight to the name field (Escape closes), a named
 * one chooses first (Escape goes back to the choice), and only a name the
 * backend's own rules accept reaches `onSubmit`.
 */

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const BACKSPACE = "\u007f";

afterEach(resetInkTtyState);

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

interface Mounted {
  tty: ReturnType<typeof mountInkTty>;
  submitted: (string | null)[];
  cancels: string[];
}

function mountPin(currentName: string): Mounted {
  const submitted: (string | null)[] = [];
  const cancels: string[] = [];
  const tty = mountInkTty(
    <PinDialog
      currentName={currentName}
      onSubmit={(name) => submitted.push(name)}
      onCancel={() => cancels.push("cancel")}
    />,
    { columns: 90, rows: 30 },
  );
  return { tty, submitted, cancels };
}

describe("validateAgentName", () => {
  test("accepts what the backend accepts and says why it does not", () => {
    expect(validateAgentName("my-agent_1")).toBeNull();
    expect(validateAgentName("O'Brien")).toBeNull();
    expect(validateAgentName("   ")).toContain("empty");
    expect(validateAgentName("bad/name")).toContain("invalid characters");
    expect(validateAgentName("x".repeat(101))).toContain("too long");
  });
});

describe("a default-named agent", () => {
  test("opens the name field, and Escape cancels", async () => {
    const { tty, cancels } = mountPin(DEFAULT_AGENT_NAME);
    try {
      const painted = await tty.text();
      expect(painted).toContain("> /pin");
      expect(painted).toContain("Name your agent");
      expect(painted).toContain("Enter a name:");

      await tty.press(ESC);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });

  test("Enter saves the trimmed name", async () => {
    const { tty, submitted } = mountPin(DEFAULT_AGENT_NAME);
    try {
      await tty.press("a", "t", "l", "a", "s");
      await settle();
      await tty.press(ENTER);
      expect(submitted).toEqual(["atlas"]);
    } finally {
      tty.stop();
    }
  });

  test("a name the rules reject paints the reason and saves nothing", async () => {
    const { tty, submitted } = mountPin(DEFAULT_AGENT_NAME);
    try {
      await tty.press("b", "a", "d", "/", "n");
      await settle();
      await tty.press(ENTER);
      const painted = await tty.text();
      expect(painted).toContain("invalid characters");
      expect(submitted).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("the field is a real editor: backspace deletes, Ctrl+C closes", async () => {
    const { tty, submitted, cancels } = mountPin(DEFAULT_AGENT_NAME);
    try {
      await tty.press("a", "b", "c", BACKSPACE);
      await settle();
      expect(await tty.text()).toContain("ab");
      await tty.press(ENTER);
      expect(submitted).toEqual(["ab"]);

      await tty.press(CTRL_C);
      expect(cancels).toEqual(["cancel"]);
    } finally {
      tty.stop();
    }
  });
});

describe("an agent with a name already", () => {
  test("chooses first, and Escape from the field goes back to the choice", async () => {
    const { tty, submitted, cancels } = mountPin("existing-name");
    try {
      let painted = await tty.text();
      expect(painted).toContain("Pin agent");
      expect(painted).toContain('1. Keep name "existing-name"');
      expect(painted).toContain("2. Change name");

      // Down to "Change name" and in.
      await tty.press(DOWN);
      await settle();
      await tty.press(ENTER);
      painted = await tty.text();
      expect(painted).toContain("Rename your agent");
      expect(painted).toContain("Enter a name:");

      // Escape is a step back, not a close — the dialog has a root to return to.
      await tty.press(ESC);
      painted = await tty.text();
      expect(painted).toContain("Pin agent");
      expect(cancels).toEqual([]);

      // And from the choice it does close.
      await tty.press(ESC);
      expect(cancels).toEqual(["cancel"]);
      expect(submitted).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("keeping the name submits null", async () => {
    const { tty, submitted } = mountPin("existing-name");
    try {
      await tty.press(ENTER);
      expect(submitted).toEqual([null]);
    } finally {
      tty.stop();
    }
  });
});
