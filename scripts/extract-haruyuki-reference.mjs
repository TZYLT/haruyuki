#!/usr/bin/env bun

/**
 * Derives the command surface of this build from its own command tree.
 *
 * Why this exists: the offline reference bundled with the `haruyuki-guide`
 * skill must be traceable to a source in *this* repository, and its structure
 * must come from the implementation rather than from anyone's prose. This
 * script is that traceable source. It reads:
 *
 *   1. `src/cli/subcommands/router.ts` — the subcommand tree (canonical names,
 *      aliases, and which module serves each one);
 *   2. each serving module — the `--help` text and the source line it lives on;
 *   3. `src/cli/commands/registry.ts` — the slash-command registry.
 *
 * The `--help` half is captured by *running* the real subcommand in this
 * process, so the printed text is the same bytes a user sees, interpolated
 * constants included.
 *
 * Output is a deterministic skeleton: commands, flags, and source anchors, with
 * no behavior prose. Hand-written behavior lives in the documents beside the
 * generated one.
 *
 * Usage (bun only — it imports this repository's TypeScript):
 *
 *   bun scripts/extract-haruyuki-reference.mjs --write    # regenerate
 *   bun scripts/extract-haruyuki-reference.mjs            # verify (exit 1 on drift)
 *   bun scripts/extract-haruyuki-reference.mjs --stdout   # print, write nothing
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { runSubcommand } from "@/cli/subcommands/router";

const REPOSITORY_ROOT = process.cwd();
const ROUTER_PATH = "src/cli/subcommands/router.ts";
const REGISTRY_PATH = "src/cli/commands/registry.ts";
const GENERATOR_PATH = "scripts/extract-haruyuki-reference.mjs";
const OUTPUT_PATH =
  "src/skills/builtin/haruyuki-guide/docs/reference-index.md";

/** Commands with no usage block: `version` prints a number, and the internal
 * channel-gateway process does not accept `--help` at all. */
const NO_HELP_TEXT = new Map([
  ["version", "Prints this build's version. Takes no arguments."],
  [
    "channel-gateway",
    "Internal stdin/stdout channel process used with `--app-server-url`; it is not a user command and takes no `--help`.",
  ],
]);

class ExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtractionError";
  }
}

