// src/cli/helpers/memfs-stats.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memoryBytes,
  parseGitNumstatLog,
  readMemfsStatsForDir,
} from "./memfs-stats";

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "memfs-stats-"));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
}

function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseGitNumstatLog", () => {
  test("counts commit hashes and the lines their files changed", () => {
    const log = [
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      "12\t3\tMEMORY.md",
      "0\t7\tnotes/todo.md",
      "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
      "4\t0\tpeople/ada.md",
    ].join("\n");
    expect(parseGitNumstatLog(log)).toEqual({ commits: 2, changedLines: 26 });
  });

  test("binary files and empty output contribute nothing", () => {
    const log = [
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      "-\t-\timage.png",
    ].join("\n");
    expect(parseGitNumstatLog(log)).toEqual({ commits: 1, changedLines: 0 });
    expect(parseGitNumstatLog("")).toEqual({ commits: 0, changedLines: 0 });
  });
});

describe("memoryBytes", () => {
  test("sums the files and skips the repository's own .git", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "MEMORY.md"), "hello");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "a.md"), "0123456789");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "x".repeat(1000));

    expect(await memoryBytes(root)).toBe(5 + 10);
  });

  test("a path that does not exist is zero bytes, not a throw", async () => {
    expect(await memoryBytes(join(tempRoot(), "missing"))).toBe(0);
  });
});

describe("readMemfsStatsForDir", () => {
  test("reads a real checkout: commits, changed lines, bytes", async () => {
    const root = tempRoot();
    initRepo(root);
    writeFileSync(join(root, "MEMORY.md"), "line one\nline two\n");
    commitAll(root, "initial memory");
    writeFileSync(join(root, "MEMORY.md"), "line one\nline two\nline three\n");
    commitAll(root, "add a line");

    const stats = await readMemfsStatsForDir(root);
    expect(stats?.commits7d).toBe(2);
    // Two commits: +2 lines, then +1 line.
    expect(stats?.changedLines7d).toBe(3);
    expect(stats?.totalBytes).toBe(await memoryBytes(root));
  });

  test("a directory that is not a repository has no activity to report", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "MEMORY.md"), "hello");
    expect(await readMemfsStatsForDir(root)).toBeNull();
  });

  test("a missing directory is null", async () => {
    expect(await readMemfsStatsForDir(join(tempRoot(), "nope"))).toBeNull();
  });
});
