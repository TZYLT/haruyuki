/**
 * CLI shell for `haruyuki export` / `haruyuki import`.
 *
 * This is the only snapshot module the router imports: argument parsing, the
 * confirmation words (`export` / `overwrite`), `--json` selection, human output
 * and the process exit code all live behind these two entry points.
 *
 * Both commands read local data roots, so the router also lists them in
 * `subcommandNeedsEarlyBackendMode`.
 *
 * The pipelines themselves are injected (`SnapshotCliPipeline`) rather than
 * imported at call time, which is what makes the shell testable while M5/M6 are
 * still throwing placeholders: the default loader only runs when the real
 * command is invoked, and a test can pass a fake that returns any report code.
 *
 * Confirmation order matters and differs between the two commands:
 *   - export has nothing to inspect first, so the word is asked up front;
 *   - import validates the package first and asks for `overwrite` after, via the
 *     `RequireConfirm` callback it hands to the pipeline (§5.8 step 6), so a
 *     broken package never makes the user type a word for nothing.
 *
 * There is no Ink here and no timer: stage lines come from the pipeline's
 * progress callback (§5.13.4) and the report is rendered by `report.ts`.
 */

import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type * as ExportPipeline from "./export";
import type * as ImportPipeline from "./import";
import { exitCodeFor, formatBytes, toHuman, toJson } from "./report";
import {
  type SnapshotCliDeps,
  type SnapshotCommand,
  SnapshotError,
  type SnapshotErrorCode,
  type SnapshotProgress,
  type SnapshotProgressHandler,
  type SnapshotReport,
} from "./types";

/**
 * The two pipeline entry points the shell drives.
 *
 * Tests inject fakes here; the default implementation is loaded lazily so a
 * command that only prints `--help` never touches the archive or import code.
 */
export interface SnapshotCliPipeline {
  runExport: typeof ExportPipeline.runExport;
  runImport: typeof ImportPipeline.runImport;
}

/** Streams for the confirmation word; injectable so tests need no stdin. */
export interface SnapshotConfirmIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Whether the output should be treated as a terminal; defaults to stdin's TTY. */
  terminal?: boolean;
}

