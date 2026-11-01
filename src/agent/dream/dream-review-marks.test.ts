/**
 * Dream review marks (F-06 / 46-6-Fix-A W3, design §5.10.3).
 *
 * Every case pins one promise of the per-run mark file: it lives under the
 * harness home (never the memory repository), it is one JSON line per mark,
 * a corrupt line never hides the marks a run did write, and a mark without
 * usable evidence is refused instead of recorded. `HARUYUKI_HOME` is redirected
 * to a fresh temp directory per case so nothing touches the operator's real
 * harness home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendReviewMark,
  clearReviewMarks,
  DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS,
  dreamStorageSegment,
  getDreamReviewMarksPath,
  normalizeDreamReviewPath,
  readReviewMarks,
} from "@/agent/dream/dream-review-marks";

const RUN_ID = "run-2026-11-01";
const NOW = Date.parse("2026-11-01T20:00:00.000Z");

let homeDir: string;
let previousHaruyukiHome: string | undefined;

beforeEach(async () => {
  previousHaruyukiHome = process.env.HARUYUKI_HOME;
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-marks-"));
  process.env.HARUYUKI_HOME = homeDir;
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(homeDir, { recursive: true, force: true });
});

describe("the marks file", () => {
  test("lives under the harness home, one file per run", () => {
    const path = getDreamReviewMarksPath(RUN_ID);
    expect(path).toBe(join(homeDir, "dream", "runs", RUN_ID, "marks.jsonl"));
    expect(path).not.toContain(".haruyuki");
  });

  test("sanitizes a run id that would otherwise introduce a path segment", () => {
    const runsDir = join(homeDir, "dream", "runs");
    // A slash or colon must not create extra directories: the whole id becomes
    // one segment under the runs directory.
    expect(dirname(getDreamReviewMarksPath("../evil/run:1"))).toBe(
      join(runsDir, ".._evil_run_1"),
    );
    expect(dirname(getDreamReviewMarksPath(".."))).toBe(
      join(runsDir, "unknown"),
    );
    expect(dreamStorageSegment("run:1")).toBe("run_1");
    expect(dreamStorageSegment("")).toBe("unknown");
    expect(dreamStorageSegment("..")).toBe("unknown");
  });
});

describe("appendReviewMark", () => {
  test("writes one JSON line and reads it back", async () => {
    const result = await appendReviewMark({
      runId: RUN_ID,
      path: "system/human.md",
      coverage: "content",
      evidence: "checked links and index",
      now: NOW,
    });
    expect(result.ok).toBe(true);

    const body = await readFile(getDreamReviewMarksPath(RUN_ID), "utf8");
    expect(body.endsWith("\n")).toBe(true);
    expect(body.trim().split("\n")).toHaveLength(1);

    const marks = await readReviewMarks(RUN_ID);
    expect(marks).toEqual([
      {
        version: 1,
        runId: RUN_ID,
        path: "system/human.md",
        coverage: "content",
        evidence: "checked links and index",
        createdAt: NOW,
      },
    ]);
  });

  test("normalizes a backslash path and collapses whitespace in evidence", async () => {
    const result = await appendReviewMark({
      runId: RUN_ID,
      path: "system\\project\\notes.md",
      coverage: "skim",
      evidence: "read   the\nwhole file",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mark.path).toBe("system/project/notes.md");
    expect(result.mark.evidence).toBe("read the whole file");
  });

  test("appends in call order", async () => {
    await appendReviewMark({
      runId: RUN_ID,
      path: "a.md",
      coverage: "skim",
      evidence: "first",
      now: NOW,
    });
    await appendReviewMark({
      runId: RUN_ID,
      path: "b.md",
      coverage: "structure",
      evidence: "second",
      now: NOW + 1,
    });
    const marks = await readReviewMarks(RUN_ID);
    expect(marks.map((mark) => mark.path)).toEqual(["a.md", "b.md"]);
  });

  test("refuses a path that escapes the repository", async () => {
    for (const path of [
      "/etc/passwd",
      "C:\\Users\\evil\\x.md",
      "../outside.md",
      ".git/config",
      "   ",
    ]) {
      const result = await appendReviewMark({
        runId: RUN_ID,
        path,
        coverage: "skim",
        evidence: "e",
        now: NOW,
      });
      expect(result.ok).toBe(false);
    }
    expect(await readReviewMarks(RUN_ID)).toEqual([]);
  });

  test("refuses evidence that is empty or too long", async () => {
    const empty = await appendReviewMark({
      runId: RUN_ID,
      path: "a.md",
      coverage: "skim",
      evidence: "   \n  ",
      now: NOW,
    });
    expect(empty.ok).toBe(false);

    const tooLong = await appendReviewMark({
      runId: RUN_ID,
      path: "a.md",
      coverage: "skim",
      evidence: "x".repeat(DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS + 1),
      now: NOW,
    });
    expect(tooLong.ok).toBe(false);

    const atLimit = await appendReviewMark({
      runId: RUN_ID,
      path: "a.md",
      coverage: "skim",
      evidence: "x".repeat(DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS),
      now: NOW,
    });
    expect(atLimit.ok).toBe(true);
  });

  test("refuses an unknown coverage or a missing run id", async () => {
    const badCoverage = await appendReviewMark({
      runId: RUN_ID,
      path: "a.md",
      // Deliberately outside the union: the storage layer must not trust types.
      coverage: "deep" as never,
      evidence: "e",
      now: NOW,
    });
    expect(badCoverage.ok).toBe(false);

    const badRun = await appendReviewMark({
      runId: "  ",
      path: "a.md",
      coverage: "skim",
      evidence: "e",
      now: NOW,
    });
    expect(badRun.ok).toBe(false);
  });
});

describe("readReviewMarks", () => {
  test("a missing file is no marks", async () => {
    expect(await readReviewMarks("run-that-never-wrote")).toEqual([]);
  });

  test("skips corrupt lines but keeps the good ones", async () => {
    const path = getDreamReviewMarksPath(RUN_ID);
    await mkdir(dirname(path), { recursive: true });
    const good = JSON.stringify({
      version: 1,
      runId: RUN_ID,
      path: "a.md",
      coverage: "skim",
      evidence: "ok",
      createdAt: NOW,
    });
    await writeFile(
      path,
      `${good}\nnot json\n${JSON.stringify({ version: 1 })}\n${good}\n`,
      "utf8",
    );
    const marks = await readReviewMarks(RUN_ID);
    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => mark.path === "a.md")).toBe(true);
  });
});

describe("clearReviewMarks", () => {
  test("removes the file and is a no-op afterwards", async () => {
    await appendReviewMark({
      runId: RUN_ID,
      path: "a.md",
      coverage: "skim",
      evidence: "e",
      now: NOW,
    });
    await clearReviewMarks(RUN_ID);
    expect(await readReviewMarks(RUN_ID)).toEqual([]);
    await clearReviewMarks(RUN_ID);
    expect(await readReviewMarks(RUN_ID)).toEqual([]);
  });
});

describe("normalizeDreamReviewPath", () => {
  test("normalizes separators and drops dot segments", () => {
    expect(normalizeDreamReviewPath("./system//a.md")).toBe("system/a.md");
    expect(normalizeDreamReviewPath("system\\a.md")).toBe("system/a.md");
    expect(normalizeDreamReviewPath("a.md")).toBe("a.md");
  });

  test("rejects escapes", () => {
    expect(normalizeDreamReviewPath("/abs.md")).toBeNull();
    expect(normalizeDreamReviewPath("C:/abs.md")).toBeNull();
    expect(normalizeDreamReviewPath("../up.md")).toBeNull();
    expect(normalizeDreamReviewPath("a/../../up.md")).toBeNull();
    expect(normalizeDreamReviewPath(".git/config")).toBeNull();
    expect(normalizeDreamReviewPath("")).toBeNull();
  });
});
