/**
 * Dream report writer (F-06 M3, S4; R-5.6.1–R-5.6.3, Q-54 / Q-41).
 *
 * These run on a throwaway memory repository installed the production way —
 * `commitMemoryWrite` installs the real pre-commit hook — so "the report commit
 * passes memory validation" is tested against the same validator a real run
 * hits, not against a copy of the rules.
 *
 * Each case costs several git processes (a commit runs Bash + Node on Windows),
 * so every test carries its own budget rather than leaking one into the worker.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamNote } from "@/agent/dream/dream-notes";
import {
  appendDreamNotesSection,
  buildDreamNotesSection,
  buildDreamReportFile,
  DREAM_REPORT_INDEX_CONTENT,
  DREAM_REPORT_INDEX_PATH,
  DREAM_REPORT_NOTE_EXCERPT_CHARS,
  DREAM_REPORT_PATH,
  parseDreamNoteOutcomes,
  writeDreamReport,
} from "@/agent/dream/dream-report";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { validateMemoryFileFrontmatter } from "@/memory-frontmatter";
import { initGitRepo, type TempGitRepo } from "@/test-utils/temp-git-repo";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

const TEST_TIMEOUT_MS = 60_000;
const AGENT_ID = "agent-dream-report";
const REPO_MEMORY_MD = "# Memory\n\n- [maintenance](./maintenance/MEMORY.md)\n";
const PERSONA = "---\nname: Persona\ndescription: Identity\n---\nPersistent.\n";

let root: string;
let memoryDir: string;
let repo: TempGitRepo | undefined;
let originalHome: string | undefined;
let originalLocalBackend: string | undefined;
let originalLettaDir: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HARUYUKI_HOME;
  originalLocalBackend = process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  originalLettaDir = process.env.LETTA_LOCAL_BACKEND_DIR;
  root = await mkdtemp(join(tmpdir(), "haruyuki-dream-report-"));
  process.env.HARUYUKI_HOME = root;
  delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
  memoryDir = getScopedMemoryFilesystemRoot(AGENT_ID);
  repo = undefined;
});

/**
 * Build the memory repository the way a real agent's would look: a seeded root
 * `MEMORY.md`, a persona file, and one commit. Called inside the test (not a
 * hook) so the per-test budget covers the git processes.
 */
function seedRepository(): TempGitRepo {
  mkdirSync(memoryDir, { recursive: true });
  const seeded = initGitRepo(memoryDir);
  writeFileSync(join(memoryDir, "MEMORY.md"), REPO_MEMORY_MD);
  writeFileSync(join(memoryDir, "persona.md"), PERSONA);
  seeded.git("add", "-A");
  seeded.git("commit", "--no-verify", "-m", "seed memory");
  repo = seeded;
  return seeded;
}

function repoOrThrow(): TempGitRepo {
  if (repo === undefined) throw new Error("repository not seeded");
  return repo;
}