const EXPORT_OPTIONS = {
  help: { type: "boolean", short: "h" },
  out: { type: "string" },
  "with-project": { type: "string" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  yes: { type: "boolean" },
} as const;

const IMPORT_OPTIONS = {
  help: { type: "boolean", short: "h" },
  from: { type: "string" },
  "with-project": { type: "string" },
  verify: { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  yes: { type: "boolean" },
} as const;

const WITH_PROJECT_FLAG = "--with-project";

/**
 * Fixed §5.4.6 warning, printed before an export asks for its confirmation
 * word. It is repeated in `--help` and in the shipped command manual.
 */
const EXPORT_WARNING = [
  "Sensitive data:",
  "  The package contains PLAINTEXT credentials (settings tokens, per-agent",
  "  secrets, channel credentials) and private conversations, reflection",
  "  transcripts and memory. Treat it as a key to this machine: keep it private,",
  "  and delete it when you are done.",
  "  Do not commit a .hryk package to git. This tool warns only; it never edits",
  "  your .gitignore.",
  "",
  "Consistency:",
  "  Make sure no other haruyuki window is running while you export; otherwise",
  "  the package may be inconsistent (messages, memory commits, usage and cron",
  "  can change underneath it).",
].join("\n");

/** §5.16.2 completion reminders, printed after a successful, real import. */
const IMPORT_REMINDERS = [
  "",
  "Next steps:",
  "  - Restart haruyuki: this command only writes files and exits, so the",
  "    imported data is read on the next start.",
  "  - Compiled prompt snapshots and recall indexes are not kept in the package;",
  "    they are rebuilt on first use, so the first conversation may be slower.",
  "  - The package contains plaintext credentials: keep it safe or delete it, and",
  "    do not commit it to git.",
].join("\n");

export function formatExportUsage(): string {
  return `
Usage:
  haruyuki export [--out <package>] [--with-project[=<dir>]] [--dry-run]
                  [--json] [--verbose] [--yes]

Write a complete snapshot of this machine's Haruyuki data into one .hryk file:
a gzipped tar holding a manifest, the managed app-home and local-backend trees,
and a secrets.json. The package is written atomically — a .partial file is
renamed only after the archive and its manifest are on disk.

Options:
  --out <package>         Package path to write. Defaults to
                          ./haruyuki-<hostname>-<YYYYMMDD-HHmmss>.hryk in the
                          current directory. A relative path is resolved against
                          the current directory; an existing file is overwritten
                          after the confirmation word.
  --with-project[=<dir>]  Also export project-level data. Without a value the
                          current directory is used.
  --dry-run               Report what would be packed (counts, bytes, exclusions
                          and warnings) without writing or hashing anything.
  --json                  Print one JSON object instead of the human summary.
  --verbose               List every packed entry (secret names only, never
                          values).
  --yes                   Skip the confirmation word.
  -h, --help              Show this help.

Sensitive data warning:
  The package contains PLAINTEXT credentials (settings tokens, per-agent
  secrets, channel credentials) plus private conversations, reflection
  transcripts and memory. Anyone who has the file has your data. Keep it
  private, delete it when you are done; on POSIX it is written 0600 (Windows
  offers no ACL guarantee).
  Do not commit a .hryk package to git: this tool only warns, it never edits
  your .gitignore.

Consistency:
  Haruyuki does not detect other running windows. Make sure no other haruyuki
  window is running while you export, or the package may be inconsistent
  (messages, memory commits, usage and cron can change underneath it).

Confirmation:
  Export asks you to type "export". --yes skips it. In a non-interactive shell
  (no TTY) --yes is required, and the command refuses instead of waiting.

Exit codes:
  0 success; 1 runtime failure; 2 refused before anything was written.

Examples:
  haruyuki export --out ./work.hryk
  haruyuki export --out ./work.hryk --with-project --dry-run
  haruyuki export --out ./work.hryk --yes --json
`.trim();
}

export function formatImportUsage(): string {
  return `
Usage:
  haruyuki import --from <package> [--with-project[=<dir>]] [--verify]
                  [--json] [--verbose] [--yes]

Restore a .hryk package onto this machine. The package is validated first
(archive, manifest, schema version, every entry's size and SHA-256), then the
managed data is replaced — this is a snapshot restore, not a merge. A backup of
the current data is written to backups/pre-import.hryk before anything is
cleared, and a failure after landing rolls that backup back automatically.

Options:
  --from <package>        Package path to read (required).
  --with-project[=<dir>]  Restore project-level data to this directory. Without
                          a value the current directory is used. Only takes
                          effect when the package carries a project/ tree.
  --verify                Validate the package and print what it would
                          overwrite, without writing any data.
  --json                  Print one JSON object instead of the human summary.
  --verbose               List every restored entry (secret names only, never
                          values).
  --yes                   Skip the confirmation word.
  -h, --help              Show this help.

Sensitive data warning:
  The package contains PLAINTEXT credentials (settings tokens, per-agent
  secrets, channel credentials) plus private conversations, reflection
  transcripts and memory. Keep it private, and do not commit it to git: this
  tool only warns, it never edits your .gitignore.

Confirmation:
  Validation runs BEFORE the prompt, so a broken package never asks for the
  word. Import then asks you to type "overwrite". --yes skips it. In a
  non-interactive shell (no TTY) --yes is required, and the command refuses
  instead of waiting.

After a successful import:
  Restart haruyuki. Compiled prompt snapshots and recall indexes are rebuilt on
  first use, so the first conversation may be slower. When the rollback itself
  fails, the backup path and the manual recovery command are printed.

Exit codes:
  0 success; 1 runtime failure (including a failed rollback); 2 refused before
  anything was changed (corrupt package, unsupported version, no space, or a
  missing --yes in a non-interactive shell).

Examples:
  haruyuki import --from ./work.hryk --verify
  haruyuki import --from ./work.hryk
  haruyuki import --from ./work.hryk --yes --json
`.trim();
}

interface ExportArgs {
  help: boolean;
  out?: string;
  withProject?: string;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  yes: boolean;
  positionals: string[];
}

interface ImportArgs {
  help: boolean;
  from?: string;
  withProject?: string;
  verify: boolean;
  json: boolean;
  verbose: boolean;
  yes: boolean;
  positionals: string[];
}

/**
 * Expand the bare `--with-project` form to an explicit value.
 *
 * `parseArgs` has no optional-value flags, and the requirement writes the flag
 * as `--with-project[=<dir>]`, so the bare token is rewritten to the current
 * directory before parsing. Tokens after a `--` separator are left alone: those
 * are positionals, not flags.
 */
function expandOptionalFlagValue(argv: string[], cwd: string): string[] {
  const expanded: string[] = [];
  let pastSeparator = false;
  for (const token of argv) {
    if (token === "--") {
      pastSeparator = true;
      expanded.push(token);
      continue;
    }
    if (!pastSeparator && token === WITH_PROJECT_FLAG) {
      expanded.push(`${WITH_PROJECT_FLAG}=${cwd}`);
      continue;
    }
    expanded.push(token);
  }
  return expanded;
}

function parseExportArgs(argv: string[], cwd: string): ExportArgs {
  const parsed = parseArgs({
    args: expandOptionalFlagValue(argv, cwd),
    options: EXPORT_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  const out = parsed.values.out;
  const withProject = parsed.values["with-project"];
  return {
    help: parsed.values.help === true,
    out: out === undefined ? undefined : resolve(cwd, out),
    withProject:
      withProject === undefined ? undefined : resolve(cwd, withProject),
    dryRun: parsed.values["dry-run"] === true,
    json: parsed.values.json === true,
    verbose: parsed.values.verbose === true,
    yes: parsed.values.yes === true,
    positionals: parsed.positionals,
  };
}

function parseImportArgs(argv: string[], cwd: string): ImportArgs {
  const parsed = parseArgs({
    args: expandOptionalFlagValue(argv, cwd),
    options: IMPORT_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  const from = parsed.values.from;
  const withProject = parsed.values["with-project"];
  return {
    help: parsed.values.help === true,
    from: from === undefined ? undefined : resolve(cwd, from),
    withProject:
      withProject === undefined ? undefined : resolve(cwd, withProject),
    verify: parsed.values.verify === true,
    json: parsed.values.json === true,
    verbose: parsed.values.verbose === true,
    yes: parsed.values.yes === true,
    positionals: parsed.positionals,
  };
}

/** Whether a confirmation word can be asked in this shell. */
export function isInteractiveShell(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Replace every path-hostile character in a hostname with `-`, and fall back to
 * `host` when nothing printable is left.
 *
 * Windows rejects `: \ / * ? " < > |` in a file name, and a hostname can also
 * carry a domain or an IPv6 literal, so the default package name is built from
 * an ASCII-safe segment rather than trusted verbatim.
 */
function sanitizeHostname(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "host";
}

/** `YYYYMMDD-HHmmss` in LOCAL time; the name is for humans, not for sorting. */
function formatLocalStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}`;
}

/**
 * Default package path from §5.1.2:
 * `./haruyuki-<hostname>-<YYYYMMDD-HHmmss>.hryk` in the current directory.
 *
 * Pure with respect to the injected deps: a test pins `now`, `hostname` and
 * `cwd` and gets a deterministic name. The timestamp is local time because the
 * name is read by a person looking at a directory listing.
 */
export function defaultExportPath(deps: SnapshotCliDeps = {}): string {
  const cwd = deps.cwd ?? process.cwd();
  const host = sanitizeHostname(deps.hostname?.() ?? osHostname());
  const now = deps.now?.() ?? new Date();
  return resolve(cwd, `haruyuki-${host}-${formatLocalStamp(now)}.hryk`);
}

/**
 * Ask for a confirmation word and resolve whether it matched.
 *
 * The prompt goes to stderr so a `--json` run can still emit one clean object
 * on stdout. EOF, a closed interface and an aborted prompt all resolve false:
 * the caller reports `confirm_required`, never a partial run.
 */
export async function readConfirmationWord(
  expected: string,
  io: Partial<SnapshotConfirmIo> = {},
): Promise<boolean> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const terminal = io.terminal ?? isInteractiveShell();
  const reader = createInterface({ input, output, terminal });
  try {
    reader.setPrompt(`Type "${expected}" to continue: `);
    reader.prompt();
    // The answer is the first line, and `close` is the fallback: on a terminal
    // an EOF (Ctrl+D) or a closed pipe can end the stream without ever emitting
    // a line, and a prompt that never settles would hang the command. No timer
    // is involved — both events belong to the stream itself.
    const answer = await new Promise<string | null>((resolveAnswer) => {
      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolveAnswer(value);
      };
      reader.once("line", (line: string) => {
        settle(line);
      });
      reader.once("close", () => {
        settle(null);
      });
    });
    return answer !== null && answer.trim() === expected;
  } finally {
    reader.close();
  }
}

function createProgressHandler(
  silent: boolean,
): SnapshotProgressHandler | undefined {
  if (silent) return undefined;
  return (progress) => {
    console.error(formatProgress(progress));
  };
}

function formatProgress(progress: SnapshotProgress): string {
  const counter =
    progress.total === undefined || progress.total === 0
      ? ""
      : ` (${progress.current ?? 0}/${progress.total})`;
  return `  ${progress.phase}: ${progress.message}${counter}`;
}

/** Build a report for a failure the shell detected before the pipeline ran. */
function failureReport(
  command: SnapshotCommand,
  code: SnapshotErrorCode,
  message: string,
  extra: Partial<SnapshotReport> = {},
): SnapshotReport {
  return {
    ok: code === "ok",
    code,
    command,
    message,
    dryRun: false,
    counts: { files: 0, bytes: 0, secrets: 0 },
    excluded: [],
    remapped: [],
    notRemapped: [],
    failedSecrets: [],
    warnings: [],
    durationMs: 0,
    ...extra,
  };
}

/**
 * Turn a thrown pipeline error into a report.
 *
 * Snapshot modules throw `SnapshotError` with the code they mean; anything else
 * is an unexpected I/O-shaped failure and maps to `io_error`, never to success.
 */
function reportFromError(
  command: SnapshotCommand,
  error: unknown,
  extra: Partial<SnapshotReport> = {},
): SnapshotReport {
  if (error instanceof SnapshotError) {
    return failureReport(command, error.code, error.message, extra);
  }
  const message = error instanceof Error ? error.message : String(error);
  return failureReport(command, "io_error", message, extra);
}

function emitReport(report: SnapshotReport, json: boolean): void {
  console.log(json ? toJson(report) : toHuman(report));
}

function exitCodeForReport(report: SnapshotReport): number {
  return report.ok ? 0 : exitCodeFor(report.code);
}

function reportUsageError(
  command: SnapshotCommand,
  error: unknown,
  usage: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${command}: ${message}`);
  console.error(usage);
}

async function loadDefaultPipeline(): Promise<SnapshotCliPipeline> {
  const [exportModule, importModule] = await Promise.all([
    import("./export"),
    import("./import"),
  ]);
  return {
    runExport: exportModule.runExport,
    runImport: importModule.runImport,
  };
}

function printExportBanner(out: string, dryRun: boolean): void {
  console.error(EXPORT_WARNING);
  console.error("");
  if (dryRun) {
    console.error(`Package: ${out} (--dry-run: nothing will be written)`);
  } else if (existsSync(out)) {
    console.error(`Package: ${out} (this file exists and will be overwritten)`);
  } else {
    console.error(`Package: ${out}`);
  }
  console.error("");
}

function printImportBanner(from: string, verify: boolean): void {
  console.error(`Package: ${from}`);
  console.error(
    verify
      ? "Mode: verify only — the package is validated and nothing is written."
      : "Mode: restore — the package is validated first, then the managed data on this machine is replaced (a backup is written first).",
  );
  console.error("");
}

function printImportReminders(json: boolean): void {
  if (json) console.error(IMPORT_REMINDERS);
  else console.log(IMPORT_REMINDERS);
}

/**
 * `haruyuki export [--out <pkg>] [--with-project=<dir>] [--dry-run] [--json]
 * [--verbose] [--yes]`. Returns the process exit code (0 ok / 1 runtime failure
 * / 2 preflight refusal).
 *
 * Without `--out` the package goes to the §5.1.2 default name, and the resolved
 * absolute path is what the report (human and `--json`) shows.
 */
export async function runSnapshotExport(
  argv: string[],
  deps: SnapshotCliDeps = {},
  pipeline?: SnapshotCliPipeline,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const usage = formatExportUsage();

  let args: ExportArgs;
  try {
    args = parseExportArgs(argv, cwd);
  } catch (error) {
    reportUsageError("export", error, usage);
    return 1;
  }

  if (args.help || args.positionals[0] === "help") {
    console.log(usage);
    return 0;
  }
  if (args.positionals.length > 0) {
    reportUsageError(
      "export",
      new Error(`unexpected argument "${args.positionals[0]}"`),
      usage,
    );
    return 1;
  }

  const out = args.out ?? defaultExportPath(deps);
  printExportBanner(out, args.dryRun);

  if (!args.yes) {
    if (!isInteractiveShell()) {
      const report = failureReport(
        "export",
        "confirm_required",
        "Refused: no TTY and --yes was not given; nothing was written.",
        { out, dryRun: args.dryRun },
      );
      emitReport(report, args.json);
      return exitCodeForReport(report);
    }
    const confirmed = await readConfirmationWord("export");
    if (!confirmed) {
      const report = failureReport(
        "export",
        "confirm_required",
        'Refused: the confirmation word "export" was not typed; nothing was written.',
        { out, dryRun: args.dryRun },
      );
      emitReport(report, args.json);
      return exitCodeForReport(report);
    }
  }

  try {
    const implementation = pipeline ?? (await loadDefaultPipeline());
    const report = await implementation.runExport(
      {
        out,
        withProject: args.withProject,
        dryRun: args.dryRun,
        verbose: args.verbose,
        deps,
      },
      createProgressHandler(args.json),
    );
    emitReport(report, args.json);
    return exitCodeForReport(report);
  } catch (error) {
    const report = reportFromError("export", error, {
      out,
      dryRun: args.dryRun,
    });
    emitReport(report, args.json);
    return exitCodeForReport(report);
  }
}

/**
 * `haruyuki import --from <pkg> [--with-project=<dir>] [--verify] [--json]
 * [--verbose] [--yes]`. Returns the process exit code.
 *
 * The confirmation word is not asked here: it is handed to the pipeline as
 * `requireConfirm` so validation finishes before the user types anything.
 */
export async function runSnapshotImport(
  argv: string[],
  deps: SnapshotCliDeps = {},
  pipeline?: SnapshotCliPipeline,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const usage = formatImportUsage();

  let args: ImportArgs;
  try {
    args = parseImportArgs(argv, cwd);
  } catch (error) {
    reportUsageError("import", error, usage);
    return 1;
  }

  if (args.help || args.positionals[0] === "help") {
    console.log(usage);
    return 0;
  }
  if (args.positionals.length > 0) {
    reportUsageError(
      "import",
      new Error(`unexpected argument "${args.positionals[0]}"`),
      usage,
    );
    return 1;
  }
  if (!args.from) {
    reportUsageError(
      "import",
      new Error("--from <package> is required"),
      usage,
    );
    return 1;
  }

  const from = args.from;
  printImportBanner(from, args.verify);

  const requireConfirm: ImportPipeline.RequireConfirm = async (details) => {
    if (args.yes) return true;
    if (!isInteractiveShell()) {
      console.error(
        "Refused: the package passed validation, but this shell has no TTY and --yes was not given; nothing was changed.",
      );
      return false;
    }
    const lines = [
      "This import will replace the managed data on this machine:",
      `  package        ${details.packagePath}`,
      `  home           ${details.roots.home}`,
      `  local-backend  ${details.roots.localBackend}`,
      details.roots.project ? `  project        ${details.roots.project}` : "",
      `  files          ${details.counts.files} (${formatBytes(details.counts.bytes)})`,
      `  secrets        ${details.counts.secrets}`,
      `  excluded       ${details.excluded.length} rule(s) left untouched`,
      "A backup of the current data is written to backups/pre-import.hryk first.",
      "",
    ].filter((line) => line.length > 0);
    console.error(lines.join("\n"));
    return readConfirmationWord("overwrite");
  };

  try {
    const implementation = pipeline ?? (await loadDefaultPipeline());
    const report = await implementation.runImport(
      {
        from,
        withProject: args.withProject,
        verify: args.verify,
        yes: args.yes,
        verbose: args.verbose,
        deps,
        requireConfirm,
      },
      createProgressHandler(args.json),
    );
    emitReport(report, args.json);
    if (report.ok && !args.verify) printImportReminders(args.json);
    return exitCodeForReport(report);
  } catch (error) {
    const report = reportFromError("import", error, { package: from });
    emitReport(report, args.json);
    return exitCodeForReport(report);
  }
}
