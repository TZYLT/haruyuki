import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import {
  __testSetBackend,
  type Backend,
  type ConversationUpdateBody,
} from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  spawnWithLauncher,
  startShellProcess,
} from "@/tools/impl/shell-runner";
import { setConsoleRepairHandler } from "@/utils/console-repair-signal";

type SpawnFunction = typeof import("node:child_process").spawn;

// Bun on Windows blocks the first `stdio: "inherit"` spawn in a process for about
// 3.3s — measured here at 3 221 / 3 224 / 3 276 / 3 358 ms, against ~30ms for
// `pipe` and `ignore`. The launcher below cannot report its descendant's pid before
// that, so a 500ms budget left the pid unparsed and `expectProcessExited` read NaN
// on a machine where the kill itself was fine (the probe that proved it: the
// descendant was gone 2s after the timeout fired). Budget for the launcher, then
// assert that the kill stayed prompt. Each test gets the matching per-test allowance.
const TREE_KILL_TEST_TIMEOUT_MS = 6000;
const TREE_KILL_TEST_SLACK_MS = 4000;

function stubbornProcessTreeLauncher(): string[] {
  const descendantScript = [
    'process.on("SIGTERM", () => {});',
    "setTimeout(() => process.exit(0), 7000);",
    "setInterval(() => {}, 1000);",
  ].join("");
  const launcherScript = [
    'const { spawn } = require("node:child_process");',
    'const descendant = spawn(process.execPath, ["-e", process.argv[1]], { stdio: "inherit" });',
    'process.stdout.write("descendant:" + descendant.pid + "\\n");',
    'process.on("SIGTERM", () => {});',
    "setTimeout(() => process.exit(0), 7000);",
    "setInterval(() => {}, 1000);",
  ].join("");
  return [process.execPath, "-e", launcherScript, descendantScript];
}

function isProcessStillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const endCommand = stat.lastIndexOf(")");
      const state =
        endCommand === -1 ? "" : stat.slice(endCommand + 2, endCommand + 3);
      // kill(pid, 0) succeeds for a zombie until it is reaped, but the
      // process has exited and can no longer keep inherited stdio open.
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }

  if (process.platform === "darwin") {
    try {
      const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      return state !== "" && !state.startsWith("Z");
    } catch {
      return false;
    }
  }

  return true;
}

function expectProcessExited(pid: number): void {
  expect(pid).toBeGreaterThan(0);
  expect(isProcessStillRunning(pid)).toBe(false);
}

