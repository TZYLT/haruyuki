/**
 * G-2 drift gate: the completion table and the parsers must agree in both
 * directions (47-2 §1.2, R-02.2 / R-02.6).
 *
 * - **Table → parser:** every row the popup can offer is accepted by the code
 *   that runs it. A sweep generates the smallest accepted invocation per row
 *   (an enum value, a text filler, or nothing) and feeds it to the real parser.
 * - **Parser → table:** `parseDreamAction` and `parseScheduleInvocation` gate
 *   membership on this table, so a switch word absent from it is unreachable;
 *   the sweep below still pins the accepted spellings so a new branch added
 *   without a row fails here.
 * - **Hubs:** their second level is derived from `HUBS`, so the assertion is
 *   equality of the derived list with the hub itself.
 *
 * The enumerated options are checked against the human syntax that already
 * existed (O-07): the structured list may only contain values the registry/help
 * text already advertised.
 */
import { describe, expect, test } from "bun:test";
import { parseDreamAction } from "@/cli/commands/dream";
import { HUBS } from "@/cli/commands/hubs";
import {
  formatScheduleHelp,
  parseScheduleInvocation,
  SCHEDULE_SUBCOMMANDS,
} from "@/cli/commands/schedule";
import {
  COMMAND_SPECS,
  DREAM_COMMAND_SPECS,
  findSubcommandSpec,
  formatSubcommandUsage,
  getSubcommandSpecs,
  hasSubcommand,
  hubSubcommandSpecs,
  SCHEDULE_COMMAND_SPECS,
  type SubcommandSpecRow,
  TOPIC_COMMAND_SPECS,
  walkSubcommandSpecs,
} from "@/cli/commands/subcommand-specs";
import { handleTopicCommand } from "@/cli/commands/topic";

const HUB_NAMES = [
  "/agent",
  "/session",
  "/memory",
  "/messages",
  "/skill",
  "/context",
  "/config",
  "/maintenance",
];

/** The smallest argument list a row accepts beyond its own path. */
function fillerForCommand(
  command: "dream" | "schedule",
  row: SubcommandSpecRow,
): string[] {
  if (command === "dream") {
    if (row.path[0] === "notes") return ["clear"];
    if (row.spec.name === "note") return ["tidy the projects"];
    if (row.spec.name === "remove") return ["note-1234abcd"];
    // status / on / off / config / run take no further argument.
    return [];
  }
  if (row.spec.name === "autostart") return ["on"];
  // `add` accepts flags; its minimal accepted form is the flagged one, and the
  // missing-flag answer is not an error. A positional word would be one.
  if (row.spec.name === "list" || row.spec.name === "add") return [];
  return ["task-1"];
}

describe("hub rows are derived from HUBS (R-02.6)", () => {
  test("the eight hubs and only the eight hubs have structured rows", () => {
    expect(Object.keys(HUBS)).toHaveLength(8);
    expect(Object.keys(HUBS).sort()).toEqual([...HUB_NAMES].sort());
    for (const name of HUB_NAMES) {
      expect(getSubcommandSpecs(name)?.map((spec) => spec.name)).toEqual(
        HUBS[name]?.subcommands.map((sub) => sub.name),
      );
    }
  });

  test("every hub row keeps its description, syntax hint and options", () => {
    for (const hub of Object.values(HUBS)) {
      const specs = hubSubcommandSpecs(hub.name);
      expect(specs).toBeDefined();
      for (const sub of hub.subcommands) {
        const spec = findSubcommandSpec(specs ?? [], sub.name);
        expect({ hub: hub.name, name: sub.name, spec }).toMatchObject({
          hub: hub.name,
          name: sub.name,
          spec: {
            name: sub.name,
            desc: sub.desc,
            ...(sub.args === undefined ? {} : { args: sub.args }),
            ...(sub.options === undefined ? {} : { options: [...sub.options] }),
          },
        });
      }
    }
  });

  test("only the nine documented hub enums carry options (O-07)", () => {
    const enumerated = Object.values(HUBS).flatMap((hub) =>
      hub.subcommands
        .filter((sub) => sub.options !== undefined)
        .map((sub) => `${hub.name} ${sub.name}`),
    );
    // 《47-1》 counts nine hub option hints: profile, memfs, remote, secret,
    // mods, font-width, console-font, reasoning-tab, system-reminders.
    expect(enumerated.sort()).toEqual(
      [
        "/agent profile",
        "/config console-font",
        "/config font-width",
        "/config mods",
        "/config reasoning-tab",
        "/config secret",
        "/config system-reminders",
        "/memory memfs",
        "/memory remote",
      ].sort(),
    );
    for (const hub of Object.values(HUBS)) {
      for (const sub of hub.subcommands) {
        for (const option of sub.options ?? []) {
          // The structured value must already have been advertised in the
          // human syntax; none may be invented here.
          expect({
            hub: hub.name,
            name: sub.name,
            option,
            advertised: sub.args?.includes(option) ?? false,
          }).toMatchObject({ advertised: true });
        }
      }
    }
  });

  test("a command with no structured rows answers undefined", () => {
    expect(getSubcommandSpecs("/help")).toBeUndefined();
    expect(getSubcommandSpecs("/wander")).toBeUndefined();
    expect(hubSubcommandSpecs("/dream")).toBeUndefined();
  });
});

