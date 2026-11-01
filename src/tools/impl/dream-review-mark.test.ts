/**
 * `DreamReviewMark` (F-06 §5.10.3, checklist §3 W6).
 *
 * The tool is the only way a run can say "I reviewed this file, it is not
 * rotting" and let the end-of-run ledger drop it, so the cases pin the two
 * halves of that contract: the recorded mark is exactly what the storage
 * module reads back, and every way of weakening it (wrong context, bad
 * coverage, escaping path, missing file, empty/multi-line/over-long evidence)
 * is a refusal that writes nothing.
 *
 * `HARUYUKI_HOME` and the memory directory are fresh temp directories per case:
 * the tool writes real marks files, and no case may touch the operator's
 * harness home or a real memory repository.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS,
  getDreamReviewMarksPath,
  readReviewMarks,
} from "@/agent/dream/dream-review-marks";
import { checkPermission } from "@/permissions/checker";
import {
  DREAM_AUTO_ALLOW_TOOL_NAMES,
  isDreamRun,
} from "@/permissions/dream-run-guard";
import type { PermissionRules } from "@/permissions/types";
import {
  runOutsideRuntimeContext,
  runWithRuntimeContext,
} from "@/runtime-context";
import { serializeFunctionOnlyToolPayload } from "@/tools/model-facing-tool";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";
import { TOOLSET_CATALOG } from "@/tools/toolset-catalog";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";
import {
  type DreamReviewMarkArgs,
  type DreamReviewMarkDeps,
  dream_review_mark,
} from "./dream-review-mark";

const AGENT_ID = "agent-dream-review-mark";
const NOW = Date.parse("2026-10-31T21:40:00.000Z");
const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };
const WORKING_DIR = "/tmp/haruyuki-dream-review-mark";

let homeDir: string;
let memoryDir: string;
let previousHaruyukiHome: string | undefined;

beforeEach(async () => {
  previousHaruyukiHome = process.env.HARUYUKI_HOME;
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-review-mark-home-"));
  memoryDir = await mkdtemp(join(tmpdir(), "haruyuki-review-mark-memory-"));
  process.env.HARUYUKI_HOME = homeDir;
  await mkdir(join(memoryDir, "system"), { recursive: true });
  await mkdir(join(memoryDir, "projects"), { recursive: true });
  await writeFile(
    join(memoryDir, "system", "human.md"),
    "# Human\n\nFacts about the user.\n",
    "utf8",
  );
  await writeFile(
    join(memoryDir, "projects", "acme.md"),
    "# Acme\n\nProject notes.\n",
    "utf8",
  );
});

afterEach(async () => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  await rm(homeDir, { recursive: true, force: true });
  await rm(memoryDir, { recursive: true, force: true });
});

function metadata(overrides: Partial<DreamRunMetadata> = {}): DreamRunMetadata {
  return {
    runId: "run-from-record",
    triggerSource: "scheduled",
    agentId: AGENT_ID,
    conversationId: "conv-dream-1",
    tierPlan: ["tidy"],
    tierReached: "tidy",
    startedAt: Date.UTC(2026, 9, 30, 20, 0),
    endedAt: null,
    baselineSha: "base-sha",
    budgetTokens: 80_000,
    spentTokens: 20_000,
    timeLimitMinutes: null,
    status: "running",
    reportPath: null,
    handoff: null,
    ...overrides,
  };
}

function call(args: DreamReviewMarkArgs, deps: DreamReviewMarkDeps = {}) {
  return dream_review_mark(args, {
    agentId: AGENT_ID,
    memoryDir,
    now: NOW,
    ...deps,
  });
}

/** The production path: the tool reads the ambient dream-run context. */
function inDreamRun<T>(fn: () => T, runId = "run-live"): T {
  return runWithRuntimeContext(
    {
      agentId: AGENT_ID,
      conversationId: "conv-dream-1",
      dreamRun: true,
      dreamRunId: runId,
    },
    fn,
  );
}

