import { describe, expect, test } from "bun:test";
import {
  inlineMarkdownDisplayText,
  normalizeMarkdownBody,
} from "@/cli/helpers/markdown-text";

describe("inlineMarkdownDisplayText", () => {
  test("drops the markers InlineMarkdown never paints", () => {
    expect(inlineMarkdownDisplayText("a **bold** word")).toBe("a bold word");
    expect(inlineMarkdownDisplayText("an *italic* word")).toBe(
      "an italic word",
    );
    expect(inlineMarkdownDisplayText("a ~~struck~~ word")).toBe(
      "a struck word",
    );
    expect(inlineMarkdownDisplayText("a `code` word")).toBe("a code word");
    expect(inlineMarkdownDisplayText("see [docs](https://x.dev/a)")).toBe(
      "see docs (https://x.dev/a)",
    );
  });

  test("leaves plain text alone", () => {
    expect(inlineMarkdownDisplayText("plain text, 2 * 3")).toBe(
      "plain text, 2 * 3",
    );
    expect(inlineMarkdownDisplayText("C:\\projects\\haruyuki")).toBe(
      "C:\\projects\\haruyuki",
    );
  });

  test("unescapes a marker the renderer paints literally", () => {
    expect(inlineMarkdownDisplayText("a \\* star")).toBe("a * star");
  });
});

describe("normalizeMarkdownBody", () => {
  test("collapses a run of blank lines to one, like the renderer", () => {
    expect(normalizeMarkdownBody("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("drops leading blank lines but keeps trailing ones", () => {
    expect(normalizeMarkdownBody("\n\nbody\n")).toBe("body\n");
  });

  test("normalizes CRLF", () => {
    expect(normalizeMarkdownBody("a\r\nb")).toBe("a\nb");
  });
});
