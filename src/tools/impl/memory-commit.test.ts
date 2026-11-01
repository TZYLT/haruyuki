/**
 * `MemoryCommit` (F-06 Q-13).
 *
 * Two things must hold: the tool commits only inside the calling agent's memory
 * repository (refusing absolute paths, `..`, `.` and `.git`), and a commit is
 * possible without a shell so an `acceptEdits` dream run can persist its work.
 * The permission half lives in `permissions/checker.ts` and is covered by
 * `permissions/dream-tool-allowance.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { DeterministicPongExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import {
  buildMemoryCommitMessage,
  MEMORY_COMMIT_MAX_PATHS,
  MEMORY_COMMIT_MAX_REASON_CHARS,
  memory_commit,
  normalizeMemoryCommitPath,
} from "@/tools/impl/memory-commit";

const PERSONA = "---\nname: Persona\ndescription: Identity\n---\nPersistent.\n";
const TEST_TIMEOUT_MS = 60_000;

const repos: TempGitRepo[] = [];
let storageRoot: string | undefined;

afterEach(async () => {
  __testSetBackend(null);
  for (const repo of repos.splice(0)) repo.cleanup();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  storageRoot = undefined;
});

async function setup(): Promise<{
  repo: TempGitRepo;
  deps: Parameters<typeof memory_commit>[1];
}> {
  const repo = createTempGitRepo("haruyuki-memory-commit-");
  repos.push(repo);
  repo.git("config", "user.name", "Test Agent");
  repo.git("config", "user.email", "test@example.com");
  writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\n");
  writeFileSync(join(repo.dir, "persona.md"), PERSONA);
  repo.git("add", "-A");
  repo.git("commit", "--no-verify", "-m", "seed memory");

  storageRoot = await mkdtemp(join(tmpdir(), "haruyuki-memory-commit-store-"));
  __testSetBackend(
    new LocalBackend({
      storageDir: storageRoot,
      executor: new DeterministicPongExecutor(),
      memfsEnabled: false,
    }),
  );

  return {
    repo,
    deps: {
      agentId: "agent-memory-commit",
      agentName: "Dream Test",
      memoryDir: repo.dir,
    },
  };
}

describe("normalizeMemoryCommitPath", () => {
  test("keeps repository-relative paths and normalizes separators", () => {
    expect(normalizeMemoryCommitPath("MEMORY.md")).toBe("MEMORY.md");
    expect(normalizeMemoryCommitPath("projects\\acme\\notes.md")).toBe(
      "projects/acme/notes.md",
    );
    expect(normalizeMemoryCommitPath("  notes.md  ")).toBe("notes.md");
  });

  test("refuses paths that could escape the memory repository", () => {
    expect(normalizeMemoryCommitPath("../outside.md")).toBeNull();
    expect(normalizeMemoryCommitPath("/etc/passwd")).toBeNull();
    expect(normalizeMemoryCommitPath("C:\\Users\\x")).toBeNull();
    expect(normalizeMemoryCommitPath("./notes.md")).toBeNull();
    expect(normalizeMemoryCommitPath("projects/../notes.md")).toBeNull();
    expect(normalizeMemoryCommitPath("a//b.md")).toBeNull();
    expect(normalizeMemoryCommitPath(".git/config")).toBeNull();
    expect(normalizeMemoryCommitPath("projects/.GIT/hooks")).toBeNull();
    expect(normalizeMemoryCommitPath("")).toBeNull();
    expect(normalizeMemoryCommitPath(42)).toBeNull();
  });
});

describe("memory_commit argument validation", () => {
  test("refuses an empty or malformed reason", async () => {
    const { deps } = await setup();
    expect(
      (await memory_commit({ reason: "", paths: ["MEMORY.md"] }, deps)).status,
    ).toBe("error");
    expect(
      (
        await memory_commit(
          { reason: "two\nlines", paths: ["MEMORY.md"] },
          deps,
        )
      ).status,
    ).toBe("error");
    expect(
      (
        await memory_commit(
          {
            reason: "x".repeat(MEMORY_COMMIT_MAX_REASON_CHARS + 1),
            paths: ["MEMORY.md"],
          },
          deps,
        )
      ).status,
    ).toBe("error");
  });

  test("refuses an empty or oversized path list", async () => {
    const { deps } = await setup();
    expect((await memory_commit({ reason: "x", paths: [] }, deps)).status).toBe(
      "error",
    );
    expect(
      (
        await memory_commit(
          {
            reason: "x",
            paths: Array.from(
              { length: MEMORY_COMMIT_MAX_PATHS + 1 },
              (_, i) => `notes-${i}.md`,
            ),
          },
          deps,
        )
      ).status,
    ).toBe("error");
    expect(
      (await memory_commit({ reason: "x", paths: ["../escape.md"] }, deps))
        .status,
    ).toBe("error");
  });

  test("refuses a NUL byte in a path instead of throwing", async () => {
    const { deps } = await setup();
    const result = await memory_commit(
      { reason: "x", paths: ["notes.md\0hidden"] },
      deps,
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("invalid path");
  });

  test("refuses a directory that is not a git repository", async () => {
    const pristine = await mkdtemp(
      join(tmpdir(), "haruyuki-memory-commit-bare-"),
    );
    try {
      const result = await memory_commit(
        { reason: "x", paths: ["MEMORY.md"] },
        { agentId: "agent-a", memoryDir: pristine },
      );
      expect(result.status).toBe("error");
      expect(result.content).toContain("not a git repository");
    } finally {
      await rm(pristine, { recursive: true, force: true });
    }
  });
});

describe("memory_commit execution", () => {
  test(
    "commits the given paths without a shell",
    async () => {
      const { repo, deps } = await setup();
      writeFileSync(join(repo.dir, "persona.md"), `${PERSONA}More.\n`);

      const result = await memory_commit(
        { reason: "Update persona notes", paths: ["persona.md"] },
        deps,
      );

      expect(result.status).toBe("success");
      expect(result.content).toContain("Committed");
      expect(repo.git("log", "-1", "--pretty=%s")).toBe("Update persona notes");
      expect(repo.git("status", "--porcelain")).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports a no-op instead of failing when nothing changed",
    async () => {
      const { deps } = await setup();
      const result = await memory_commit(
        { reason: "Nothing changed", paths: ["MEMORY.md"] },
        deps,
      );
      expect(result.status).toBe("success");
      expect(result.content).toContain("Nothing to commit");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "commits only the named paths, leaving other edits uncommitted",
    async () => {
      const { repo, deps } = await setup();
      writeFileSync(join(repo.dir, "persona.md"), `${PERSONA}More.\n`);
      writeFileSync(
        join(repo.dir, "notes.md"),
        "---\nname: Notes\ndescription: Scratch\n---\nnot committed\n",
      );

      const result = await memory_commit(
        { reason: "Update persona only", paths: ["persona.md"] },
        deps,
      );
      expect(result.status).toBe("success");
      const status = repo.git("status", "--porcelain");
      expect(status).toContain("?? notes.md");
      expect(status).not.toContain("persona.md");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("buildMemoryCommitMessage", () => {
  test("leaves an ordinary session's reason alone", () => {
    expect(buildMemoryCommitMessage("Update persona notes", undefined)).toBe(
      "Update persona notes",
    );
    // A model-written prefix is only meaningful inside a dream run.
    expect(buildMemoryCommitMessage("dream(tidy): x", undefined)).toBe(
      "dream(tidy): x",
    );
  });

  test("adds the tier prefix and strips a model-written one", () => {
    for (const tier of ["tidy", "think", "task", "wander"] as const) {
      expect(buildMemoryCommitMessage("Update persona notes", tier)).toBe(
        `dream(${tier}): Update persona notes`,
      );
    }
    expect(buildMemoryCommitMessage("dream(think): Update notes", "tidy")).toBe(
      "dream(tidy): Update notes",
    );
    expect(
      buildMemoryCommitMessage("Dream(report): a doubled prefix", "wander"),
    ).toBe("dream(wander): a doubled prefix");
  });
});

describe("memory_commit inside a dream run", () => {
  test(
    "prefixes the final commit message with the runtime tier",
    async () => {
      const { repo, deps } = await setup();
      writeFileSync(join(repo.dir, "persona.md"), `${PERSONA}Tidied.\n`);

      const result = await runWithRuntimeContext({ dreamTier: "tidy" }, () =>
        memory_commit(
          { reason: "Update persona notes", paths: ["persona.md"] },
          deps,
        ),
      );

      expect(result.status).toBe("success");
      expect(result.content).toContain("dream(tidy): Update persona notes");
      expect(repo.git("log", "-1", "--pretty=%s")).toBe(
        "dream(tidy): Update persona notes",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "does not double a prefix the model already wrote",
    async () => {
      const { repo, deps } = await setup();
      writeFileSync(join(repo.dir, "persona.md"), `${PERSONA}Prefixed.\n`);

      await runWithRuntimeContext({ dreamTier: "tidy" }, () =>
        memory_commit(
          {
            reason: "dream(think): Update persona notes",
            paths: ["persona.md"],
          },
          deps,
        ),
      );

      expect(repo.git("log", "-1", "--pretty=%s")).toBe(
        "dream(tidy): Update persona notes",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "applies the 200-character limit to the final, prefixed message",
    async () => {
      const { deps } = await setup();
      // Fits on its own, not once `dream(tidy): ` is added.
      const reason = "x".repeat(MEMORY_COMMIT_MAX_REASON_CHARS - 5);

      const ordinary = await memory_commit(
        { reason, paths: ["MEMORY.md"] },
        deps,
      );
      expect(ordinary.status).toBe("success");

      const dream = await runWithRuntimeContext({ dreamTier: "tidy" }, () =>
        memory_commit({ reason, paths: ["MEMORY.md"] }, deps),
      );
      expect(dream.status).toBe("error");
      expect(dream.content).toContain(
        `the limit is ${MEMORY_COMMIT_MAX_REASON_CHARS}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the prefix does not leak into a later ordinary commit",
    async () => {
      const { repo, deps } = await setup();
      writeFileSync(join(repo.dir, "persona.md"), `${PERSONA}Dreamed.\n`);
      await runWithRuntimeContext({ dreamTier: "tidy" }, () =>
        memory_commit({ reason: "Dream edit", paths: ["persona.md"] }, deps),
      );

      writeFileSync(join(repo.dir, "persona.md"), `${PERSONA}Ordinary.\n`);
      const later = await memory_commit(
        { reason: "Ordinary edit", paths: ["persona.md"] },
        deps,
      );
      expect(later.status).toBe("success");
      expect(repo.git("log", "-1", "--pretty=%s")).toBe("Ordinary edit");
    },
    TEST_TIMEOUT_MS,
  );
});