describe("the recorded mark", () => {
  test("one call writes one line the storage module reads back", async () => {
    const result = await inDreamRun(() =>
      call({
        path: "  system/human.md  ",
        coverage: "content",
        evidence: "  checked the three links and the index row  ",
      }),
    );
    expect(result.status).toBe("success");
    expect(result.ok).toBe(true);
    expect(result.mark).toEqual({
      run_id: "run-live",
      path: "system/human.md",
      coverage: "content",
    });
    expect(result.content).toContain("coverage=content");
    expect(result.content).toContain("system/human.md");
    expect(result.content).toContain("run run-live");

    expect(existsSync(getDreamReviewMarksPath("run-live"))).toBe(true);
    expect(await readReviewMarks("run-live")).toEqual([
      {
        version: 1,
        runId: "run-live",
        path: "system/human.md",
        coverage: "content",
        evidence: "checked the three links and the index row",
        createdAt: NOW,
      },
    ]);
  });

  test("the description and schema carry the model-facing contract", () => {
    const definition = TOOL_DEFINITIONS.DreamReviewMark;
    if (!definition) throw new Error("DreamReviewMark is not registered");
    const payload = serializeFunctionOnlyToolPayload(
      "DreamReviewMark",
      definition.modelForm,
    );
    expect(definition.modelForm.type).toBe("function");
    expect(payload.name).toBe("DreamReviewMark");
    // "Not a todo tool; calling it means the review happened; evidence goes
    // into the index and the report."
    expect(payload.description).toContain("not a todo tool");
    expect(payload.description).toContain("Calling it **is** the");
    expect(payload.description).toContain("decay index");
    expect(payload.description).toContain("run report");
    expect(payload.parameters.required).toEqual([
      "path",
      "coverage",
      "evidence",
    ]);
    expect(payload.parameters.additionalProperties).toBe(false);
    const coverage = payload.parameters.properties?.coverage;
    expect(coverage?.enum).toEqual(["skim", "structure", "content"]);
    const evidence = payload.parameters.properties?.evidence;
    expect(evidence?.maxLength).toBe(DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS);
    expect(evidence?.minLength).toBe(1);
  });

  test("the tool is dream-only in the catalog and in the permission allowance", () => {
    // The family declaration is what a dream conversation adds; the presets
    // never list it, so an ordinary session never sees the tool at all.
    expect(DREAM_AUTO_ALLOW_TOOL_NAMES.has("DreamReviewMark")).toBe(true);
    for (const toolset of ["letta", "default", "codex"] as const) {
      expect(TOOLSET_CATALOG[toolset].tools).not.toContain("DreamReviewMark");
    }
    const decide = (
      mode: "standard" | "acceptEdits" | "strict",
      dreamRun: boolean,
      rules: PermissionRules = NO_RULES,
    ) =>
      runWithRuntimeContext({ agentId: AGENT_ID, dreamRun }, () =>
        checkPermission(
          "DreamReviewMark",
          { path: "system/human.md" },
          rules,
          WORKING_DIR,
          { mode },
          AGENT_ID,
        ),
      ).decision;
    expect(decide("acceptEdits", true)).toBe("allow");
    expect(decide("standard", true)).toBe("allow");
    expect(decide("acceptEdits", false)).toBe("ask");
    expect(decide("strict", true)).toBe("ask");
    expect(
      decide("acceptEdits", true, {
        allow: [],
        deny: ["DreamReviewMark"],
        ask: [],
      }),
    ).toBe("deny");
  });
});

