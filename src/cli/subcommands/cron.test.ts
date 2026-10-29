import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { runCronSubcommand } from "@/cli/subcommands/cron";
import { getTask } from "@/cron";
import { settingsManager } from "@/settings-manager";

const originalFetch = globalThis.fetch;
const originalInitialize = settingsManager.initialize;
const originalGetSettingsWithSecureTokens =
  settingsManager.getSettingsWithSecureTokens;
const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalBaseUrl = process.env.LETTA_BASE_URL;
const originalApiKey = process.env.LETTA_API_KEY;
const originalRuntimeDeviceId =
  process.env.HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID;
const originalConversationId = process.env.HARUYUKI_CONVERSATION_ID;
const originalHaruyukiHome = process.env.HARUYUKI_HOME;

const addArgs = [
  "add",
  "--name",
  "boundary-test",
  "--description",
  "exercise schedule creation",
  "--prompt",
  "do the scheduled work",
  "--every",
  "5m",
  "--agent",
  "agent-cloud-test",
  "--conversation",
  "conversation-test",
];

function withoutConversationArgument(args: string[]): string[] {
  const index = args.indexOf("--conversation");
  if (index < 0) return [...args];
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Schedules are device-local now, so no test here should reach the network at
 * all. Any request is recorded and answered with a 500 so a Cloud call that
 * creeps back into the local path fails loudly instead of passing silently.
 */
function installCloudApiTripwire() {
  const requests: Array<{
    method: string;
    pathname: string;
    body: Record<string, unknown> | undefined;
  }> = [];

  globalThis.fetch = mock(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      method,
      pathname: url.pathname,
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    });

    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;

  return requests;
}