afterEach(async () => {
  repo?.cleanup();
  await rm(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
  if (originalLocalBackend === undefined) {
    delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  } else {
    process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL = originalLocalBackend;
  }
  if (originalLettaDir === undefined)
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = originalLettaDir;
});

function metadata(overrides: Partial<DreamRunMetadata> = {}): DreamRunMetadata {
  return {
    runId: "run-report-1",
    triggerSource: "idle",
    agentId: AGENT_ID,
    conversationId: "conv-dream-1",
    tierPlan: ["tidy", "think"],
    tierReached: "tidy",
    startedAt: Date.UTC(2026, 9, 30, 20, 0),
    endedAt: Date.UTC(2026, 9, 30, 20, 40),
    baselineSha: "base",
    budgetTokens: 100_000,
    spentTokens: 40_000,
    timeLimitMinutes: null,
    status: "succeeded",
    reportPath: null,
    handoff: "Continue with think; the acme notes are half merged.",
    ...overrides,
  };
}

function reportFile(): string {
  return join(memoryDir, ...DREAM_REPORT_PATH.split("/"));
}

function indexPath(): string {
  return join(memoryDir, ...DREAM_REPORT_INDEX_PATH.split("/"));
}

describe("buildDreamReportFile", () => {
  test("adds v2 frontmatter to the agent's body", () => {
    const content = buildDreamReportFile(
      metadata(),
      "I tidied projects and merged two notes.",
      Date.UTC(2026, 9, 31, 1, 0),
    );
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: Dream report 2026-10-30");
    expect(content).toContain(
      "description: What the 2026-10-30 dream run changed",
    );
    expect(content).toContain("I tidied projects and merged two notes.");
    expect(
      validateMemoryFileFrontmatter({
        path: DREAM_REPORT_PATH,
        content,
        previousContent: null,
        format: "memfs-v2",
      }),
    ).toEqual([]);
  });

  test("writes a fallback body for a run that produced none", () => {
    const content = buildDreamReportFile(
      metadata({ status: "budget_exhausted", tierReached: null }),
      undefined,
      Date.UTC(2026, 9, 31, 1, 0),
    );
    expect(content).toContain("No report body was produced");
    expect(content).toContain("status: budget_exhausted");
    expect(content).toContain("Where to continue");
    expect(content).toContain("Continue with think");
    expect(
      validateMemoryFileFrontmatter({
        path: DREAM_REPORT_PATH,
        content,
        previousContent: null,
        format: "memfs-v2",
      }),
    ).toEqual([]);
  });
});

describe("writeDreamReport", () => {
  test(
    "writes a valid report plus its directory index and commits them",
    async () => {
      seedRepository();
      const result = await writeDreamReport({
        agentId: AGENT_ID,
        conversationId: "conv-dream-1",
        metadata: metadata(),
        body: "## What changed\n\n- merged two project notes",
      });
      expect(result).toEqual({
        reportPath: DREAM_REPORT_PATH,
        committed: true,
      });

      const report = readFileSync(reportFile(), "utf8");
      expect(
        validateMemoryFileFrontmatter({
          path: DREAM_REPORT_PATH,
          content: report,
          previousContent: null,
          format: "memfs-v2",
        }),
      ).toEqual([]);

      // The report directory needs an index to pass memory validation; R-5.6.2
      // lets the harness create it.
      const index = readFileSync(indexPath(), "utf8");
      expect(index).toBe(DREAM_REPORT_INDEX_CONTENT);
      expect(index.startsWith("---")).toBe(false);

      expect(repoOrThrow().git("log", "-1", "--pretty=%s")).toBe(
        "dream(report): run-report-1",
      );
      const committedPaths = repoOrThrow()
        .git("show", "--name-only", "--pretty=format:")
        .split("\n")
        .filter(Boolean)
        .sort();
      expect(committedPaths).toEqual(
        [DREAM_REPORT_PATH, DREAM_REPORT_INDEX_PATH].sort(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keeps an existing directory index untouched",
    async () => {
      seedRepository();
      mkdirSync(join(memoryDir, "maintenance"), { recursive: true });
      const customIndex = "# Maintenance\n\n- something the agent wrote\n";
      writeFileSync(indexPath(), customIndex);
      repoOrThrow().git("add", "-A");
      repoOrThrow().git("commit", "--no-verify", "-m", "agent index");

      await writeDreamReport({
        agentId: AGENT_ID,
        conversationId: "conv-dream-1",
        metadata: metadata(),
        body: "body",
      });
      expect(readFileSync(indexPath(), "utf8")).toBe(customIndex);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "commits alone: unrelated working-tree changes stay out of the report commit",
    async () => {
      seedRepository();
      // A dirty tracked file and an untracked file, both in the working tree
      // but not in the index. If the report commit swept the working tree, they
      // would ride along.
      writeFileSync(join(memoryDir, "persona.md"), `${PERSONA}\nDirty.\n`);
      writeFileSync(join(memoryDir, "scratch.md"), "untracked\n");

      const result = await writeDreamReport({
        agentId: AGENT_ID,
        conversationId: "conv-dream-1",
        metadata: metadata(),
        body: "body",
      });
      expect(result.committed).toBe(true);

      const committed = repoOrThrow()
        .git("show", "--name-only", "--pretty=format:")
        .split("\n")
        .filter(Boolean)
        .sort();
      expect(committed).toEqual(
        [DREAM_REPORT_PATH, DREAM_REPORT_INDEX_PATH].sort(),
      );
      const status = repoOrThrow().git("status", "--porcelain");
      expect(status).toContain("M persona.md");
      expect(status).toContain("?? scratch.md");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "is idempotent: the same report does not create a second commit",
    async () => {
      seedRepository();
      const input = {
        agentId: AGENT_ID,
        conversationId: "conv-dream-1",
        metadata: metadata(),
        body: "same body",
      };
      const first = await writeDreamReport(input);
      expect(first.committed).toBe(true);
      const head = repoOrThrow().git("rev-parse", "HEAD");

      const second = await writeDreamReport(input);
      expect(second).toEqual({
        reportPath: DREAM_REPORT_PATH,
        committed: false,
      });
      expect(repoOrThrow().git("rev-parse", "HEAD")).toBe(head);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "returns no report when the memory directory is not a git repository",
    async () => {
      const plainDir = await mkdtemp(
        join(tmpdir(), "haruyuki-dream-report-plain-"),
      );
      process.env.HARUYUKI_HOME = plainDir;
      const result = await writeDreamReport({
        agentId: "agent-plain",
        conversationId: "conv-plain",
        metadata: metadata({ agentId: "agent-plain" }),
        body: "body",
      });
      expect(result).toEqual({ reportPath: null, committed: false });
      expect(
        existsSync(join(plainDir, "agents", "agent-plain", "memory")),
      ).toBe(false);
      await rm(plainDir, { recursive: true, force: true });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("writeDreamReport under a stricter memory limit", () => {
  test(
    "fits the body inside .memfs.config.json maxFileCharacters",
    async () => {
      seedRepository();
      writeFileSync(
        join(memoryDir, ".memfs.config.json"),
        JSON.stringify({ version: 1, maxFileCharacters: 900 }, null, 2),
      );
      repoOrThrow().git("add", "-A");
      repoOrThrow().git("commit", "--no-verify", "-m", "strict limits");

      const result = await writeDreamReport({
        agentId: AGENT_ID,
        conversationId: "conv-dream-1",
        metadata: metadata(),
        body: "word ".repeat(2_000),
      });
      expect(result.committed).toBe(true);
      const content = readFileSync(reportFile(), "utf8");
      expect(content.length).toBeLessThanOrEqual(900);
      expect(content).toContain("Report truncated at");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── W12: note consumption on the report side ──────────────────────────────

const CLAIMED_IDS = ["note-aaaaaaaa", "note-bbbbbbbb", "note-cccccccc"];

function note(
  id: string,
  text = `text for ${id}`,
  createdAt = Date.UTC(2026, 9, 31, 12, 0),
): DreamNote {
  return {
    version: 1,
    id,
    createdAt,
    author: "user",
    text,
    source: {},
  };
}

describe("parseDreamNoteOutcomes", () => {
  test("reads the three answer words from a `## Notes 回应` list", () => {
    const outcomes = parseDreamNoteOutcomes(
      [
        "## Notes 回应",
        "- note-aaaaaaaa: applied (merged the two notes)",
        "- note-bbbbbbbb: not-applicable — the file no longer exists",
        "- note-cccccccc: needs-authorization, the user must confirm",
      ].join("\n"),
      CLAIMED_IDS,
    );
    expect(outcomes).toEqual({
      "note-aaaaaaaa": "applied",
      "note-bbbbbbbb": "not-applicable",
      "note-cccccccc": "needs-authorization",
    });
  });

  test("is tolerant about spacing, case and answer-before-id order", () => {
    const outcomes = parseDreamNoteOutcomes(
      [
        "**note-aaaaaaaa** applied",
        "note-bbbbbbbb: NOT APPLICABLE",
        "needs authorization — note-cccccccc",
      ].join("\n"),
      CLAIMED_IDS,
    );
    expect(outcomes).toEqual({
      "note-aaaaaaaa": "applied",
      "note-bbbbbbbb": "not-applicable",
      "note-cccccccc": "needs-authorization",
    });
  });

  test("an unparsed or unknown answer is left out (the caller keeps it)", () => {
    const outcomes = parseDreamNoteOutcomes(
      [
        "- note-aaaaaaaa: looked at it, will see next time",
        "- note-dddddddd: applied",
        "- no id on this line: applied",
      ].join("\n"),
      CLAIMED_IDS,
    );
    expect(outcomes).toEqual({});
  });
});

describe("buildDreamNotesSection", () => {
  test("lists every claimed note with its answer and status", () => {
    const section = buildDreamNotesSection({
      notes: CLAIMED_IDS.map((id) => note(id)),
      outcomes: {
        "note-aaaaaaaa": "applied",
        "note-bbbbbbbb": "not-applicable",
      },
      settled: true,
    });
    expect(section.startsWith("## Notes\n")).toBe(true);
    expect(section).toContain("settled the queue");
    expect(section).toContain("- note-aaaaaaaa: applied");
    expect(section).toContain("- note-bbbbbbbb: not-applicable");
    // Claimed but unanswered: kept, and the section says so.
    expect(section).toContain("- note-cccccccc: no answer (kept)");
  });

  test("an unsettled run says everything stays queued", () => {
    const section = buildDreamNotesSection({
      notes: [note("note-aaaaaaaa")],
      outcomes: {},
      settled: false,
    });
    expect(section).toContain("did not reach a settled state");
    expect(section).toContain("stays queued");
  });

  test("keeps each note on one line and caps the excerpt", () => {
    const long = "x".repeat(DREAM_REPORT_NOTE_EXCERPT_CHARS + 50);
    const section = buildDreamNotesSection({
      notes: [note("note-aaaaaaaa", `${long}\nsecond line`)],
      outcomes: { "note-aaaaaaaa": "applied" },
      settled: true,
    });
    expect(section).not.toContain("second line");
    expect(section).toContain("…");
    const noteLine = section
      .split("\n")
      .find((line) => line.startsWith("- note-aaaaaaaa"));
    expect(noteLine).toBeDefined();
    expect((noteLine ?? "").length).toBeLessThan(
      DREAM_REPORT_NOTE_EXCERPT_CHARS + 40,
    );
  });
});

describe("appendDreamNotesSection", () => {
  test("appends the section before the report is committed", () => {
    const body = "## 概览\n\n- tidied\n";
    const combined = appendDreamNotesSection(
      body,
      buildDreamNotesSection({
        notes: [note("note-aaaaaaaa")],
        outcomes: { "note-aaaaaaaa": "applied" },
        settled: true,
      }),
    );
    expect(combined.startsWith("## 概览")).toBe(true);
    expect(combined).toContain("## Notes");
    expect(combined.endsWith("\n")).toBe(true);
    expect(combined).not.toContain("\n\n\n");
  });
});