describe("the dream-run gate", () => {
  const valid = {
    path: "system/human.md",
    coverage: "structure",
    evidence: "frontmatter and headings check out",
  };

  test("a direct call outside a dream run is refused and writes nothing", async () => {
    const result = await call(valid);
    expect(result.status).toBe("error");
    expect(result.ok).toBe(false);
    expect(result.mark).toBeNull();
    expect(result.content).toContain("only a dream run");
    expect(await readReviewMarks("run-live")).toEqual([]);
  });

  test("an explicit dreamRun: false is refused too", async () => {
    const result = await runWithRuntimeContext({ dreamRun: false }, () =>
      call(valid),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("only a dream run");
  });

  test("isDreamRun agrees with the runtime context the tool reads", () => {
    expect(runWithRuntimeContext({ dreamRun: true }, () => isDreamRun())).toBe(
      true,
    );
    expect(runWithRuntimeContext({ dreamRun: false }, () => isDreamRun())).toBe(
      false,
    );
    expect(runOutsideRuntimeContext(() => isDreamRun())).toBe(false);
  });
});

describe("argument validation", () => {
  const valid = {
    path: "system/human.md",
    coverage: "content" as const,
    evidence: "read the whole file",
  };

  test("coverage must be one of the three depths", async () => {
    for (const coverage of [undefined, "", "deep", 3]) {
      const result = await inDreamRun(() => call({ ...valid, coverage }));
      expect(result.status).toBe("error");
      expect(result.content).toContain("coverage");
    }
    expect(await readReviewMarks("run-live")).toEqual([]);
  });

  test("path must be a repository-relative path that exists", async () => {
    for (const path of [
      undefined,
      "",
      "/etc/passwd",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "../outside.md",
      "system/../human.md",
      ".git/config",
      "missing.md",
      "system",
    ]) {
      const result = await inDreamRun(() => call({ ...valid, path }));
      expect(result.status).toBe("error");
      expect(result.content).toContain("DreamReviewMark");
    }
    expect(await readReviewMarks("run-live")).toEqual([]);
  });

  test("a backslash path is normalized to the repository's POSIX form", async () => {
    const result = await inDreamRun(() =>
      call({ ...valid, path: "system\\human.md" }),
    );
    expect(result.status).toBe("success");
    expect(result.mark?.path).toBe("system/human.md");
    expect((await readReviewMarks("run-live"))[0]?.path).toBe(
      "system/human.md",
    );
  });

  test("evidence is required, one line, and at most 200 characters", async () => {
    for (const evidence of [
      undefined,
      "",
      "   ",
      "line one\nline two",
      "line one\rline two",
      "x".repeat(DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS + 1),
    ]) {
      const result = await inDreamRun(() => call({ ...valid, evidence }));
      expect(result.status).toBe("error");
      expect(result.content).toContain("evidence");
    }
    expect(await readReviewMarks("run-live")).toEqual([]);

    const atLimit = await inDreamRun(() =>
      call({
        ...valid,
        evidence: "y".repeat(DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS),
      }),
    );
    expect(atLimit.status).toBe("success");
    expect((await readReviewMarks("run-live"))[0]?.evidence.length).toBe(
      DREAM_REVIEW_MARK_MAX_EVIDENCE_CHARS,
    );
  });

  test("an unknown coverage or a missing file never reaches the writer", async () => {
    let calls = 0;
    const append: DreamReviewMarkDeps["append"] = async () => {
      calls += 1;
      return { ok: false, error: "should not be called" };
    };
    await inDreamRun(() => call({ ...valid, coverage: "deep" }, { append }));
    expect(calls).toBe(0);
  });
});

describe("run id resolution", () => {
  const valid = {
    path: "projects/acme.md",
    coverage: "skim",
    evidence: "purpose and pointer still correct",
  };

  test("falls back to the conversation's run record when the context has no id", async () => {
    const requested: string[] = [];
    const result = await runWithRuntimeContext(
      {
        agentId: AGENT_ID,
        conversationId: "conv-dream-1",
        dreamRun: true,
      },
      () =>
        call(valid, {
          backend: {
            retrieveConversation: async (conversationId: string) => {
              requested.push(conversationId);
              return { dream: metadata() };
            },
          },
        }),
    );
    expect(result.status).toBe("success");
    expect(result.mark?.run_id).toBe("run-from-record");
    expect(requested).toEqual(["conv-dream-1"]);
    expect((await readReviewMarks("run-from-record"))[0]?.runId).toBe(
      "run-from-record",
    );
  });

  test("no run id anywhere is an error, not a mark in a shared file", async () => {
    const result = await runWithRuntimeContext(
      { agentId: AGENT_ID, conversationId: "conv-not-a-run", dreamRun: true },
      () =>
        call(valid, {
          backend: { retrieveConversation: async () => ({}) },
        }),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("run id");
    expect(await readReviewMarks("run-from-record")).toEqual([]);
  });
});

describe("writer failures", () => {
  test("the storage refusal is passed through to the model", async () => {
    const result = await inDreamRun(() =>
      call(
        {
          path: "system/human.md",
          coverage: "content",
          evidence: "read the whole file",
        },
        {
          append: async () => ({ ok: false as const, error: "disk is full" }),
        },
      ),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("disk is full");
  });
});
