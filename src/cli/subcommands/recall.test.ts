/**
 * `haruyuki recall <build|status|now>` — the same work as the slash command, with
 * the two differences a script can see: usage and bad arguments are exit codes, and
 * the agent is resolved from flags or the environment rather than from a session.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { runRecallSubcommand } from "@/cli/subcommands/recall";
import { resetRecallRuntime } from "@/reminders/recall-runtime";
import { settingsManager } from "@/settings-manager";
import {
  RECALL_FIXTURE_QUERY,
  withRecallFixture,
} from "@/test-utils/recall-fixture";

const noopInitialize = async () => {};

let stdout: string[];
let stderr: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  resetRecallRuntime();
  stdout = [];
  stderr = [];
  logSpy = spyOn(console, "log").mockImplementation((value) => {
    stdout.push(String(value));
  });
  errorSpy = spyOn(console, "error").mockImplementation((value) => {
    stderr.push(String(value));
  });
  testHomeDir = await mkdtemp(join(tmpdir(), "haru-recall-subcommand-"));
  process.env.HOME = testHomeDir;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  resetRecallRuntime();
  __testSetBackend(null);
  logSpy.mockRestore();
  errorSpy.mockRestore();
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
  delete process.env.HARUYUKI_AGENT_ID;
  delete process.env.AGENT_ID;
});

test("no arguments or help prints the usage and succeeds", async () => {
  expect(
    await runRecallSubcommand([], { initializeSettings: noopInitialize }),
  ).toBe(0);
  expect(stdout.join("\n")).toContain("haruyuki recall build");

  stdout = [];
  expect(
    await runRecallSubcommand(["--help"], {
      initializeSettings: noopInitialize,
    }),
  ).toBe(0);
  expect(stdout.join("\n")).toContain("haruyuki recall now");
});

test("a bad argument fails with a message on stderr", async () => {
  const code = await runRecallSubcommand(["display", "loud"], {
    initializeSettings: noopInitialize,
  });
  expect(code).toBe(1);
  expect(stderr.join("\n")).toContain("silent, summary, full");
  expect(stdout).toEqual([]);
});

test("status reports against the real store", async () => {
  await withRecallFixture(async (fixture) => {
    const code = await runRecallSubcommand(
      ["status", "--agent", fixture.agentId],
      { initializeSettings: noopInitialize, backend: fixture.backend },
    );
    expect(code).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("Recall: on");
    expect(output).toContain("conversations indexed");
  });
});

test("build indexes the store and now prints what a query finds", async () => {
  await withRecallFixture(async (fixture) => {
    process.env.HARUYUKI_AGENT_ID = fixture.agentId;

    expect(
      await runRecallSubcommand(["build"], {
        initializeSettings: noopInitialize,
        backend: fixture.backend,
      }),
    ).toBe(0);
    expect(stdout.join("\n")).toContain("Indexed");

    stdout = [];
    const code = await runRecallSubcommand(
      [
        "now",
        RECALL_FIXTURE_QUERY,
        "--conversation",
        fixture.currentConversationId,
      ],
      { initializeSettings: noopInitialize, backend: fixture.backend },
    );
    expect(code).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("Recall found");
    expect(output).toContain("每日对账");
  });
});

test("a setting can be written from a script", async () => {
  const code = await runRecallSubcommand(["display", "silent"], {
    initializeSettings: noopInitialize,
  });
  expect(code).toBe(0);
  expect(stdout.join("\n")).toContain("display silent");
});

test("a cloud backend is refused with an explanation", async () => {
  const code = await runRecallSubcommand(["status"], {
    initializeSettings: noopInitialize,
    backend: new FakeHeadlessBackend(),
  });
  expect(code).toBe(1);
  expect(stderr.join("\n")).toContain("local-backend only");
});
