/**
 * Pins advertisement ⇄ dispatch parity for `execute_command` wire ids.
 *
 * `SUPPORTED_REMOTE_COMMANDS` is the list a desktop client reads from
 * `device_status.supported_commands` and gates controls on; the switch in
 * `commands.ts` is what actually answers. Those two drifted once already
 * (the pre-rename `set-max-context` kept its case but lost its advertised
 * entry, while `secret`, `monitor_stop` and `toolset` are advertised but ride
 * dedicated WebSocket messages), so this file fails if the drift can return:
 *
 * - every advertised id is either a `case` in the switch or documented in
 *   `REMOTE_COMMANDS_HANDLED_ELSEWHERE` with the message type that serves it;
 * - every unadvertised `case` is a documented legacy alias, so an id cannot be
 *   quietly dropped from (or added to) the client allowlist;
 * - both retained wire ids (`clear-messages`, `reflection`) stay dispatchable.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REMOTE_COMMANDS_HANDLED_ELSEWHERE,
  SUPPORTED_REMOTE_COMMANDS,
  UNADVERTISED_REMOTE_COMMAND_ALIASES,
} from "./listener-constants";

const SWITCH_MARKER = "switch (command.command_id) {";

function readCommandsSource(): string {
  return readFileSync(
    fileURLToPath(new URL("./commands.ts", import.meta.url)),
    "utf-8",
  );
}

/**
 * Find the closing brace of the dispatch switch. Braces inside comments,
 * strings and template literals are skipped so only the switch's own structure
 * is measured.
 */
function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd < 0 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd < 0 ? source.length : commentEnd + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/** Case labels of `handleExecuteCommand`'s dispatch switch, in source order. */
function dispatchSwitchCases(source: string): string[] {
  const markerIndex = source.indexOf(SWITCH_MARKER);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const bodyStart = markerIndex + SWITCH_MARKER.length - 1;
  const bodyEnd = findMatchingBrace(source, bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);

  return [
    ...source.slice(bodyStart, bodyEnd).matchAll(/case\s+"([^"]+)"\s*:/g),
  ].map((match) => match[1] as string);
}

function asSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

/** Values in `values` that `other` does not contain, sorted for comparison. */
function difference(
  values: Iterable<string>,
  other: ReadonlySet<string>,
): string[] {
  return [...values].filter((value) => !other.has(value)).sort();
}

const advertised = [...SUPPORTED_REMOTE_COMMANDS];
const advertisedSet = asSet(advertised);
const dispatched = dispatchSwitchCases(readCommandsSource());
const dispatchedSet = asSet(dispatched);

describe("execute_command list/switch parity", () => {
  test("the case scan really covered the dispatch switch", () => {
    // A canary so a marker rename fails this file instead of vacuously passing.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched).toContain("clear");
    expect(dispatched).toContain("compact");
  });

  test("the advertised list has no duplicates", () => {
    expect(advertisedSet.size).toBe(advertised.length);
  });

  test("every advertised id is dispatched or documented as handled elsewhere", () => {
    expect(difference(advertised, dispatchedSet)).toEqual(
      Object.keys(REMOTE_COMMANDS_HANDLED_ELSEWHERE).sort(),
    );
  });

  test("every unadvertised dispatch case is a documented legacy alias", () => {
    expect(difference(dispatched, advertisedSet)).toEqual(
      Object.keys(UNADVERTISED_REMOTE_COMMAND_ALIASES).sort(),
    );
  });

  test("handled-elsewhere entries are advertised and name where they are served", () => {
    for (const [id, reason] of Object.entries(
      REMOTE_COMMANDS_HANDLED_ELSEWHERE,
    )) {
      expect(advertisedSet.has(id)).toBe(true);
      expect(dispatchedSet.has(id)).toBe(false);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("legacy aliases keep dispatching while staying unadvertised", () => {
    for (const [id, reason] of Object.entries(
      UNADVERTISED_REMOTE_COMMAND_ALIASES,
    )) {
      expect(dispatchedSet.has(id)).toBe(true);
      expect(advertisedSet.has(id)).toBe(false);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("set-max-context stays the unadvertised alias of context-limit", () => {
    // The rename commit (#2409) advertises `context-limit`; `set-max-context`
    // is a client-compatibility case only. Flipping either half breaks old
    // clients or re-exposes a retired name.
    expect(dispatchedSet.has("set-max-context")).toBe(true);
    expect(advertised).toContain("context-limit");
    expect(advertised).not.toContain("set-max-context");
    expect(UNADVERTISED_REMOTE_COMMAND_ALIASES).toHaveProperty(
      "set-max-context",
    );
  });

  test("retained wire ids for retired TUI names still dispatch", () => {
    // `clear-messages` and `reflection` are wire ids only; the TUI forms are
    // `/messages clear` and `/reflect`. Desktop clients still send the wire ids.
    for (const id of ["clear-messages", "reflection"]) {
      expect(advertised).toContain(id);
      expect(dispatchedSet.has(id)).toBe(true);
    }
  });
});
