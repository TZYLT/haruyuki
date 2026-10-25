import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import {
  readConfirmationWord,
  runSnapshotExport,
  runSnapshotImport,
  type SnapshotCliPipeline,
} from "@/cli/subcommands/snapshot/cli";
import type { ExportOptions } from "@/cli/subcommands/snapshot/export";
import type { ImportOptions } from "@/cli/subcommands/snapshot/import";
import {
  type SnapshotErrorCode,
  type SnapshotReport,
  snapshotError,
} from "@/cli/subcommands/snapshot/types";
import { TestDirectory } from "@/test-utils/test-fs";

const directory = new TestDirectory();

interface CapturedConsole {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

function captureConsole(): CapturedConsole {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    stdout,
    stderr,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function lastJsonObject(lines: string[]): Record<string, unknown> {
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error("no stdout was captured");
  return JSON.parse(last) as Record<string, unknown>;
}

function makeReport(overrides: Partial<SnapshotReport> = {}): SnapshotReport {
  return {
    ok: true,
    code: "ok",
    command: "export",
    message: "Wrote 3 files",
    dryRun: false,
    counts: { files: 3, bytes: 2048, secrets: 2 },
    excluded: [],
    remapped: [],
    notRemapped: [],
    failedSecrets: [],
    warnings: [],
    durationMs: 1500,
    ...overrides,
  };
}

function fakePipeline(
  overrides: Partial<SnapshotCliPipeline> = {},
): SnapshotCliPipeline {
  return {
    runExport: async () => makeReport(),
    runImport: async () =>
      makeReport({ command: "import", message: "Restored 3 files" }),
    ...overrides,
  };
}

/** Every exit code from §5.11.4, in one table both this file and report.test use. */
const EXIT_BY_CODE: ReadonlyArray<readonly [SnapshotErrorCode, number]> = [
  ["ok", 0],
  ["confirm_required", 2],
  ["verify_failed", 2],
  ["version_unsupported", 2],
  ["insufficient_space", 2],
  ["backup_failed", 1],
  ["io_error", 1],
  ["rollback_failed", 1],
  ["path_conflict", 1],
];

describe("snapshot export CLI", () => {
  test("prints usage, the sensitive warning and the non-TTY rule", async () => {
    const captured = captureConsole();
    try {
      expect(await runSnapshotExport(["--help"])).toBe(0);
      const output = captured.stdout.join("\n");
      expect(output).toContain("Usage:");
      expect(output).toContain("haruyuki export [--out <package>]");
      expect(output).toContain("PLAINTEXT credentials");
      expect(output).toContain("Do not commit a .hryk package to git");
      expect(output).toContain('type "export"');
      expect(output).toContain("no TTY");
    } finally {
      captured.restore();
    }
  });

  test("defaults --out to the §5.1.2 host-and-timestamp name", async () => {
    const captured = captureConsole();
    let received: ExportOptions | undefined;
    try {
      const pipeline = fakePipeline({
        runExport: async (options) => {
          received = options;
          return makeReport({ out: options.out });
        },
      });
      const exitCode = await runSnapshotExport(
        ["--yes"],
        {
          cwd: directory.path,
          hostname: () => "build-box",
          // Local time on purpose: the report and the file name agree.
          now: () => new Date(2026, 9, 25, 22, 34, 56),
        },
        pipeline,
      );
      const expected = directory.resolve(
        "haruyuki-build-box-20261025-223456.hryk",
      );
      expect(exitCode).toBe(0);
      expect(received?.out).toBe(expected);
      // The banner and the summary show the resolved path, not "undefined".
      expect(captured.stderr.join("\n")).toContain(expected);
      expect(captured.stdout.join("\n")).toContain(expected);
    } finally {
      captured.restore();
    }
  });

  test("sanitizes a hostname that is not a legal path segment", async () => {
    const captured = captureConsole();
    const seen: Array<string | undefined> = [];
    try {
      const pipeline = fakePipeline({
        runExport: async (options) => {
          seen.push(options.out);
          return makeReport({ out: options.out });
        },
      });
      const fixedNow = () => new Date(2026, 9, 25, 22, 34, 56);
      await runSnapshotExport(
        ["--yes"],
        {
          cwd: directory.path,
          hostname: () => "DESKTOP-1:8080 / weird",
          now: fixedNow,
        },
        pipeline,
      );
      await runSnapshotExport(
        ["--yes"],
        { cwd: directory.path, hostname: () => "  ", now: fixedNow },
        pipeline,
      );
      expect(seen).toEqual([
        directory.resolve("haruyuki-DESKTOP-1-8080-weird-20261025-223456.hryk"),
        directory.resolve("haruyuki-host-20261025-223456.hryk"),
      ]);
    } finally {
      captured.restore();
    }
  });

  test("an explicit --out is never replaced by the default name", async () => {
    const captured = captureConsole();
    let received: ExportOptions | undefined;
    try {
      const out = directory.resolve("explicit.hryk");
      const pipeline = fakePipeline({
        runExport: async (options) => {
          received = options;
          return makeReport({ out: options.out });
        },
      });
      await runSnapshotExport(
        ["--out", out, "--yes"],
        {
          cwd: directory.path,
          hostname: () => "build-box",
          now: () => new Date(2026, 9, 25, 22, 34, 56),
        },
        pipeline,
      );
      expect(received?.out).toBe(out);
    } finally {
      captured.restore();
    }
  });

  test("--json reports the default --out path too", async () => {
    const captured = captureConsole();
    try {
      const pipeline = fakePipeline({
        runExport: async (options) => makeReport({ out: options.out }),
      });
      await runSnapshotExport(
        ["--yes", "--json"],
        {
          cwd: directory.path,
          hostname: () => "build-box",
          now: () => new Date(2026, 9, 25, 22, 34, 56),
        },
        pipeline,
      );
      const parsed = lastJsonObject(captured.stdout);
      expect(parsed.out).toBe(
        directory.resolve("haruyuki-build-box-20261025-223456.hryk"),
      );
    } finally {
      captured.restore();
    }
  });

  test("rejects an unknown flag through strict parsing", async () => {
    const captured = captureConsole();
    try {
      const out = directory.resolve("pkg.hryk");
      expect(await runSnapshotExport(["--out", out, "--bogus"])).toBe(1);
      expect(captured.stderr.join("\n")).toContain("bogus");
    } finally {
      captured.restore();
    }
  });

  test("refuses without --yes when there is no TTY and never runs the pipeline", async () => {
    const captured = captureConsole();
    let calls = 0;
    try {
      const pipeline = fakePipeline({
        runExport: async () => {
          calls += 1;
          return makeReport();
        },
      });
      const exitCode = await runSnapshotExport(
        ["--out", directory.resolve("pkg.hryk")],
        {},
        pipeline,
      );
      expect(exitCode).toBe(2);
      expect(calls).toBe(0);
      const output = captured.stdout.join("\n");
      expect(output).toContain("confirm_required");
      expect(output).toContain("Export failed");
    } finally {
      captured.restore();
    }
  });

  test("warns that an existing package will be overwritten", async () => {
    const captured = captureConsole();
    try {
      const out = directory.createFile("existing.hryk", "placeholder");
      await runSnapshotExport(["--out", out], {}, fakePipeline());
      expect(captured.stderr.join("\n")).toContain("will be overwritten");
    } finally {
      captured.restore();
    }
  });

  test("runs the pipeline with --yes and forwards the resolved options", async () => {
    const captured = captureConsole();
    let received: ExportOptions | undefined;
    try {
      const out = directory.resolve("fresh.hryk");
      const pipeline = fakePipeline({
        runExport: async (options) => {
          received = options;
          return makeReport({ out: options.out, entries: undefined });
        },
      });
      const exitCode = await runSnapshotExport(
        ["--out", out, "--yes"],
        { cwd: directory.path },
        pipeline,
      );
      expect(exitCode).toBe(0);
      expect(received?.out).toBe(out);
      expect(received?.dryRun).toBe(false);
      expect(received?.verbose).toBe(false);
      expect(received?.withProject).toBeUndefined();
      expect(captured.stdout.join("\n")).toContain("Export complete");
    } finally {
      captured.restore();
    }
  });

  test("--with-project defaults to the current directory and accepts a value", async () => {
    const captured = captureConsole();
    const seen: Array<string | undefined> = [];
    try {
      const pipeline = fakePipeline({
        runExport: async (options) => {
          seen.push(options.withProject);
          return makeReport({ out: options.out });
        },
      });
      await runSnapshotExport(
        ["--out", directory.resolve("a.hryk"), "--yes", "--with-project"],
        { cwd: directory.path },
        pipeline,
      );
      const project = directory.createDir("project");
      await runSnapshotExport(
        [
          "--out",
          directory.resolve("b.hryk"),
          "--yes",
          `--with-project=${project}`,
        ],
        { cwd: directory.path },
        pipeline,
      );
      expect(seen).toEqual([directory.path, project]);
    } finally {
      captured.restore();
    }
  });

  test("--dry-run marks the report and lists excluded paths", async () => {
    const captured = captureConsole();
    let dryRun: boolean | undefined;
    try {
      const pipeline = fakePipeline({
        runExport: async (options) => {
          dryRun = options.dryRun;
          return makeReport({
            out: options.out,
            dryRun: true,
            message: "Preview only",
            excluded: [{ path: "home/backups", reason: "self backup" }],
          });
        },
      });
      await runSnapshotExport(
        ["--out", directory.resolve("c.hryk"), "--yes", "--dry-run"],
        {},
        pipeline,
      );
      expect(dryRun).toBe(true);
      const output = captured.stdout.join("\n");
      expect(output).toContain("nothing was written");
      expect(output).toContain("home/backups — self backup");
    } finally {
      captured.restore();
    }
  });

  test("--json emits one object with the §5.13.2 snake_case keys", async () => {
    const captured = captureConsole();
    try {
      const out = directory.resolve("d.hryk");
      const pipeline = fakePipeline({
        runExport: async () =>
          makeReport({
            out,
            dryRun: true,
            counts: { files: 7, bytes: 4096, secrets: 2 },
            remapped: [],
            notRemapped: [
              { field: "sessions.jsonl.project", reason: "project" },
            ],
            failedSecrets: [
              { scope: "agent", name: "OPENAI_API_KEY", reason: "locked" },
            ],
            warnings: ["a warning"],
            durationMs: 2500,
          }),
      });
      expect(
        await runSnapshotExport(
          ["--out", out, "--yes", "--json"],
          {},
          pipeline,
        ),
      ).toBe(0);

      const parsed = lastJsonObject(captured.stdout);
      expect(Object.keys(parsed)).toEqual([
        "ok",
        "code",
        "message",
        "out",
        "dry_run",
        "counts",
        "excluded",
        "remapped",
        "not_remapped",
        "failed_secrets",
        "warnings",
        "duration_ms",
      ]);
      expect(parsed.ok).toBe(true);
      expect(parsed.code).toBe("ok");
      expect(parsed.dry_run).toBe(true);
      expect(parsed.duration_ms).toBe(2500);
      expect(parsed.not_remapped).toEqual([
        { field: "sessions.jsonl.project", reason: "project" },
      ]);
      expect(parsed.failed_secrets).toEqual([
        { scope: "agent", name: "OPENAI_API_KEY", reason: "locked" },
      ]);
      expect(parsed.entries).toBeUndefined();
      expect(JSON.stringify(parsed)).not.toContain("secret-value");
    } finally {
      captured.restore();
    }
  });

  test("--json --verbose adds the entry list", async () => {
    const captured = captureConsole();
    try {
      const out = directory.resolve("e.hryk");
      const pipeline = fakePipeline({
        runExport: async () =>
          makeReport({
            out,
            entries: [
              {
                path: "home/settings.json",
                scope: "home",
                bytes: 12,
                sha256: "aa",
              },
            ],
          }),
      });
      await runSnapshotExport(
        ["--out", out, "--yes", "--json", "--verbose"],
        {},
        pipeline,
      );
      const parsed = lastJsonObject(captured.stdout);
      expect(parsed.entries).toEqual([
        { path: "home/settings.json", scope: "home", bytes: 12, sha256: "aa" },
      ]);
    } finally {
      captured.restore();
    }
  });

  test("--json passes a pipeline-supplied byScope through as by_scope", async () => {
    const captured = captureConsole();
    try {
      const out = directory.resolve("f.hryk");
      const pipeline = fakePipeline({
        runExport: async () =>
          makeReport({
            out,
            byScope: {
              home: { files: 12, bytes: 1024 },
              secrets: { files: 2, bytes: 0 },
            },
          }),
      });
      await runSnapshotExport(["--out", out, "--yes", "--json"], {}, pipeline);
      const parsed = lastJsonObject(captured.stdout);
      expect(parsed.by_scope).toEqual({
        home: { files: 12, bytes: 1024 },
        secrets: { files: 2, bytes: 0 },
      });
    } finally {
      captured.restore();
    }
  });

  test("maps every report code onto its documented exit code", async () => {
    for (const [code, expected] of EXIT_BY_CODE) {
      const captured = captureConsole();
      try {
        const out = directory.resolve(`${code}.hryk`);
        const pipeline = fakePipeline({
          runExport: async () =>
            makeReport({ out, ok: code === "ok", code, command: "export" }),
        });
        const exitCode = await runSnapshotExport(
          ["--out", out, "--yes", "--json"],
          {},
          pipeline,
        );
        expect(exitCode).toBe(expected);
        expect(lastJsonObject(captured.stdout).code).toBe(code);
      } finally {
        captured.restore();
      }
    }
  });

  test("turns a thrown SnapshotError into its code and exit code", async () => {
    for (const [code, expected] of EXIT_BY_CODE) {
      if (code === "ok") continue;
      const captured = captureConsole();
      try {
        const pipeline = fakePipeline({
          runExport: async () => {
            throw snapshotError(code, `boom: ${code}`);
          },
        });
        const exitCode = await runSnapshotExport(
          ["--out", directory.resolve("boom.hryk"), "--yes", "--json"],
          {},
          pipeline,
        );
        expect(exitCode).toBe(expected);
        const parsed = lastJsonObject(captured.stdout);
        expect(parsed.ok).toBe(false);
        expect(parsed.code).toBe(code);
        expect(parsed.message).toBe(`boom: ${code}`);
      } finally {
        captured.restore();
      }
    }
  });

  test("turns an unexpected error into io_error", async () => {
    const captured = captureConsole();
    try {
      const pipeline = fakePipeline({
        runExport: async () => {
          throw new Error("disk on fire");
        },
      });
      const exitCode = await runSnapshotExport(
        ["--out", directory.resolve("fire.hryk"), "--yes", "--json"],
        {},
        pipeline,
      );
      expect(exitCode).toBe(1);
      const parsed = lastJsonObject(captured.stdout);
      expect(parsed.code).toBe("io_error");
      expect(parsed.message).toBe("disk on fire");
    } finally {
      captured.restore();
    }
  });
});

describe("snapshot import CLI", () => {
  test("prints usage, the overwrite word, the restart reminder and the warning", async () => {
    const captured = captureConsole();
    try {
      expect(await runSnapshotImport(["--help"])).toBe(0);
      const output = captured.stdout.join("\n");
      expect(output).toContain("haruyuki import --from <package>");
      expect(output).toContain('type "overwrite"');
      expect(output).toContain("Restart haruyuki");
      expect(output).toContain("commit it to git");
      expect(output).toContain("Validation runs BEFORE the prompt");
    } finally {
      captured.restore();
    }
  });

  test("rejects a missing --from", async () => {
    const captured = captureConsole();
    try {
      expect(await runSnapshotImport([])).toBe(1);
      expect(captured.stderr.join("\n")).toContain(
        "--from <package> is required",
      );
    } finally {
      captured.restore();
    }
  });

  test("asks for the word only after validation and refuses without a TTY", async () => {
    const captured = captureConsole();
    let prompted = 0;
    let validated = false;
    try {
      const pipeline = fakePipeline({
        runImport: async (options: ImportOptions) => {
          // Stand-in for M6: validation has already succeeded by this point.
          validated = true;
          const confirmed = await options.requireConfirm?.({
            packagePath: options.from,
            roots: { home: "/home/u/.haruyuki", localBackend: "/lb" },
            counts: { files: 5, bytes: 1024, secrets: 1 },
            excluded: [],
          });
          prompted += 1;
          return makeReport({
            command: "import",
            ok: confirmed === true,
            code: confirmed === true ? "ok" : "confirm_required",
            message: confirmed === true ? "Restored" : "Confirmation declined",
            package: options.from,
          });
        },
      });
      const exitCode = await runSnapshotImport(
        ["--from", directory.resolve("pkg.hryk")],
        {},
        pipeline,
      );
      expect(validated).toBe(true);
      expect(prompted).toBe(1);
      expect(exitCode).toBe(2);
      expect(captured.stdout.join("\n")).toContain("confirm_required");
      expect(captured.stderr.join("\n")).toContain(
        "the package passed validation",
      );
    } finally {
      captured.restore();
    }
  });

  test("--yes makes the injected confirmation resolve true", async () => {
    const captured = captureConsole();
    let confirmed: boolean | undefined;
    try {
      const from = directory.resolve("pkg.hryk");
      const pipeline = fakePipeline({
        runImport: async (options: ImportOptions) => {
          confirmed = await options.requireConfirm?.({
            packagePath: options.from,
            roots: { home: "/h", localBackend: "/lb" },
            counts: { files: 0, bytes: 0, secrets: 0 },
            excluded: [],
          });
          return makeReport({
            command: "import",
            package: options.from,
            backupPath: "/h/backups/pre-import.hryk",
          });
        },
      });
      const exitCode = await runSnapshotImport(
        ["--from", from, "--yes"],
        {},
        pipeline,
      );
      expect(confirmed).toBe(true);
      expect(exitCode).toBe(0);
      const output = captured.stdout.join("\n");
      expect(output).toContain("Import complete");
      expect(output).toContain("backups/pre-import.hryk");
      expect(output).toContain("Restart haruyuki");
    } finally {
      captured.restore();
    }
  });

  test("--verify forwards the flag, needs no confirmation word and prints no reminder", async () => {
    const captured = captureConsole();
    let verify: boolean | undefined;
    try {
      const pipeline = fakePipeline({
        runImport: async (options: ImportOptions) => {
          verify = options.verify;
          // §5.1.4 does not exempt --verify from anything it already does; the
          // point here is that verify never asks, so this run succeeds with no
          // --yes and no TTY.
          return makeReport({
            command: "import",
            message: "Package is valid",
            package: options.from,
          });
        },
      });
      const exitCode = await runSnapshotImport(
        ["--from", directory.resolve("pkg.hryk"), "--verify"],
        {},
        pipeline,
      );
      expect(verify).toBe(true);
      expect(exitCode).toBe(0);
      const output = captured.stdout.join("\n");
      expect(output).toContain("Package is valid");
      expect(output).not.toContain("Restart haruyuki");
      expect(captured.stderr.join("\n")).not.toContain("no TTY");
    } finally {
      captured.restore();
    }
  });

  test("--json reports the import shape including backup_path", async () => {
    const captured = captureConsole();
    try {
      const from = directory.resolve("pkg.hryk");
      const pipeline = fakePipeline({
        runImport: async () =>
          makeReport({
            command: "import",
            package: from,
            backupPath: "/h/backups/pre-import.hryk",
            remapped: [
              {
                field: "sessionsByServer",
                from: "local:C:\\old",
                to: "local:C:\\new",
              },
            ],
            notRemapped: [
              { field: "sessions.jsonl.project", reason: "project" },
            ],
            failedSecrets: [
              {
                scope: "channel",
                name: "telegram:bot_token",
                reason: "denied",
              },
            ],
            rollback: { attempted: true, ok: true, message: "restored backup" },
            migrations: ["v1 -> v2"],
            counts: { files: 9, bytes: 2048, secrets: 1 },
          }),
      });
      await runSnapshotImport(
        ["--from", from, "--yes", "--json"],
        {},
        pipeline,
      );
      const parsed = lastJsonObject(captured.stdout);
      expect(parsed.package).toBe(from);
      expect(parsed.backup_path).toBe("/h/backups/pre-import.hryk");
      expect(parsed.not_remapped).toEqual([
        { field: "sessions.jsonl.project", reason: "project" },
      ]);
      expect(parsed.failed_secrets).toEqual([
        { scope: "channel", name: "telegram:bot_token", reason: "denied" },
      ]);
      expect(parsed.remapped).toEqual([
        {
          field: "sessionsByServer",
          from: "local:C:\\old",
          to: "local:C:\\new",
        },
      ]);
      expect(parsed.rollback).toEqual({
        attempted: true,
        ok: true,
        message: "restored backup",
      });
      expect(parsed.migrations).toEqual(["v1 -> v2"]);
      expect(parsed.out).toBeUndefined();
      // The restart reminder must not pollute the single JSON object.
      expect(captured.stderr.join("\n")).toContain("Restart haruyuki");
    } finally {
      captured.restore();
    }
  });

  test("maps every import report code onto its exit code", async () => {
    for (const [code, expected] of EXIT_BY_CODE) {
      const captured = captureConsole();
      try {
        const pipeline = fakePipeline({
          runImport: async () =>
            makeReport({
              command: "import",
              ok: code === "ok",
              code,
              message: `code: ${code}`,
            }),
        });
        const exitCode = await runSnapshotImport(
          ["--from", directory.resolve("pkg.hryk"), "--yes", "--json"],
          {},
          pipeline,
        );
        expect(exitCode).toBe(expected);
        expect(lastJsonObject(captured.stdout).code).toBe(code);
      } finally {
        captured.restore();
      }
    }
  });
});

describe("confirmation word", () => {
  test("accepts exactly the expected word, ignoring surrounding whitespace", async () => {
    const answer = await readConfirmationWord("overwrite", {
      input: readableFrom("  overwrite \n"),
      output: sinkWritable(),
      terminal: false,
    });
    expect(answer).toBe(true);
  });

  test("rejects a different word", async () => {
    const answer = await readConfirmationWord("overwrite", {
      input: readableFrom("yes\n"),
      output: sinkWritable(),
      terminal: false,
    });
    expect(answer).toBe(false);
  });

  test("rejects EOF without hanging", async () => {
    const answer = await readConfirmationWord("export", {
      input: readableFrom(""),
      output: sinkWritable(),
      terminal: false,
    });
    expect(answer).toBe(false);
  });
});

function readableFrom(text: string): NodeJS.ReadableStream {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

function sinkWritable(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
