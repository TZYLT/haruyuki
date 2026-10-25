import { describe, expect, test } from "bun:test";
import {
  exitCodeFor,
  formatBytes,
  formatDuration,
  toHuman,
  toJson,
} from "@/cli/subcommands/snapshot/report";
import type {
  SnapshotErrorCode,
  SnapshotReport,
} from "@/cli/subcommands/snapshot/types";

function makeReport(overrides: Partial<SnapshotReport> = {}): SnapshotReport {
  return {
    ok: true,
    code: "ok",
    command: "export",
    message: "Wrote 4 files",
    out: "C:\\tmp\\pkg.hryk",
    dryRun: false,
    counts: { files: 4, bytes: 3 * 1024 * 1024, secrets: 2 },
    excluded: [{ path: "home/backups", reason: "self backup" }],
    remapped: [],
    notRemapped: [],
    failedSecrets: [],
    warnings: [],
    durationMs: 1500,
    ...overrides,
  };
}

describe("exitCodeFor", () => {
  const expected: ReadonlyArray<readonly [SnapshotErrorCode, number]> = [
    ["ok", 0],
    ["confirm_required", 2],
    ["verify_failed", 2],
    ["version_unsupported", 2],
    ["insufficient_space", 2],
    ["io_error", 1],
    ["backup_failed", 1],
    ["rollback_failed", 1],
    ["path_conflict", 1],
  ];

  test("covers every code from §5.11.4", () => {
    for (const [code, exitCode] of expected) {
      expect(exitCodeFor(code)).toBe(exitCode);
    }
  });
});

describe("toJson", () => {
  test("emits the §5.13.2 keys with snake_case for multi-word fields", () => {
    const parsed = JSON.parse(toJson(makeReport())) as Record<string, unknown>;
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
    expect(parsed.not_remapped).toEqual([]);
    expect(parsed.failed_secrets).toEqual([]);
    expect(parsed.dry_run).toBe(false);
    expect(parsed.duration_ms).toBe(1500);
    expect(parsed.entries).toBeUndefined();
    expect(parsed.rollback).toBeUndefined();
    expect(parsed.migrations).toBeUndefined();
    expect(parsed.by_scope).toBeUndefined();
  });

  test("maps byScope to by_scope only when the report carries it", () => {
    const report = makeReport({
      byScope: {
        home: { files: 120, bytes: 3 * 1024 * 1024 },
        "local-backend": { files: 40, bytes: 1024 },
        secrets: { files: 3, bytes: 0 },
      },
    });
    const parsed = JSON.parse(toJson(report)) as Record<string, unknown>;
    expect(parsed.by_scope).toEqual({
      home: { files: 120, bytes: 3 * 1024 * 1024 },
      "local-backend": { files: 40, bytes: 1024 },
      secrets: { files: 3, bytes: 0 },
    });
    // The aggregate totals stay authoritative and are still present.
    expect(parsed.counts).toEqual({
      files: 4,
      bytes: 3 * 1024 * 1024,
      secrets: 2,
    });
  });

  test("keeps entries out unless the report carries them (verbose only)", () => {
    const report = makeReport({
      entries: [
        { path: "home/settings.json", scope: "home", bytes: 10, sha256: "aa" },
      ],
    });
    const parsed = JSON.parse(toJson(report)) as Record<string, unknown>;
    expect(parsed.entries).toEqual([
      { path: "home/settings.json", scope: "home", bytes: 10, sha256: "aa" },
    ]);
  });

  test("emits package, backup_path, rollback and migrations for an import", () => {
    const report = makeReport({
      command: "import",
      out: undefined,
      package: "C:\\tmp\\pkg.hryk",
      backupPath: "C:\\home\\backups\\pre-import.hryk",
      rollback: { attempted: true, ok: false, message: "copy failed" },
      migrations: ["v1 -> v2"],
      failedSecrets: [{ scope: "agent", name: "TOKEN", reason: "locked" }],
    });
    const parsed = JSON.parse(toJson(report)) as Record<string, unknown>;
    expect(parsed.out).toBeUndefined();
    expect(parsed.package).toBe("C:\\tmp\\pkg.hryk");
    expect(parsed.backup_path).toBe("C:\\home\\backups\\pre-import.hryk");
    expect(parsed.rollback).toEqual({
      attempted: true,
      ok: false,
      message: "copy failed",
    });
    expect(parsed.migrations).toEqual(["v1 -> v2"]);
    expect(parsed.failed_secrets).toEqual([
      { scope: "agent", name: "TOKEN", reason: "locked" },
    ]);
  });

  test("never carries a secret value", () => {
    const report = makeReport({
      failedSecrets: [
        { scope: "channel", name: "telegram:bot_token", reason: "denied" },
      ],
    });
    const text = toJson(report);
    expect(text).toContain("telegram:bot_token");
    expect(text).not.toContain("secret-value");
  });
});

