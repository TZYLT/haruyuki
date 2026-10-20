/**
 * How wide does *this* terminal draw a glyph?
 *
 * The width table this app can import (`string-width`) has one answer per
 * character; the terminal has its own, chosen by the font it falls back to.
 * Measured on the development machine (Windows Terminal, 2026-10-20): `…` and `⚡︎`
 * are drawn two columns wide while the table says one or two, which was enough to
 * make an exact-width row wrap — and a wrapped row costs a whole line, which in the
 * full-screen shell scrolls the top row away. `ROW_SAFETY_COLUMNS` covers two
 * columns of that; this probe is how the table itself gets corrected.
 *
 * It asks the terminal: print the glyph at a known column, then ask where the
 * cursor ended up (DSR-CPR, `ESC [ 6 n`). The answer is exact, needs no screenshot,
 * and is the only way to learn a font's advances from inside a program.
 *
 *   bun run scripts/measure-glyph-widths.ts
 *
 * Exit codes: 0 measured, 1 the terminal did not answer (a pipe, or a terminal
 * without CPR). An unanswered probe is not a failure of the glyph — it means "run
 * this in a real terminal window".
 */

const ESC = "\u001B";
const CPR = `${ESC}[6n`;
const CURSOR_HOME = `${ESC}[H`;

/**
 * The characters this app actually puts on a row, plus the ones a model's answer
 * puts there. Box drawing is in the list on purpose: it is East-Asian "ambiguous"
 * per Unicode and *must* stay one column, because the rules and table borders are
 * drawn by repeating it.
 */
const CANDIDATES: readonly (readonly [string, string])[] = [
  ["…", "ellipsis (truncation)"],
  ["·", "middle dot (status line)"],
  ["•", "bullet (transcript, unread mark)"],
  ["×", "close affordance"],
  ["─", "rule glyph (box drawing)"],
  ["│", "continuation bar (box drawing)"],
  ["└", "result corner (box drawing)"],
  ["┃", "heavy table border"],
  ["═", "header rule"],
  ["›", "input prompt"],
  ["▶", "play marker"],
  ["⚡︎", "high voltage + text selector"],
  ["←", "left arrow"],
  ["→", "right arrow"],
  ["−", "minus sign"],
  ["≈", "almost equal"],
  ["≤", "less or equal"],
  ["—", "em dash"],
  ["“", "left double quote"],
  ["”", "right double quote"],
  ["中", "CJK (control: must be 2)"],
];

/**
 * One CPR answer: `ESC [ rows ; columns R`.
 *
 * Built from `String.fromCharCode` rather than written as an escape in the literal:
 * a control character inside a regex literal is a lint error, and the reason is
 * good — a raw ESC in source is invisible in review. The escape codes this file
 * needs are named once, at the top.
 */
const CPR_ANSWER = new RegExp(`${String.fromCharCode(27)}\\[(\\d+);(\\d+)R`);

type Measurement = { label: string; glyph: string; width: number | null };

function isTty(): boolean {
  const stdin = process.stdin as { isTTY?: boolean };
  const stdout = process.stdout as { isTTY?: boolean };
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** Read one CPR answer: `ESC [ rows ; columns R`. */
function readCursorPosition(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += String(chunk);
      const match = CPR_ANSWER.exec(buffer);
      if (!match) return;
      finish(Number.parseInt(match[2] ?? "", 10));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(columns: number | null): void {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve(columns);
    }
    process.stdin.on("data", onData);
  });
}

async function measure(glyph: string): Promise<number | null> {
  // Column 1, print the glyph, ask where the cursor is. A one-column glyph leaves
  // the cursor on column 2.
  process.stdout.write(`${CURSOR_HOME}${glyph}${CPR}`);
  const column = await readCursorPosition(400);
  process.stdout.write(`${CURSOR_HOME}${ESC}[K`);
  return column === null ? null : column - 1;
}

async function main(): Promise<void> {
  if (!isTty()) {
    console.error(
      "Not a terminal: this probe needs one to answer the cursor-position query.",
    );
    process.exit(1);
  }

  const stdin = process.stdin as NodeJS.ReadStream;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();

  const results: Measurement[] = [];
  try {
    for (const [glyph, label] of CANDIDATES) {
      const width = await measure(glyph);
      results.push({ label, glyph, width });
      if (width === null) break;
    }
  } finally {
    if (!wasRaw) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write(`${CURSOR_HOME}${ESC}[K`);
  }

  if (results.some((result) => result.width === null)) {
    console.error(
      "The terminal did not answer the cursor-position query (no CPR). Run this in Windows Terminal, iTerm2, kitty or another modern terminal.",
    );
    process.exit(1);
  }

  const widest = Math.max(...results.map((result) => result.label.length));
  console.log("glyph  width  what");
  for (const result of results) {
    const glyph = `${result.glyph} `.padEnd(8);
    console.log(
      `${glyph} ${String(result.width).padStart(3)}   ${result.label.padEnd(widest)}`,
    );
  }
  // The one comparison this probe exists to settle.
  const control = results.find((result) => result.glyph === "中");
  if (control?.width !== 2) {
    console.error(
      `\nWarning: CJK measured ${control?.width ?? "?"} columns, not 2 — the terminal is not in a state this probe understands.`,
    );
    process.exit(1);
  }
}

await main();
