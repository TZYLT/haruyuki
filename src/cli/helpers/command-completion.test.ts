/**
 * The completion resolver W-07's popup consumes (T-02, R-02.3 / R-02.4).
 *
 * The rules pinned here are the ones that decide what the user sees:
 *
 * - level 1 keeps the historical `includes` match;
 * - levels 2/3 match by **prefix**, and free-text positions offer nothing;
 * - the resolved level is what the popup's rows are drawn from, including the
 *   third level (`/dream note remove`) and the enumerated arguments (O-07);
 * - Q-46's Enter rule is a comparison between `applyCandidate` and the input,
 *   so "already typed" is testable without a terminal.
 */
import { describe, expect, test } from "bun:test";
import {
  applyCandidate,
  type CompletionCandidate,
  type CompletionCommand,
  fillCompletion,
  isCandidateAlreadyTyped,
  resolveCommandCompletion,
  tokenizeCommandInput,
} from "@/cli/helpers/command-completion";

/** The level-1 list the popup's merged sources hand in, in popup order. */
const COMMANDS: CompletionCommand[] = [
  { cmd: "/help", desc: "Show help", order: 1 },
  { cmd: "/agent", desc: "Agent hub", order: 10 },
  { cmd: "/dream", desc: "Dream", order: 49 },
  { cmd: "/schedule", desc: "Scheduled tasks", order: 36.2 },
  { cmd: "/stream", desc: "Toggle streaming" },
  { cmd: "/topic", desc: "Topic markers" },
];

function values(candidates: readonly CompletionCandidate[]): string[] {
  return candidates.map((candidate) => candidate.value);
}

describe("tokenizeCommandInput", () => {
  test("splits the command token, settled words and the partial word", () => {
    expect(tokenizeCommandInput("/dream")).toMatchObject({
      command: "/dream",
      words: [],
      query: "dream",
      queryStart: 1,
      inCommand: true,
    });
    expect(tokenizeCommandInput("/dream ")).toMatchObject({
      command: "/dream",
      words: [],
      query: "",
      inCommand: false,
    });
    expect(tokenizeCommandInput("/dream note ")).toMatchObject({
      command: "/dream",
      words: ["note"],
      query: "",
    });
    const partial = tokenizeCommandInput("/dream note rem");
    expect(partial.words).toEqual(["note"]);
    expect(partial.query).toBe("rem");
    expect(partial.queryStart).toBe("/dream note rem".length - 3);
  });

  test("collapses repeated separators and keeps the cursor's view", () => {
    const spaced = tokenizeCommandInput("/dream   note  ");
    expect(spaced.words).toEqual(["note"]);
    expect(spaced.query).toBe("");

    const middle = tokenizeCommandInput("/dream st extra", "/dream st".length);
    expect(middle.words).toEqual([]);
    expect(middle.query).toBe("st");
    expect(middle.queryStart).toBe("/dream ".length);
  });

  test("anything that is not a slash command has no command", () => {
    expect(tokenizeCommandInput("hello").command).toBeNull();
    expect(tokenizeCommandInput("@src/file.ts").command).toBeNull();
  });
});

describe("level 1 keeps includes matching (R-02.4)", () => {
  test("a fragment inside the name still matches", () => {
    const state = resolveCommandCompletion("/rea", COMMANDS);
    expect(state.level).toBe(1);
    // `dream` has no prefix match for `rea`, so only `includes` can find it.
    expect(values(state.candidates)).toEqual(["/dream", "/stream"]);
    expect(state.candidates[0]?.kind).toBe("command");
  });

  test("/ lists every offered command in order", () => {
    const state = resolveCommandCompletion("/", COMMANDS);
    expect(state.active).toBe(true);
    expect(values(state.candidates)).toEqual(COMMANDS.map((cmd) => cmd.cmd));
  });

  test("no command match means no popup", () => {
    const state = resolveCommandCompletion("/zzz", COMMANDS);
    expect(state.candidates).toEqual([]);
    expect(state.active).toBe(false);
  });
});

describe("levels 2 and 3 match by prefix (R-02.3)", () => {
  test("/dream + space offers the seven rows from the spec table", () => {
    const state = resolveCommandCompletion("/dream ", COMMANDS);
    expect(state.level).toBe(2);
    expect(values(state.candidates)).toEqual([
      "status",
      "run",
      "config",
      "on",
      "off",
      "note",
      "notes",
    ]);
  });

  test("prefix, not includes: a word fragment in the middle does not match", () => {
    // `config` contains `o`; prefix matching must not offer it for `o`.
    expect(
      values(resolveCommandCompletion("/dream o", COMMANDS).candidates),
    ).toEqual(["on", "off"]);
    // `ream` is inside `dream` but not a prefix of any row.
    expect(resolveCommandCompletion("/dream ream", COMMANDS).active).toBe(
      false,
    );
  });

  test("the third level resolves through the child rows", () => {
    const open = resolveCommandCompletion("/dream note ", COMMANDS);
    expect(open.level).toBe(3);
    expect(values(open.candidates)).toEqual(["remove"]);
    expect(
      values(resolveCommandCompletion("/dream note r", COMMANDS).candidates),
    ).toEqual(["remove"]);
    // A note body is free text: once the word is not `remove`, nothing to offer.
    expect(resolveCommandCompletion("/dream note tidy", COMMANDS).active).toBe(
      false,
    );
  });

  test("a leaf with free text opens no popup (R-02.5)", () => {
    expect(
      resolveCommandCompletion("/schedule show abc", COMMANDS).active,
    ).toBe(false);
    expect(resolveCommandCompletion("/topic show 1", COMMANDS).active).toBe(
      false,
    );
    expect(resolveCommandCompletion("/dream run ", COMMANDS).active).toBe(
      false,
    );
  });

  test("an unknown word on a known path stops the resolution", () => {
    const state = resolveCommandCompletion("/dream wander ", COMMANDS);
    expect(state.candidates).toEqual([]);
    expect(state.active).toBe(false);
  });

  test("an unstructured command has no second level", () => {
    expect(resolveCommandCompletion("/help ", COMMANDS)).toMatchObject({
      level: 2,
      candidates: [],
      active: false,
    });
    expect(resolveCommandCompletion("/custom ", COMMANDS).active).toBe(false);
  });
});