describe("toHuman", () => {
  test("prints the summary: message, counts, bytes, duration and package", () => {
    const text = toHuman(makeReport());
    expect(text).toContain("Export complete: C:\\tmp\\pkg.hryk");
    expect(text).toContain("Wrote 4 files");
    expect(text).toContain("files      4");
    expect(text).toContain("3.0 MB");
    expect(text).toContain("secrets    2");
    expect(text).toContain("1.5s");
    expect(text).toContain("excluded   1 rule(s)");
    expect(text).toContain("--dry-run");
    // No per-tree data on this report, so no category block is invented.
    expect(text).not.toContain("by scope:");
  });

  test("prints the per-tree category lines when byScope is present", () => {
    const text = toHuman(
      makeReport({
        byScope: {
          home: { files: 120, bytes: 12 * 1024 * 1024 },
          "local-backend": { files: 40, bytes: 1024 * 1024 },
          project: { files: 2, bytes: 8 * 1024 },
          secrets: { files: 3, bytes: 0 },
        },
      }),
    );
    expect(text).toContain("by scope:");
    expect(text).toMatch(/^ {4}home\s+120 files \/ 12\.0 MB$/m);
    expect(text).toMatch(/^ {4}local-backend\s+40 files \/ 1\.0 MB$/m);
    expect(text).toMatch(/^ {4}project\s+2 files \/ 8\.0 KB$/m);
    // Secrets are values, not bytes: the line carries the count alone.
    expect(text).toMatch(/^ {4}secrets\s+3$/m);
    // The aggregate totals are still printed after the category block.
    expect(text).toContain("files      4");
  });

  test("skips a scope the pipeline did not fill", () => {
    const text = toHuman(
      makeReport({ byScope: { home: { files: 2, bytes: 100 } } }),
    );
    expect(text).toMatch(/^ {4}home\s+2 files \/ 100 B$/m);
    expect(text).not.toMatch(/^ {4}local-backend/m);
  });

  test("lists entries in package scope order when verbose", () => {
    const text = toHuman(
      makeReport({
        entries: [
          {
            path: "local-backend/agents/a.json",
            scope: "local-backend",
            bytes: 5,
            sha256: "bb",
          },
          {
            path: "home/settings.json",
            scope: "home",
            bytes: 10,
            sha256: "aa",
          },
        ],
      }),
    );
    expect(text).toContain("Entries:");
    expect(text.indexOf("home/settings.json")).toBeLessThan(
      text.indexOf("local-backend/agents/a.json"),
    );
  });

  test("a dry run lists the exclusions with their reasons", () => {
    const text = toHuman(makeReport({ dryRun: true }));
    expect(text).toContain("nothing was written");
    expect(text).toContain("home/backups — self backup");
  });

  test("import output shows remaps, the backup and a failed rollback command", () => {
    const text = toHuman(
      makeReport({
        command: "import",
        out: undefined,
        package: "C:\\tmp\\pkg.hryk",
        backupPath: "C:\\home\\backups\\pre-import.hryk",
        remapped: [
          {
            field: "sessionsByServer",
            from: "local:C:\\old",
            to: "local:C:\\new",
          },
        ],
        notRemapped: [{ field: "sessions.jsonl.project", reason: "project" }],
        rollback: {
          attempted: true,
          ok: false,
          message: "cross-volume copy failed",
          backupPath: "C:\\home\\backups\\pre-import.hryk",
        },
        failedSecrets: [
          { scope: "channel", name: "telegram:bot_token", reason: "denied" },
        ],
        warnings: ["cron lease could not be cleared"],
      }),
    );
    expect(text).toContain("Import complete: C:\\tmp\\pkg.hryk");
    expect(text).toContain("remapped   1 path(s)");
    expect(text).toContain("untouched  1 path-shaped field(s)");
    expect(text).toContain("backup     C:\\home\\backups\\pre-import.hryk");
    expect(text).toContain("ROLLBACK FAILED");
    expect(text).toContain(
      'manual recovery: haruyuki import --from "C:\\home\\backups\\pre-import.hryk" --yes',
    );
    expect(text).toContain("[channel] telegram:bot_token: denied");
    expect(text).toContain("cron lease could not be cleared");
    expect(text).not.toContain("secret-value");
  });

  test("a refusal prints the code and the message", () => {
    const text = toHuman(
      makeReport({
        ok: false,
        code: "confirm_required",
        message: "Refused: no TTY",
      }),
    );
    expect(text).toContain("Export failed (confirm_required)");
    expect(text).toContain("Refused: no TTY");
  });
});

describe("formatting helpers", () => {
  test("formatBytes switches units at 1024 and keeps bytes integral", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
    expect(formatBytes(Number.NaN)).toBe("NaN B");
  });

  test("formatDuration prints one decimal in seconds", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(-1)).toBe("0.0s");
  });
});