beforeEach(() => {
  setConfiguredBackendMode("api");
  process.env.LETTA_BASE_URL = "https://example.test";
  process.env.LETTA_API_KEY = "test-key";
  delete process.env.HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID;
  delete process.env.HARUYUKI_CONVERSATION_ID;
  settingsManager.initialize = mock(
    async () => {},
  ) as typeof settingsManager.initialize;
  settingsManager.getSettingsWithSecureTokens = mock(async () => ({
    env: {
      LETTA_BASE_URL: "https://example.test",
      LETTA_API_KEY: "test-key",
    },
  })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
  settingsManager.getOrCreateDeviceId = mock(
    () => "device-persisted",
  ) as typeof settingsManager.getOrCreateDeviceId;
  console.log = mock(() => {});
  console.error = mock(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  settingsManager.initialize = originalInitialize;
  settingsManager.getSettingsWithSecureTokens =
    originalGetSettingsWithSecureTokens;
  settingsManager.getOrCreateDeviceId = originalGetOrCreateDeviceId;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  setConfiguredBackendMode("api");

  for (const [key, value] of [
    ["LETTA_BASE_URL", originalBaseUrl],
    ["LETTA_API_KEY", originalApiKey],
    ["HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID", originalRuntimeDeviceId],
    ["HARUYUKI_CONVERSATION_ID", originalConversationId],
    ["HARUYUKI_HOME", originalHaruyukiHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("cron add execution targeting", () => {
  test("local schedules default to a new conversation per fire and ignore ambient conversation state", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-conversation-test-"));
    process.env.HARUYUKI_HOME = home;
    process.env.HARUYUKI_CONVERSATION_ID = "ambient-conversation";
    installCloudApiTripwire();
    const logs: string[] = [];
    console.log = mock((line: string) => {
      logs.push(String(line));
    });

    try {
      expect(
        await runCronSubcommand(withoutConversationArgument(addArgs)),
      ).toBe(0);

      const output = JSON.parse(logs.join("")) as Record<string, unknown>;
      expect(output.conversation_id).toBe("new");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--conversation self captures the current conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-self-test-"));
    process.env.HARUYUKI_HOME = home;
    process.env.HARUYUKI_CONVERSATION_ID = "current-conversation";
    installCloudApiTripwire();
    const logs: string[] = [];
    console.log = mock((line: string) => logs.push(String(line)));

    try {
      expect(
        await runCronSubcommand([
          ...withoutConversationArgument(addArgs),
          "--conversation",
          "self",
        ]),
      ).toBe(0);

      const output = JSON.parse(logs.join("")) as Record<string, unknown>;
      expect(output.conversation_id).toBe("current-conversation");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--conversation self fails without a current conversation", async () => {
    const requests = installCloudApiTripwire();
    const errors: string[] = [];
    console.error = mock((line: string) => errors.push(String(line)));

    expect(
      await runCronSubcommand([
        ...withoutConversationArgument(addArgs),
        "--conversation",
        "self",
      ]),
    ).toBe(1);

    expect(errors).toContain(
      "Error: --conversation self requires an active conversation (HARUYUKI_CONVERSATION_ID is not set).",
    );
    expect(requests).toHaveLength(0);
  });

  test("API-backend local execution creates a local schedule without calling a schedule API", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-local-environment-"));
    process.env.HARUYUKI_HOME = home;
    process.env.HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID = "registered-device";
    const requests = installCloudApiTripwire();
    const logs: string[] = [];
    console.log = mock((line: string) => logs.push(String(line)));

    try {
      expect(await runCronSubcommand(addArgs)).toBe(0);
      expect(requests).toHaveLength(0);
      expect(JSON.parse(logs.join(""))).toMatchObject({ runner: "local" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--runner is no longer accepted", async () => {
    const requests = installCloudApiTripwire();
    expect(await runCronSubcommand([...addArgs, "--runner", "cloud"])).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("rejects --computer without touching the schedule API", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-target-test-"));
    process.env.HARUYUKI_HOME = home;
    const requests = installCloudApiTripwire();
    try {
      expect(
        await runCronSubcommand([...addArgs, "--computer", "device-explicit"]),
      ).toBe(1);
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("unregistered local execution still creates a local schedule", async () => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-local-test-"));
    process.env.HARUYUKI_HOME = home;
    process.env.HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID = "unregistered-device";
    const requests = installCloudApiTripwire();
    const logs: string[] = [];
    console.log = mock((line: string) => logs.push(String(line)));

    try {
      expect(await runCronSubcommand(addArgs)).toBe(0);
      expect(requests).toHaveLength(0);
      expect(JSON.parse(logs.join(""))).toMatchObject({ runner: "local" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cron add F-05 v2 fields (R-5.12.6)", () => {
  type AddOutcome = {
    code: number;
    output: Record<string, unknown>;
    stored: ReturnType<typeof getTask> | undefined;
    errors: string[];
  };

  async function runAdd(args: string[]): Promise<AddOutcome> {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-v2-test-"));
    process.env.HARUYUKI_HOME = home;
    installCloudApiTripwire();
    const logs: string[] = [];
    const errors: string[] = [];
    console.log = mock((line: string) => logs.push(String(line)));
    console.error = mock((line: string) => errors.push(String(line)));

    try {
      const code = await runCronSubcommand(args);
      const output =
        logs.length > 0
          ? (JSON.parse(logs.join("")) as Record<string, unknown>)
          : {};
      const stored =
        typeof output.id === "string" ? getTask(output.id) : undefined;
      return { code, output, stored, errors };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("a command task stores its payload, tier and tuning fields", async () => {
    const { code, output, stored } = await runAdd([
      "add",
      "--name",
      "nightly-reflect",
      "--description",
      "refresh memory",
      "--type",
      "command",
      "--command",
      "reflect",
      "--cron",
      "0 3 * * *",
      "--agent",
      "agent-f05",
      "--conversation",
      "conversation-test",
      "--permission",
      "acceptEdits",
      "--no-catch-up",
      "--timeout",
      "5",
      "--wait",
      "2",
    ]);

    expect(code).toBe(0);
    expect(output.type).toBe("command");
    expect(output.permission).toBe("acceptEdits");
    expect(output.catch_up).toBe(false);
    expect(output.timeout_minutes).toBe(5);
    expect(output.wait_minutes).toBe(2);
    expect(stored?.type).toBe("command");
    expect(stored?.payload).toBe("reflect");
    expect(stored?.permission).toBe("acceptEdits");
  });

  test("a plain prompt task keeps the v2 defaults", async () => {
    const { code, output, stored } = await runAdd(addArgs);

    expect(code).toBe(0);
    expect(output.type).toBe("prompt");
    expect(output.permission).toBe("unrestricted");
    expect(output.catch_up).toBe(false);
    expect(output.timeout_minutes).toBe(30);
    expect(output.wait_minutes).toBe(10);
    expect(stored?.target).toEqual({
      kind: "existing",
      conversation_id: "conversation-test",
    });
  });

  test("--hidden marks a fresh conversation as hidden", async () => {
    const { code, output } = await runAdd([
      "add",
      "--name",
      "hidden-digest",
      "--description",
      "hidden per fire",
      "--prompt",
      "summarise the day",
      "--every",
      "1d",
      "--agent",
      "agent-f05",
      "--hidden",
    ]);

    expect(code).toBe(0);
    expect(output.target).toEqual({ kind: "new", hidden: true });
  });

  test("--hidden is refused when the target is an existing conversation", async () => {
    const { code, errors } = await runAdd([...addArgs, "--hidden"]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--hidden/--visible");
  });

  test("rejects an unknown permission tier and a bad --timeout", async () => {
    const badTier = await runAdd([...addArgs, "--permission", "full"]);
    expect(badTier.code).toBe(1);
    expect(badTier.errors.join("\n")).toContain("--permission");

    const badTimeout = await runAdd([...addArgs, "--timeout", "soon"]);
    expect(badTimeout.code).toBe(1);
    expect(badTimeout.errors.join("\n")).toContain("--timeout");
  });

  test("a command task without --command is refused", async () => {
    const { code, errors } = await runAdd([...addArgs, "--type", "command"]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--command");
  });

  test("--wait 0 is accepted and stored (M5 #7)", async () => {
    const { code, output, stored } = await runAdd([...addArgs, "--wait", "0"]);

    expect(code).toBe(0);
    expect(output.wait_minutes).toBe(0);
    expect(stored?.wait_minutes).toBe(0);
  });

  test("an unknown --command is refused at creation time (M5 #8)", async () => {
    const { code, output, errors } = await runAdd([
      "add",
      "--name",
      "bad-command",
      "--description",
      "unknown command body",
      "--type",
      "command",
      "--command",
      "compact-all",
      "--cron",
      "0 3 * * *",
      "--agent",
      "agent-f05",
      "--conversation",
      "conversation-test",
    ]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--command must be compact or reflect");
    expect(output.id).toBeUndefined();
  });

  test("the success copy names the autostart timer host (M5 #10)", async () => {
    const { code, errors } = await runAdd(addArgs);

    expect(code).toBe(0);
    const message = errors.join("\n");
    expect(message).toContain("autostart timer host");
    expect(message).not.toContain("only fires while");
  });
});

describe("cron store diagnostics", () => {
  async function runAgainstStore(content: string): Promise<{
    code: number;
    errors: string[];
  }> {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-store-test-"));
    process.env.HARUYUKI_HOME = home;
    writeFileSync(join(home, "schedules.json"), content, "utf-8");
    const errors: string[] = [];
    console.error = mock((line: string) => errors.push(String(line)));
    try {
      return { code: await runCronSubcommand(["list"]), errors };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("a corrupt store prints the message without a stack (P0-2)", async () => {
    const { code, errors } = await runAgainstStore('{"version":2,"tasks":[');
    const text = errors.join("\n");

    expect(code).toBe(1);
    expect(text).toContain("is not a valid schedule file");
    expect(text).not.toContain("    at ");
  });

  test("a store from a newer build prints its version diagnostic", async () => {
    const { code, errors } = await runAgainstStore(
      '{"version":99,"scheduler_owner":null,"tasks":[]}',
    );
    const text = errors.join("\n");

    expect(code).toBe(1);
    expect(text).toContain("version 99");
    expect(text).not.toContain("    at ");
  });
});
