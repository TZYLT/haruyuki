import { describe, expect, test } from "bun:test";
import {
  type ClipboardStream,
  copyText,
  MAX_OSC52_BYTES,
  osc52Sequence,
} from "@/cli/helpers/terminal-clipboard";

const BEL = "\u0007";

function fakeStream(isTTY = true): ClipboardStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    isTTY,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

/** The text a terminal would decode from the sequence we wrote. */
function decodeOsc52(sequence: string): string {
  const prefix = "\u001B]52;c;";
  expect(sequence.startsWith(prefix)).toBe(true);
  const payload = sequence.slice(prefix.length, -BEL.length);
  return Buffer.from(payload, "base64").toString("utf8");
}

describe("terminal clipboard", () => {
  test("encodes the text as an OSC 52 sequence", () => {
    const sequence = osc52Sequence("hello\nworld");
    expect(sequence.startsWith("\u001B]52;c;")).toBe(true);
    expect(sequence.endsWith(BEL)).toBe(true);
    expect(decodeOsc52(sequence)).toBe("hello\nworld");
    // Wide characters survive the round trip, which is the point of base64.
    expect(decodeOsc52(osc52Sequence("中文 😀"))).toBe("中文 😀");
  });

  test("writes OSC 52 and also attempts the local command", () => {
    const stream = fakeStream();
    const attempts: string[] = [];

    const result = copyText("copied text", {
      stream,
      copyLocally: (text) => {
        attempts.push(text);
        return true;
      },
    });

    // OSC 52 cannot report failure, so the local command is not a fallback that
    // waits for one: both are attempted, and the result says so.
    expect(result).toEqual({ method: "osc52+local", bytes: 11 });
    expect(attempts).toEqual(["copied text"]);
    expect(decodeOsc52(stream.writes[0] ?? "")).toBe("copied text");
  });

  test("reports OSC 52 alone when the local command fails", () => {
    const stream = fakeStream();
    const result = copyText("over ssh", {
      stream,
      copyLocally: () => false,
    });

    expect(result.method).toBe("osc52");
    expect(stream.writes).toHaveLength(1);
  });

  test("reports the local command alone when the stream is not a terminal", () => {
    const stream = fakeStream(false);
    const result = copyText("piped", { stream, copyLocally: () => true });

    expect(result.method).toBe("local");
    expect(stream.writes).toEqual([]);
  });

  test("reports nothing when no channel was available", () => {
    const result = copyText("lost", {
      stream: fakeStream(false),
      copyLocally: () => false,
    });

    expect(result.method).toBe("none");
    expect(result.bytes).toBe(4);
  });

  test("keeps a very large payload off OSC 52", () => {
    const stream = fakeStream();
    const large = "x".repeat(MAX_OSC52_BYTES + 1);

    const result = copyText(large, { stream, copyLocally: () => true });

    // Terminals that accept a payload this size may buffer or truncate it, so the
    // local command takes it whole instead.
    expect(result.method).toBe("local");
    expect(stream.writes).toEqual([]);
  });

  test("an empty selection copies nothing at all", () => {
    const stream = fakeStream();
    const result = copyText("", { stream, copyLocally: () => true });

    expect(result).toEqual({ method: "none", bytes: 0 });
    expect(stream.writes).toEqual([]);
  });

  test("survives a stream that refuses the write", () => {
    const stream: ClipboardStream = {
      isTTY: true,
      write() {
        throw new Error("EPIPE");
      },
    };

    const result = copyText("text", { stream, copyLocally: () => true });
    expect(result.method).toBe("local");
  });
});
