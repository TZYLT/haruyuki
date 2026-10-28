import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AutostartCommand,
  AutostartCommandResult,
} from "@/cron/autostart";
import {
  AUTOSTART_CRON_MARKER,
  AUTOSTART_LAUNCHD_LABEL,
  AUTOSTART_SYSTEMD_UNIT,
  AUTOSTART_TASK_NAME,
  buildAutostartLauncherScript,
  getAutostartStatus,
  readAutostartLauncher,
  registerAutostart,
  resolveAutostartInvocation,
  resolveAutostartLauncherPath,
  unregisterAutostart,
} from "@/cron/autostart";

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hryk-autostart-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Recorder {
  calls: AutostartCommand[];
  runner: (command: AutostartCommand) => Promise<AutostartCommandResult>;
}

function recorder(
  respond: (command: AutostartCommand) => AutostartCommandResult | undefined,
): Recorder {
  const calls: AutostartCommand[] = [];
  return {
    calls,
    runner: async (command) => {
      calls.push(command);
      return respond(command) ?? { code: 0, stdout: "", stderr: "" };
    },
  };
}

const invocation = {
  command: "C:\\bun\\bun.exe",
  args: ["C:\\repo\\src\\index.ts"],
};

describe("launcher script", () => {
  test("windows launcher pins the invocation and the harness root", () => {
    const script = buildAutostartLauncherScript({
      platform: "win32",
      invocation,
      env: { HARUYUKI_HOME: "D:\\hryk home" },
    });

    expect(script).toContain("@echo off");
    expect(script).toContain('set "HARUYUKI_HOME=D:\\hryk home"');
    expect(script).toContain(
      '"C:\\bun\\bun.exe" "C:\\repo\\src\\index.ts" schedule tick',
    );
    // A .cmd file needs CRLF; a bare LF confuses cmd.exe on long lines.
    expect(script).toContain("\r\n");
    expect(script).not.toContain("\nexec ");
  });

  test("unix launcher is a sh script with a quoted override", () => {
    const script = buildAutostartLauncherScript({
      platform: "linux",
      invocation: { command: "/usr/bin/bun", args: ["/repo/src/index.ts"] },
      env: { HARUYUKI_HOME: "/home/u/hryk home" },
    });

    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("export HARUYUKI_HOME='/home/u/hryk home'");
    expect(script).toContain(
      "exec '/usr/bin/bun' '/repo/src/index.ts' schedule tick",
    );
  });

  test("without an override the launcher carries no HARUYUKI_HOME line", () => {
    const script = buildAutostartLauncherScript({
      platform: "linux",
      invocation,
      env: {},
    });
    expect(script).not.toContain("HARUYUKI_HOME");
  });
});

describe("invocation resolution", () => {
  test("HARUYUKI_CODE_BIN wins and drops the stray quotes", () => {
    expect(
      resolveAutostartInvocation(
        { HARUYUKI_CODE_BIN: '"C:\\Tools\\haruyuki.cmd"' },
        "C:\\bun\\bun.exe",
        "C:\\repo\\src\\index.ts",
      ),
    ).toEqual({ command: "C:\\Tools\\haruyuki.cmd", args: [] });
  });

  test("falls back to the current executable plus entrypoint", () => {
    expect(
      resolveAutostartInvocation(
        {},
        "C:\\bun\\bun.exe",
        "C:\\repo\\src\\index.ts",
      ),
    ).toEqual({
      command: "C:\\bun\\bun.exe",
      args: ["C:\\repo\\src\\index.ts"],
    });
  });
});

describe("windows registration", () => {
  test("register writes the launcher and creates one minute task", async () => {
    const home = tempHome();
    const fake = recorder(() => undefined);

    const status = await registerAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });

    expect(status).toEqual({
      registered: true,
      platform: "win32",
      method: "schtasks",
      launcherPath: resolveAutostartLauncherPath({
        platform: "win32",
        homeDir: home,
        env: {},
      }),
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.file).toBe("schtasks");
    expect(fake.calls[0]?.args).toEqual([
      "/Create",
      "/F",
      "/SC",
      "MINUTE",
      "/MO",
      "1",
      "/TN",
      AUTOSTART_TASK_NAME,
      "/TR",
      `"${status.launcherPath}"`,
    ]);
    expect(
      readAutostartLauncher({ platform: "win32", homeDir: home, env: {} }),
    ).toContain("schedule tick");
  });

  test("a refused schtasks call becomes structured error, not a throw", async () => {
    const home = tempHome();
    const fake = recorder(() => ({
      code: 1,
      stdout: "",
      stderr: "ERROR: Access is denied.",
    }));

    const status = await registerAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });

    expect(status.registered).toBe(false);
    expect(status.method).toBe("schtasks");
    expect(status.error).toContain("Access is denied");
  });

  test("status asks schtasks about the exact task name", async () => {
    const home = tempHome();
    const fake = recorder(() => ({ code: 0, stdout: "", stderr: "" }));

    const status = await getAutostartStatus({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
    });

    expect(status.registered).toBe(true);
    expect(fake.calls[0]?.args).toEqual(["/Query", "/TN", AUTOSTART_TASK_NAME]);
  });

  test("unregister deletes then reports the postcondition", async () => {
    const home = tempHome();
    let deleted = false;
    const fake = recorder((command) => {
      if (command.args.includes("/Delete")) {
        deleted = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return deleted
        ? { code: 1, stdout: "", stderr: "ERROR: task does not exist." }
        : { code: 0, stdout: "", stderr: "" };
    });

    const status = await unregisterAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
    });

    expect(fake.calls[0]?.args).toEqual([
      "/Delete",
      "/TN",
      AUTOSTART_TASK_NAME,
      "/F",
    ]);
    expect(status.registered).toBe(false);
  });
});