describe("/dream spec ↔ parse (G-2)", () => {
  test("every row — including the note remove third level — is accepted", () => {
    const rows = walkSubcommandSpecs(DREAM_COMMAND_SPECS);
    expect(rows.map((row) => row.path.join(" "))).toContain("note remove");
    for (const row of rows) {
      const args = [...row.path, ...fillerForCommand("dream", row)];
      const parsed = parseDreamAction(args);
      expect({ args, accepted: "action" in parsed }).toEqual({
        args,
        accepted: true,
      });
    }
  });

  test("the table keeps exactly the seven dream entrances", () => {
    expect(DREAM_COMMAND_SPECS.map((spec) => spec.name)).toEqual([
      "status",
      "run",
      "config",
      "on",
      "off",
      "note",
      "notes",
    ]);
  });

  test("every accepted spelling names a row, and an unknown word names none", () => {
    const accepted: string[][] = [
      ["status"],
      ["on"],
      ["off"],
      ["config"],
      ["run"],
      ["run", "--budget", "50000"],
      ["note", "tidy the projects"],
      ["notes"],
      ["notes", "clear"],
      ["note", "remove", "note-1234abcd"],
    ];
    for (const args of accepted) {
      expect(hasSubcommand(DREAM_COMMAND_SPECS, args[0] ?? "")).toBe(true);
    }
    expect(hasSubcommand(DREAM_COMMAND_SPECS, "wander")).toBe(false);
    expect(parseDreamAction(["wander"])).toMatchObject({
      error: expect.stringContaining("Usage: /dream"),
    });
  });

  test("the usage line is rendered from the table", () => {
    expect(formatSubcommandUsage("/dream", DREAM_COMMAND_SPECS)).toBe(
      [
        "Usage: /dream status",
        "/dream run [--budget <tokens>]",
        "/dream config",
        "/dream on",
        "/dream off",
        "/dream note <text>",
        "/dream note remove <id>",
        "/dream notes [clear]",
      ].join(" | "),
    );
  });
});

