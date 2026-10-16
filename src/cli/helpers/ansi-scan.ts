import { inkStringWidth } from "./text-metrics";

/**
 * A minimal ANSI scanner, shared by everything that has to reason about the
 * bytes Ink actually wrote.
 *
 * The app never rewrites Ink's output, but two features need to *read* it: the
 * selection (which copies the characters that are on screen) and its highlight
 * (which has to place two escape sequences at exact display columns inside a line
 * that is already full of them). Both need the same answer to "where are the
 * escape sequences, and how wide is the text between them", and neither may
 * count an escape as a column or mistake a parameter byte for content.
 *
 * It is deliberately not a terminal emulator: it splits one line into escapes,
 * text and controls, and nothing else. Cursor movement is not interpreted —
 * `terminal-frame.ts` only ever sees frames that begin with a clear-and-home.
 */

const ESC = "\u001B";

export type AnsiTokenKind = "text" | "escape" | "control";

export interface AnsiToken {
  kind: AnsiTokenKind;
  value: string;
}

/** Control characters carry no column, so they never take part in a selection. */
function isControlCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** The end of a CSI sequence: parameter bytes, then one final byte. */
function csiEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x20 && code <= 0x3f) index += 1;
    else break;
  }
  if (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) index += 1;
  }
  return index;
}

/** The end of an OSC sequence: BEL, or ST (`ESC \`). */
function oscEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    if (input[index] === "\u0007") return index + 1;
    if (input[index] === ESC && input[index + 1] === "\\") return index + 2;
    index += 1;
  }
  return index;
}

/** Split a string into escapes, text runs and controls, in order. */
export function scanAnsi(input: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let text = "";
  const flush = () => {
    if (text.length > 0) {
      tokens.push({ kind: "text", value: text });
      text = "";
    }
  };

  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;

    if (char === ESC) {
      flush();
      const next = input[index + 1];
      const end =
        next === "["
          ? csiEnd(input, index + 2)
          : next === "]"
            ? oscEnd(input, index + 2)
            : // A two-character escape (ESC =, ESC >, ESC ( B …).
              Math.min(input.length, index + 2);
      tokens.push({ kind: "escape", value: input.slice(index, end) });
      index = end;
      continue;
    }

    if (
      char === "\n" ||
      char === "\r" ||
      isControlCode(input.charCodeAt(index))
    ) {
      flush();
      tokens.push({ kind: "control", value: char });
      index += 1;
      continue;
    }

    text += char;
    index += 1;
  }

  flush();
  return tokens;
}

/** The characters of a line that occupy space on screen. */
export function visibleText(input: string): string {
  let text = "";
  for (const token of scanAnsi(input)) {
    if (token.kind === "text") text += token.value;
  }
  return text;
}

/** How many display columns a line's visible text takes. */
export function visibleWidth(input: string): number {
  return inkStringWidth(visibleText(input));
}