describe("macOS registration", () => {
  test("writes a LaunchAgent plist that points at the launcher", async () => {
    const home = tempHome();
    const fake = recorder(() => undefined);

    const status = await registerAutostart({
      platform: "darwin",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation: {
        command: "/usr/local/bin/bun",
        args: ["/repo/src/index.ts"],
      },
    });

    expect(status.method).toBe("launchd");
    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      `${AUTOSTART_LAUNCHD_LABEL}.plist`,
    );
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain(`<string>${AUTOSTART_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
    expect(plist).toContain(`<string>${status.launcherPath}</string>`);
    // The plist is loaded now, not at the next login, or "autostart on" would
    // report success and do nothing until the user reboots.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.file).toBe("launchctl");
    expect(fake.calls[0]?.args).toEqual(["load", "-w", plistPath]);
  });

  test("an already-loaded agent is not a registration failure", async () => {
    const home = tempHome();
    const fake = recorder(() => ({
      code: 1,
      stdout: "",
      stderr: "Load failed: 37: Operation already in progress",
    }));

    const status = await registerAutostart({
      platform: "darwin",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });

    expect(status.registered).toBe(true);
    expect(status.error).toBeUndefined();
  });

  test("status is false when the plist is absent and true when launchctl lists", async () => {
    const home = tempHome();
    const absent = recorder(() => ({ code: 0, stdout: "", stderr: "" }));
    expect(
      (
        await getAutostartStatus({
          platform: "darwin",
          homeDir: home,
          env: {},
          runner: absent.runner,
        })
      ).registered,
    ).toBe(false);
    expect(absent.calls).toHaveLength(0);

    await registerAutostart({
      platform: "darwin",
      homeDir: home,
      env: {},
      runner: absent.runner,
      invocation,
    });
    const present = recorder(() => ({ code: 0, stdout: "", stderr: "" }));
    expect(
      (
        await getAutostartStatus({
          platform: "darwin",
          homeDir: home,
          env: {},
          runner: present.runner,
        })
      ).registered,
    ).toBe(true);
    expect(present.calls[0]?.args).toEqual(["list", AUTOSTART_LAUNCHD_LABEL]);
  });

  test("unregister removes the plist", async () => {
    const home = tempHome();
    const fake = recorder(() => undefined);
    await registerAutostart({
      platform: "darwin",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });
    await unregisterAutostart({
      platform: "darwin",
      homeDir: home,
      env: {},
      runner: fake.runner,
    });
    expect(
      existsSync(
        join(
          home,
          "Library",
          "LaunchAgents",
          `${AUTOSTART_LAUNCHD_LABEL}.plist`,
        ),
      ),
    ).toBe(false);
  });
});

describe("linux registration", () => {
  test("systemd user timer is written, reloaded and enabled", async () => {
    const home = tempHome();
    const fake = recorder(() => ({ code: 0, stdout: "", stderr: "" }));

    const status = await registerAutostart({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: true,
      runner: fake.runner,
      invocation,
    });

    expect(status.method).toBe("systemd-user");
    const dir = join(home, ".config", "systemd", "user");
    expect(
      readFileSync(join(dir, `${AUTOSTART_SYSTEMD_UNIT}.timer`), "utf8"),
    ).toContain("OnUnitActiveSec=1min");
    expect(
      readFileSync(join(dir, `${AUTOSTART_SYSTEMD_UNIT}.service`), "utf8"),
    ).toContain(`ExecStart="${status.launcherPath}"`);
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", `${AUTOSTART_SYSTEMD_UNIT}.timer`],
    ]);
  });

  test("crontab fallback keeps other lines and stays idempotent", async () => {
    const home = tempHome();
    let crontab = "5 4 * * * /usr/bin/backup\n";

    const runner = async (command: AutostartCommand) => {
      if (command.args[0] === "-l") {
        return { code: 0, stdout: crontab, stderr: "" };
      }
      crontab = command.stdin ?? "";
      return { code: 0, stdout: "", stderr: "" };
    };

    const register = () =>
      registerAutostart({
        platform: "linux",
        homeDir: home,
        env: {},
        systemd: false,
        runner,
        invocation,
      });

    const first = await register();
    await register();

    expect(first.method).toBe("crontab");
    const lines = crontab.trim().split("\n");
    expect(
      lines.filter((line) => line.includes(AUTOSTART_CRON_MARKER)),
    ).toHaveLength(1);
    expect(lines).toContain("5 4 * * * /usr/bin/backup");
    const cronEntry = lines.find((line) =>
      line.includes(AUTOSTART_CRON_MARKER),
    );
    expect(cronEntry?.startsWith("* * * * * ")).toBe(true);
    expect(cronEntry).toContain("schedule-tick.sh");

    const status = await getAutostartStatus({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: false,
      runner,
    });
    expect(status.registered).toBe(true);

    const after = await unregisterAutostart({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: false,
      runner,
    });
    expect(after.registered).toBe(false);
    expect(crontab).toContain("5 4 * * * /usr/bin/backup");
    expect(crontab).not.toContain(AUTOSTART_CRON_MARKER);
  });

  test("an unreadable crontab is an error, not an empty overwrite", async () => {
    const home = tempHome();
    const runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "crontab: permission denied",
    });
    const status = await registerAutostart({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: false,
      runner,
      invocation,
    });
    expect(status.registered).toBe(false);
    expect(status.error).toContain("could not read the current crontab");
  });
});

describe("unsupported platforms", () => {
  test("return a structured error instead of a bad entry", async () => {
    const status = await registerAutostart({
      platform: "freebsd",
      homeDir: tempHome(),
      env: {},
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(status.registered).toBe(false);
    expect(status.method).toBeNull();
    expect(status.error).toContain("freebsd");
  });
});