describe("enumerated arguments are candidates (O-07)", () => {
  test("schedule autostart offers on/off/status", () => {
    const state = resolveCommandCompletion("/schedule autostart ", COMMANDS);
    expect(state.level).toBe(3);
    expect(values(state.candidates)).toEqual(["on", "off", "status"]);
    expect(state.candidates[0]?.kind).toBe("option");
    expect(
      values(
        resolveCommandCompletion("/schedule autostart o", COMMANDS).candidates,
      ),
    ).toEqual(["on", "off"]);
  });

  test("the hub enums resolve through the derived hub rows", () => {
    expect(
      values(resolveCommandCompletion("/agent profile ", COMMANDS).candidates),
    ).toEqual(["save", "load", "delete", "usage"]);
    expect(
      values(
        resolveCommandCompletion("/config font-width ", COMMANDS).candidates,
      ),
    ).toEqual(["auto", "narrow", "wide"]);
    expect(
      values(
        resolveCommandCompletion("/config console-font ", COMMANDS).candidates,
      ),
    ).toEqual(["auto", "off"]);
  });

  test("topic's three words are offered, and prefix-filtered", () => {
    expect(
      values(resolveCommandCompletion("/topic ", COMMANDS).candidates),
    ).toEqual(["list", "search", "show"]);
    expect(
      values(resolveCommandCompletion("/topic s", COMMANDS).candidates),
    ).toEqual(["search", "show"]);
  });
});

describe("candidate display metadata (R-02.5)", () => {
  test("subcommand candidates carry their argument hint", () => {
    const state = resolveCommandCompletion("/dream ", COMMANDS);
    const run = state.candidates.find((candidate) => candidate.value === "run");
    expect(run?.args).toBe("[--budget <tokens>]");
    expect(run?.kind).toBe("subcommand");
  });

  test("a level-1 candidate carries the command's description", () => {
    const dream = resolveCommandCompletion("/dre", COMMANDS).candidates.find(
      (candidate) => candidate.value === "/dream",
    );
    expect(dream?.desc).toBe("Dream");
    expect(dream?.label).toBe("/dream");
  });
});

describe("fill and the Q-46 enter fall-through", () => {
  test("filling a partial word adds the separator", () => {
    const state = resolveCommandCompletion("/dream statu", COMMANDS);
    const status = state.candidates[0];
    expect(status).toBeDefined();
    if (!status) return;
    expect(applyCandidate("/dream statu", state, status)).toBe("/dream status");
    expect(fillCompletion("/dream statu", state, status)).toBe(
      "/dream status ",
    );
  });

  test("a word already typed compares equal, so Enter may run", () => {
    const state = resolveCommandCompletion("/dream status", COMMANDS);
    const status = state.candidates[0];
    expect(status).toBeDefined();
    if (!status) return;
    expect(isCandidateAlreadyTyped("/dream status", state, status)).toBe(true);
    expect(applyCandidate("/dream status", state, status)).toBe(
      "/dream status",
    );
  });

  test("a partially typed command name fills, a complete one runs", () => {
    const partial = resolveCommandCompletion("/drea", COMMANDS);
    const dream = partial.candidates.find(
      (candidate) => candidate.value === "/dream",
    );
    expect(dream).toBeDefined();
    if (!dream) return;
    expect(isCandidateAlreadyTyped("/drea", partial, dream)).toBe(false);
    expect(fillCompletion("/drea", partial, dream)).toBe("/dream ");

    const complete = resolveCommandCompletion("/dream", COMMANDS);
    const exact = complete.candidates.find(
      (candidate) => candidate.value === "/dream",
    );
    expect(exact).toBeDefined();
    if (!exact) return;
    expect(isCandidateAlreadyTyped("/dream", complete, exact)).toBe(true);
  });

  test("filling the next level keeps the following text intact", () => {
    const cursor = "/dream st".length;
    const state = resolveCommandCompletion("/dream st extra", COMMANDS, cursor);
    const status = state.candidates[0];
    expect(status).toBeDefined();
    if (!status) return;
    expect(fillCompletion("/dream st extra", state, status)).toBe(
      "/dream status extra",
    );
  });

  test("filling a subcommand opens the next level", () => {
    const state = resolveCommandCompletion("/dream no", COMMANDS);
    const note = state.candidates.find(
      (candidate) => candidate.value === "note",
    );
    expect(note).toBeDefined();
    if (!note) return;
    const filled = fillCompletion("/dream no", state, note);
    expect(filled).toBe("/dream note ");
    expect(
      values(resolveCommandCompletion(filled, COMMANDS).candidates),
    ).toEqual(["remove"]);
  });
});