function parseArguments(argv) {
  const options = { mode: "check", out: OUTPUT_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--write") options.mode = "write";
    else if (value === "--check") options.mode = "check";
    else if (value === "--stdout") options.mode = "stdout";
    else if (value === "--out") {
      const target = argv[++index];
      if (!target) throw new ExtractionError("--out needs a path.");
      options.out = target;
    } else if (value === "--help" || value === "-h") options.mode = "help";
    else throw new ExtractionError(`Unknown argument: ${value}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Derive this build's command surface from its own command tree.",
      "",
      "Usage: bun scripts/extract-haruyuki-reference.mjs [option]",
      "",
      "  --write   Regenerate the reference index in place",
      "  --check   Verify the committed index still matches the source (default)",
      "  --stdout  Print the index without writing it",
      "  --out <path>  Write somewhere other than the default location",
      "",
    ].join("\n"),
  );
}

function repoPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function readRepositoryFile(relativePath) {
  try {
    return await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ExtractionError(
        `Missing ${relativePath}. Run this script from the repository root.`,
      );
    }
    throw error;
  }
}

/**
 * Read a file that a symbol resolution *might* point at.
 *
 * Import specifiers like `@/backend` name a directory entry point rather than a
 * file, and those are irrelevant to a help anchor, so a miss is not an error.
 */
async function tryReadRepositoryFile(relativePath) {
  try {
    return await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8");
  } catch {
    return null;
  }
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

// --- the subcommand tree ----------------------------------------------------

/**
 * Read the `switch` in `runSubcommand`.
 *
 * Consecutive `case "a": case "b":` labels that share one `return` are one
 * command with aliases, which is exactly how the router expresses them.
 */
/** `./x` and `@/x` as they resolve from the router module. */
function resolveRouterModule(specifier) {
  const base = specifier.startsWith("@/")
    ? path.posix.join("src", specifier.slice(2))
    : path.posix.join(path.posix.dirname(ROUTER_PATH), specifier);
  return `${base}.ts`;
}

function parseSubcommandCases(source) {
  const lines = source.split(/\r?\n/);
  const cases = [];
  let pending = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const label = /^\s*case "([^"]+)":\s*(?:\/\/\s*(.*?))?\s*$/.exec(line);
    if (label) {
      pending.push({ name: label[1], note: label[2] ?? "" });
      continue;
    }

    if (/^\s*default:/.test(line)) {
      pending = [];
      continue;
    }

    // Two shapes exist: a bare call to a helper defined in this file, and an
    // on-demand import — `return (await import("./x")).runXSubcommand(rest);` —
    // which is what every subcommand now uses so the router stays import-free
    // (C-24: `schedule tick` must not drag the backend graph in).
    const runner =
      /return\s+(?:\(\s*await\s+import\("((?:\.\/|@\/)[^"]+)"\)\s*\)\s*\.)?(run[A-Za-z]+Subcommand)\s*\(/.exec(
        line,
      );
    if (runner && pending.length > 0) {
      cases.push({
        command: pending[0].name,
        aliases: pending.slice(1).map((entry) => entry.name),
        notes: pending
          .map((entry) => entry.note)
          .filter((note) => note.length > 0),
        runner: runner[2],
        module: runner[1] ? resolveRouterModule(runner[1]) : null,
        routerLine: index + 1,
      });
      pending = [];
      continue;
    }

    if (/return null;/.test(line)) pending = [];
  }

  if (cases.length === 0) {
    throw new ExtractionError(
      `No subcommand cases found in ${ROUTER_PATH}. Has the router been rewritten?`,
    );
  }
  return cases;
}

/**
 * Map every imported symbol in `source` to the module that defines it.
 *
 * Only the two specifier shapes this repository uses are resolved: `./x`
 * relative to the importing file, and the `@/` alias anchored at `src/`.
 */
function parseImports(source, importingPath) {
  const imports = new Map();
  const pattern =
    /import\s*\{([^}]*)\}\s*from\s*"((?:\.\/|@\/)[^"]+)";/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    const base = specifier.startsWith("@/")
      ? path.posix.join("src", specifier.slice(2))
      : path.posix.join(path.posix.dirname(importingPath), specifier);
    for (const rawName of match[1].split(",")) {
      const name = rawName.trim().replace(/^type\s+/, "");
      if (!name) continue;
      imports.set(name, `${base}.ts`);
    }
  }
  return imports;
}

/**
 * The top-level `function`/`const` a source index sits inside.
 *
 * Usage text is written either inside the printer itself (`printUsage`) or in
 * a formatter the printer calls (`formatUsage`), so the enclosing definition is
 * what a reader should be pointed at when there is no `console.log` to cite.
 */
function enclosingDefinition(source, index) {
  const pattern = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+))/gm;
  let last = null;
  for (const match of source.slice(0, index).matchAll(pattern)) {
    last = { name: match[1] ?? match[2], index: match.index };
  }
  return last;
}

function definitionIndex(source, name) {
  const pattern = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*[:=])`,
    "m",
  );
  const match = pattern.exec(source);
  return match ? match.index : null;
}

/** Read the string/template literal that starts at `quoteIndex`. */
function readStringLiteral(source, quoteIndex) {
  const quote = source[quoteIndex];
  let index = quoteIndex + 1;
  let content = "";

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      content += char + (source[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (char === quote) return { content, endIndex: index };
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      let depth = 0;
      let cursor = index + 1;
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      index = cursor + 1;
      continue;
    }
    content += char;
    index += 1;
  }

  return null;
}

/**
 * Where a module's `Usage:` literal lives, and which line to cite for it.
 *
 * A `console.log(...)` that prints the literal is the best citation; otherwise
 * the definition that owns it is. Single-line `"Usage: <command> ..."` strings
 * are rejected: those are error hints, not the help block.
 */
function locateUsage(source) {
  for (const match of source.matchAll(/(["'`])\s*Usage:/g)) {
    const literal = readStringLiteral(source, match.index);
    if (literal === null) continue;

    const content = literal.content;
    const after = content.slice(content.indexOf("Usage:") + "Usage:".length);
    const isHeaderOnly = content.trim() === "Usage:";
    if (!isHeaderOnly && !/\\n|\r|\n/.test(after)) continue;

    const windowStart = Math.max(0, match.index - 80);
    const logIndex = source
      .slice(windowStart, match.index)
      .lastIndexOf("console.log(");
    if (logIndex >= 0) {
      return { line: lineNumberAt(source, windowStart + logIndex), symbol: "printUsage" };
    }

    const owner = enclosingDefinition(source, match.index);
    return {
      line: owner
        ? lineNumberAt(source, owner.index)
        : lineNumberAt(source, match.index),
      symbol: owner ? owner.name : null,
    };
  }

  return null;
}

/** Locate the line that prints a module's `--help` text. */
async function resolveHelpAnchor(modulePath, cache) {
  const read = async (file) => {
    if (cache.has(file)) return cache.get(file);
    const source = await tryReadRepositoryFile(file);
    cache.set(file, source);
    return source;
  };

  const source = await read(modulePath);
  if (source === null) return { file: modulePath, line: null, symbol: null };

  // `server` and `mcp` delegate the whole block to a printer defined in another
  // module, so follow the no-argument calls this module actually makes first —
  // a module can carry one-line "Usage: <command> ..." error hints that are not
  // the help text.
  const imports = parseImports(source, modulePath);
  for (const match of source.matchAll(/\b(\w+)\s*\(/g)) {
    const name = match[1];
    const owner = imports.get(name);
    if (!owner) continue;
    const ownerSource = await read(owner);
    if (ownerSource === null) continue;
    const start = definitionIndex(ownerSource, name);
    if (start === null) continue;
    const rest = ownerSource.slice(start);
    const next = /^(?:export\s+)?(?:async\s+)?(?:function|const)\s/m.exec(
      rest.slice(1),
    );
    const body = next ? rest.slice(0, next.index + 1) : rest;
    const usage = locateUsage(body);
    if (!usage) continue;
    return {
      file: owner,
      line: ownerSource.slice(0, start).split(/\r?\n/).length - 1 + usage.line,
      symbol: name,
    };
  }

  const local = locateUsage(source);
  if (local) return { file: modulePath, ...local };

  return { file: modulePath, line: null, symbol: null };
}

function formatValue(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Run `<command> --help` in this process and keep everything it prints.
 *
 * Subcommands print through `console.log`, and the MCP subcommand writes to
 * `process.stdout` directly, so both channels are captured. A deprecated
 * command warns on stderr before printing help, hence stderr as well.
 */
async function captureHelp(command) {
  const captured = [];
  const sink = (...args) => captured.push(args.map(formatValue).join(" "));
  const captureWrite =
    (stream) =>
    (chunk, encoding, callback) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : new TextDecoder().decode(chunk);
      captured.push(text.replace(/\r?\n$/, ""));
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    };

  const original = {
    log: console.log,
    error: console.error,
    out: process.stdout.write,
    err: process.stderr.write,
  };
  let exitCode = null;
  let failure = null;

  console.log = sink;
  console.error = sink;
  process.stdout.write = captureWrite(process.stdout);
  process.stderr.write = captureWrite(process.stderr);
  try {
    exitCode = await runSubcommand([command, "--help"]);
  } catch (error) {
    failure = formatValue(error);
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }

  return { exitCode, failure, text: captured.join("\n").trimEnd() };
}

/**
 * Flags advertised by a usage block, in the order the help lists them.
 *
 * Option rows are indented; `Usage:` lines are scanned too because some
 * commands (steps) write the whole synopsis on one line.
 */
function flagsInHelp(text) {
  const flags = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*(?:-|Usage:)/.test(line)) continue;
    for (const token of line.matchAll(/--[A-Za-z0-9][A-Za-z0-9-]*/g)) {
      if (seen.has(token[0])) continue;
      seen.add(token[0]);
      flags.push(token[0]);
    }
  }
  return flags;
}

// --- slash commands ---------------------------------------------------------

function parseSlashCommands(source, runtimeCommands) {
  const pattern = /^ {2}"(\/[a-z0-9-]+)": \{\n([\s\S]*?)^ {2}\},$/gm;
  const commands = [];
  for (const match of source.matchAll(pattern)) {
    const body = match[2];
    // `internal` entries are the targets a hub rewrites to (e.g. `/memfs`
    // behind `/memory memfs`). They are not a surface: the hub table below is
    // where they are described, and a user who types one is answered with the
    // move. The flag is read from the loaded registry because it is applied by
    // a rule at the end of that file, not written into each entry.
    if (runtimeCommands?.[match[1]]?.internal) continue;
    const args = /args:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    const description = /desc:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    commands.push({
      name: match[1],
      args: args ? args[1] : null,
      description: description ? description[1] : "",
      hidden: /\bhidden:\s*true\b/.test(body),
      line: lineNumberAt(source, match.index),
    });
  }
  if (commands.length === 0) {
    throw new ExtractionError(
      `No slash commands found in ${REGISTRY_PATH}. Has the registry been rewritten?`,
    );
  }
  return commands;
}

/**
 * The hub table, flattened to one row per invocation.
 *
 * Read from `src/cli/commands/hubs.ts` rather than parsed: the table is the
 * source of truth, so the shipped reference cannot describe a subcommand the
 * build does not have.
 */
async function collectHubSubcommands() {
  const { HUBS } = await import("@/cli/commands/hubs");
  const rows = [];
  for (const hub of Object.values(HUBS)) {
    if (hub.bare) {
      rows.push({
        command: hub.name,
        args: null,
        description: hub.bare.desc,
      });
    }
    for (const sub of hub.subcommands) {
      rows.push({
        command: `${hub.name} ${sub.name}`,
        args: sub.args ?? null,
        description: sub.desc,
      });
    }
  }
  return rows;
}

// --- rendering --------------------------------------------------------------

function escapeCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function codeList(values) {
  if (values.length === 0) return "—";
  return values.map((value) => `\`${value}\``).join(", ");
}

function anchorText(anchor) {
  return anchor.line === null
    ? `\`${repoPath(anchor.file)}\``
    : `\`${repoPath(anchor.file)}:${anchor.line}\``;
}

function renderSubcommand(entry) {
  const lines = [`### \`haruyuki ${entry.command}\``, ""];

  const facts = [];
  if (entry.aliases.length > 0) {
    facts.push(`- Aliases: ${entry.aliases.map((a) => `\`${a}\``).join(", ")}`);
  }
  if (entry.notes.length > 0) {
    facts.push(`- Router note: ${entry.notes.join("; ")}`);
  }
  if (entry.deprecated) {
    facts.push("- Deprecated: the router prints a warning and delegates.");
  }
  facts.push(`- Help source: ${anchorText(entry.anchor)}`);
  lines.push(...facts, "");

  if (entry.help.length > 0) {
    lines.push("```text", entry.help, "```", "");
  } else if (entry.failure) {
    lines.push(
      `Collecting \`--help\` failed: ${entry.failure}`,
      "",
    );
  } else {
    lines.push("(This command prints no usage block.)", "");
  }

  return lines.join("\n").trimEnd();
}

function renderIndex(document) {
  const { subcommands, slashCommands, hubSubcommands, generatedFrom } =
    document;
  const parts = [];

  parts.push(
    [
      "---",
      "title: Reference index (generated)",
      "description: Command surface extracted from this build's own command tree. Regenerate with the extractor script; do not edit by hand.",
      "applies_to:",
      "  backends: [local]",
      "  interfaces: [cli, desktop, sdk]",
      "---",
      "",
      "# Reference index (generated)",
      "",
      `Generated by \`${GENERATOR_PATH}\` from ${generatedFrom}.`,
      "Do not edit this document by hand: it is a projection of the source, and the",
      "next regeneration overwrites it. Behavior descriptions live in the",
      "hand-written documents beside this one.",
      "",
      "Every row cites the file it came from. When a row and the source disagree,",
      "the source wins.",
      "",
    ].join("\n"),
  );

  parts.push(
    [
      "## How to regenerate",
      "",
      "```bash",
      `bun ${GENERATOR_PATH} --write   # rewrite this document`,
      `bun ${GENERATOR_PATH}           # verify it still matches the source`,
      "```",
      "",
      "The usage blocks below are not copied from anywhere: they are captured by",
      "running each subcommand's own `--help` inside this repository.",
      "",
    ].join("\n"),
  );

  const subcommandTable = [
    "| Command | Aliases | Flags | Help source |",
    "| --- | --- | --- | --- |",
    ...subcommands.map((entry) =>
      [
        `\`haruyuki ${entry.command}\``,
        entry.aliases.length > 0
          ? entry.aliases.map((alias) => `\`${alias}\``).join(", ")
          : "—",
        codeList(entry.flags),
        anchorText(entry.anchor),
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
  ].join("\n");

  parts.push(["## Subcommands", "", subcommandTable, ""].join("\n"));
  parts.push(
    subcommands
      .map((entry) => renderSubcommand(entry))
      .join("\n\n")
      .concat("\n"),
  );

  const slashTable = [
    "| Slash command | Arguments | What it does | Source |",
    "| --- | --- | --- | --- |",
    ...slashCommands.map((entry) =>
      [
        `\`${entry.name}\``,
        entry.args ? `\`${entry.args}\`` : "—",
        entry.hidden ? `${entry.description} (hidden)` : entry.description,
        `\`${REGISTRY_PATH}:${entry.line}\``,
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
  ].join("\n");

  const hubTable = [
    "| Invocation | Arguments | What it does |",
    "| --- | --- | --- |",
    ...hubSubcommands.map((entry) =>
      [
        `\`${entry.command}\``,
        entry.args ? `\`${entry.args}\`` : "—",
        entry.description,
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
  ].join("\n");

  parts.push(
    [
      "## Slash commands",
      "",
      "Registered in `src/cli/commands/registry.ts`. Slash commands run inside the",
      "terminal UI; the `Arguments` column is the syntax hint the registry carries.",
      "Commands marked hidden still work but are kept out of autocomplete.",
      "",
      slashTable,
      "",
    ].join("\n"),
  );

  parts.push(
    [
      "## Hub subcommands",
      "",
      "Derived from `src/cli/commands/hubs.ts`. A hub owns the subcommands below;",
      "typing a former top-level name is answered with the hub form that replaced",
      "it, so these are the only spellings that run.",
      "",
      hubTable,
      "",
    ].join("\n"),
  );

  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// --- assembly ---------------------------------------------------------------

async function collectSubcommands(cache) {
  const routerSource = await readRepositoryFile(ROUTER_PATH);
  cache.set(ROUTER_PATH, routerSource);
  const cases = parseSubcommandCases(routerSource);
  const entries = [];

  for (const entry of cases) {
    const modulePath = entry.module ?? ROUTER_PATH;
    const anchor =
      modulePath === ROUTER_PATH && definitionIndex(routerSource, entry.runner) !== null
        ? {
            file: ROUTER_PATH,
            line: lineNumberAt(
              routerSource,
              definitionIndex(routerSource, entry.runner),
            ),
            symbol: entry.runner,
          }
        : await resolveHelpAnchor(modulePath, cache);
    const inline = NO_HELP_TEXT.get(entry.command);
    const help = inline
      ? { exitCode: 0, failure: null, text: inline }
      : await captureHelp(entry.command);

    entries.push({
      command: entry.command,
      aliases: entry.aliases,
      notes: entry.notes,
      deprecated: /deprecated/i.test(help.text),
      module: modulePath,
      anchor,
      help: help.text,
      failure: help.failure,
      flags: flagsInHelp(help.text),
    });

    if (help.failure) {
      process.stderr.write(
        `warning: ${entry.command} --help threw: ${help.failure}\n`,
      );
    }
    if (help.exitCode !== 0) {
      process.stderr.write(
        `warning: ${entry.command} --help exited ${help.exitCode}\n`,
      );
    }
  }

  return entries;
}

async function buildDocument() {
  const cache = new Map();
  const [subcommands, registrySource, registry] = await Promise.all([
    collectSubcommands(cache),
    readRepositoryFile(REGISTRY_PATH),
    import("@/cli/commands/registry"),
  ]);
  const document = {
    subcommands,
    slashCommands: parseSlashCommands(registrySource, registry.commands),
    hubSubcommands: await collectHubSubcommands(),
    generatedFrom: `\`${ROUTER_PATH}\` and \`${REGISTRY_PATH}\``,
  };

  return { document, markdown: renderIndex(document) };
}

/**
 * Run the extraction against a throwaway harness home.
 *
 * Some usage blocks are built from stored state — the `connect` provider list
 * comes from the local provider store — so without isolation the document would
 * differ per machine and would publish whoever generated it. An empty home
 * makes every captured block a function of the source alone.
 */
async function withIsolatedHarnessHome(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "haruyuki-reference-"));
  const overrides = {
    HARUYUKI_HOME: directory,
    LETTA_LOCAL_BACKEND_DIR: path.join(directory, "lc-local-backend"),
  };
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "help") {
    printHelp();
    return 0;
  }

  const { markdown } = await withIsolatedHarnessHome(buildDocument);

  if (options.mode === "stdout") {
    process.stdout.write(markdown);
    return 0;
  }

  const absoluteOut = path.resolve(REPOSITORY_ROOT, options.out);

  if (options.mode === "write") {
    await mkdir(path.dirname(absoluteOut), { recursive: true });
    await writeFile(absoluteOut, markdown, "utf8");
    process.stdout.write(`wrote ${repoPath(path.relative(REPOSITORY_ROOT, absoluteOut))}\n`);
    return 0;
  }

  let committed;
  try {
    committed = await readFile(absoluteOut, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      process.stderr.write(
        `${options.out} does not exist. Run with --write to generate it.\n`,
      );
      return 1;
    }
    throw error;
  }

  if (committed === markdown) {
    process.stdout.write(`${options.out} matches the command tree.\n`);
    return 0;
  }

  const committedLines = committed.split(/\r?\n/);
  const generatedLines = markdown.split(/\r?\n/);
  const limit = Math.max(committedLines.length, generatedLines.length);
  let firstDifference = -1;
  for (let index = 0; index < limit; index += 1) {
    if (committedLines[index] !== generatedLines[index]) {
      firstDifference = index;
      break;
    }
  }

  process.stderr.write(
    [
      `${options.out} is out of date with the command tree.`,
      firstDifference >= 0 ? `First difference at line ${firstDifference + 1}:` : "",
      firstDifference >= 0 ? `  committed: ${committedLines[firstDifference] ?? "(end of file)"}` : "",
      firstDifference >= 0 ? `  generated: ${generatedLines[firstDifference] ?? "(end of file)"}` : "",
      `Run: bun ${GENERATOR_PATH} --write`,
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ExtractionError) {
      process.stderr.write(`Error: ${error.message}\n`);
    } else {
      process.stderr.write(`Error: ${error?.stack ?? String(error)}\n`);
    }
    process.exitCode = 1;
  });

export {
  parseSlashCommands,
  parseSubcommandCases,
  renderIndex,
  flagsInHelp,
};