describe("/schedule spec ↔ parse (G-2)", () => {
  test("the nine words come from the table, not a second list", () => {
    expect(SCHEDULE_COMMAND_SPECS.map((spec) => spec.name)).toEqual([
      "list",
      "show",
      "add",
      "run",
      "pause",
      "resume",
      "delete",
      "logs",
      "autostart",
    ]);
    expect([...SCHEDULE_SUBCOMMANDS]).toEqual(
      SCHEDULE_COMMAND_SPECS.map((spec) => spec.name),
    );
  });

  test("every row is accepted by the parser", () => {
    for (const row of walkSubcommandSpecs(SCHEDULE_COMMAND_SPECS)) {
      const args = [...row.path, ...fillerForCommand("schedule", row)];
      expect({ args, kind: parseScheduleInvocation(args).kind }).not.toEqual({
        args,
        kind: "error",
      });
    }
  });

  test("every parser branch word is a row, and a typo is refused by name", () => {
    // The parser gates membership on the table before its switch, so a case
    // word missing from the table can never be reached; this sweep proves the
    // reverse — each documented branch still parses.
    const branches: string[][] = [
      ["list"],
      ["show", "t1"],
      ["add"],
      ["run", "t1"],
      ["pause", "t1"],
      ["resume", "t1"],
      ["delete", "t1"],
      ["logs", "t1"],
      ["autostart", "status"],
    ];
    for (const args of branches) {
      expect({
        args,
        known: hasSubcommand(SCHEDULE_COMMAND_SPECS, args[0] ?? ""),
      }).toEqual({ args, known: true });
      expect(parseScheduleInvocation(args).kind).not.toBe("error");
    }
    const typo = parseScheduleInvocation(["nope"]);
    expect(typo.kind).toBe("error");
    if (typo.kind === "error") {
      for (const name of SCHEDULE_SUBCOMMANDS) {
        expect(typo.message).toContain(name);
      }
    }
  });

  test("the autostart enum is offered and documented (O-07)", () => {
    const autostart = findSubcommandSpec(SCHEDULE_COMMAND_SPECS, "autostart");
    expect(autostart?.options).toEqual(["on", "off", "status"]);
    expect(formatScheduleHelp()).toContain("/schedule autostart on|off|status");
  });

  test("the help's subcommand block is rendered from the table", () => {
    const help = formatScheduleHelp();
    for (const spec of SCHEDULE_COMMAND_SPECS) {
      expect(help).toContain(`/schedule ${spec.name}`);
    }
    // The exhaustive flag documentation is prose, not a second row list.
    expect(help).toContain("--catch-up | --no-catch-up");
    expect(help).toContain("read-write (acceptEdits)");
  });
});

describe("/topic spec ↔ dispatch (G-2)", () => {
  test("the three fixed words are rows; a bare title is the fall-through", () => {
    expect(TOPIC_COMMAND_SPECS.map((spec) => spec.name)).toEqual([
      "list",
      "search",
      "show",
    ]);
  });

  test("list, search and show all reach a handler rather than a marker", async () => {
    const { executeCommand } = await import("@/cli/commands/registry");
    const list = await executeCommand("/topic list");
    expect(list.output).toContain("Topic lists require an active agent");
    const search = await executeCommand("/topic search deploy");
    expect(search.output).toContain("Topic search requires an active agent");
    // `show` is intercepted inside the command module and answers before it
    // needs a scope, which is the proof the word was not read as a title.
    const show = await executeCommand("/topic show");
    expect(show.output).toContain("Which topic?");
    // A bare title still records a marker: the fall-through is unchanged.
    const title = await executeCommand("/topic Auth token refresh bug");
    expect(title.output).toContain("Topic markers require an active agent");
  });

  test("the show branch reads its word from the table", async () => {
    expect(findSubcommandSpec(TOPIC_COMMAND_SPECS, "show")).toBeDefined();
    expect(findSubcommandSpec(TOPIC_COMMAND_SPECS, "list")).toBeDefined();
    expect(await handleTopicCommand(["show"])).toContain("Which topic?");
  });
});

describe("the table itself", () => {
  test("every command in COMMAND_SPECS resolves and has unique row names", () => {
    for (const [command, specs] of Object.entries(COMMAND_SPECS)) {
      expect(getSubcommandSpecs(command)).toBe(specs);
      const names = walkSubcommandSpecs(specs).map((row) => row.path.join(" "));
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).not.toContain("  ");
      }
    }
  });

  test("rows carry no empty names, descriptions or option strings", () => {
    for (const specs of Object.values(COMMAND_SPECS)) {
      for (const row of walkSubcommandSpecs(specs)) {
        expect(row.spec.name.length).toBeGreaterThan(0);
        expect(row.spec.desc.length).toBeGreaterThan(0);
        for (const option of row.spec.options ?? []) {
          expect(option.length).toBeGreaterThan(0);
          expect(option).not.toContain(" ");
        }
      }
    }
  });
});