describe("shared shell process", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  test("returns the process handle separately from completion", async () => {
    const running = startShellProcess(
      [process.execPath, "-e", 'process.stdout.write("shared")'],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 0,
      },
    );

    expect(typeof running.process.kill).toBe("function");
    expect(typeof running.terminate).toBe("function");
    expect(await running.completion).toEqual({
      stdout: "shared",
      stderr: "",
      exitCode: 0,
    });
  });

  test.skipIf(process.platform === "win32")(
    "supports writable PTY processes",
    async () => {
      const running = startShellProcess(
        ["bash", "-c", 'read value; printf "read:%s" "$value"'],
        {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 2000,
          tty: true,
        },
      );

      running.process.write("hello\n");
      const result = await running.completion;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("read:hello");
    },
  );

  test("can stream output without retaining a second copy", async () => {
    let streamed = "";
    const running = startShellProcess(
      [process.execPath, "-e", 'process.stdout.write("streamed")'],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 0,
        captureOutput: false,
        onOutput: (chunk) => {
          streamed += chunk;
        },
      },
    );

    expect(await running.completion).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(streamed).toBe("streamed");
  });

  test("tracks PR output from the shared completion path", async () => {
    let resolveUpdate!: (tags: string[]) => void;
    const updateObserved = new Promise<string[]>((resolve) => {
      resolveUpdate = resolve;
    });
    __testSetBackend({
      retrieveConversation: async () => ({
        id: "conv-shell",
        tags: ["channel:slack"],
      }),
      updateConversation: async (
        _conversationId: string,
        body: ConversationUpdateBody,
      ) => {
        const tags = Reflect.get(body, "tags");
        resolveUpdate(Array.isArray(tags) ? tags : []);
        return { id: "conv-shell", tags };
      },
    } as unknown as Backend);

    const running = runWithRuntimeContext(
      { agentId: "agent-shell", conversationId: "conv-shell" },
      () =>
        startShellProcess(
          [
            process.execPath,
            "-e",
            'process.stdout.write("https://github.com/letta-ai/letta-code/pull/3744\\n")',
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            timeoutMs: 1000,
            captureOutput: false,
            sourceCommand: "gh pr create --fill",
          },
        ),
    );

    await running.completion;
    await expect(updateObserved).resolves.toEqual([
      "channel:slack",
      "github:pull-request:letta-ai:letta-code:3744",
    ]);
  });

  test("decodes buffered output after joining split UTF-8 bytes", async () => {
    const result = await spawnWithLauncher(
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 25)",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1000,
      },
    );

    expect(result.stdout).toBe("😀");
  });

  test("decodes split UTF-8 bytes before streaming output", async () => {
    let streamed = "";
    const running = startShellProcess(
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 25)",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1000,
        captureOutput: false,
        onOutput: (chunk) => {
          streamed += chunk;
        },
      },
    );

    await running.completion;
    expect(streamed).toBe("😀");
  });

  test("force-kills a timed-out process tree that ignores graceful termination", async () => {
    let output = "";
    const startedAt = Date.now();

    let error: unknown;
    try {
      await spawnWithLauncher(stubbornProcessTreeLauncher(), {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: TREE_KILL_TEST_TIMEOUT_MS,
        onOutput: (chunk) => {
          output += chunk;
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Command timed out");
    expect(Date.now() - startedAt).toBeLessThan(
      TREE_KILL_TEST_TIMEOUT_MS + TREE_KILL_TEST_SLACK_MS,
    );

    const descendantPid = Number(output.match(/descendant:(\d+)/)?.[1]);
    expectProcessExited(descendantPid);
  }, 20_000);

  test("force-kills an aborted process tree that ignores graceful termination", async () => {
    const controller = new AbortController();
    let output = "";
    const startedAt = Date.now();
    const abortTimer = setTimeout(
      () => controller.abort(),
      TREE_KILL_TEST_TIMEOUT_MS,
    );

    let error: unknown;
    try {
      await spawnWithLauncher(stubbornProcessTreeLauncher(), {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 0,
        signal: controller.signal,
        onOutput: (chunk) => {
          output += chunk;
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      clearTimeout(abortTimer);
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(Date.now() - startedAt).toBeLessThan(
      TREE_KILL_TEST_TIMEOUT_MS + TREE_KILL_TEST_SLACK_MS,
    );

    const descendantPid = Number(output.match(/descendant:(\d+)/)?.[1]);
    expectProcessExited(descendantPid);
  }, 20_000);
});

/** A spawned child stand-in: pipes both ways, no process. */
class FakeSpawnedChild extends EventEmitter {
  pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** Start a pipeline process whose `spawn` is captured instead of executed. */
function startWithCapturedSpawn(launcher: string[]): {
  child: FakeSpawnedChild;
  spawnOptions: Array<Record<string, unknown>>;
  running: ReturnType<typeof startShellProcess>;
} {
  const child = new FakeSpawnedChild();
  const spawnOptions: Array<Record<string, unknown>> = [];
  const spawnImpl = ((
    _file: string,
    _args: string[],
    options: Record<string, unknown>,
  ) => {
    spawnOptions.push(options);
    return child;
  }) as unknown as SpawnFunction;
  const running = startShellProcess(launcher, {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 0,
    spawnImpl,
  });
  return { child, spawnOptions, running };
}

describe("pipeline spawn and the console-font guard (T-08)", () => {
  test.skipIf(process.platform !== "win32")(
    "a piped Windows shell asks for its own hidden console (R-08.1)",
    async () => {
      const { child, spawnOptions, running } = startWithCapturedSpawn([
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-NoProfile",
        "-Command",
        "exit 0",
      ]);

      child.emit("close", 0);
      expect(await running.completion).toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      expect(spawnOptions[0]?.windowsHide).toBe(true);
    },
  );

  test("a piped non-shell child keeps the default console behaviour", async () => {
    // R-08.1 names only pwsh/powershell/cmd; a node child must not silently
    // gain a flag that changes how its console behaves.
    const { child, spawnOptions, running } = startWithCapturedSpawn([
      process.execPath,
      "-e",
      "0",
    ]);

    child.emit("close", 0);
    await running.completion;
    expect(spawnOptions[0]?.windowsHide).toBeUndefined();
  });

  test("a finished spawn asks the guard for one repair check (R-08.2)", async () => {
    let checks = 0;
    setConsoleRepairHandler(() => {
      checks += 1;
    });
    try {
      const running = startShellProcess([process.execPath, "-e", "0"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 0,
      });

      await running.completion;
      expect(checks).toBe(1);
    } finally {
      setConsoleRepairHandler(null);
    }
  });

  test("a spawn that never ran asks for no repair check", async () => {
    // Nothing started, so nothing can have flipped the font: the signal is tied
    // to a process ending, not to a spawn attempt failing.
    let checks = 0;
    setConsoleRepairHandler(() => {
      checks += 1;
    });
    try {
      const child = new FakeSpawnedChild();
      const spawnImpl = (() => child) as unknown as SpawnFunction;
      const running = startShellProcess(
        ["/definitely/not/a/shell", "-c", "x"],
        {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 0,
          spawnImpl,
        },
      );

      child.emit(
        "error",
        Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      );
      await expect(running.completion).rejects.toThrow();
      expect(checks).toBe(0);
    } finally {
      setConsoleRepairHandler(null);
    }
  });
});
