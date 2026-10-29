import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AutostartCommand,
  AutostartCommandResult,
} from "@/cron/autostart";
import {
  AUTOSTART_CRON_MARKER,
  AUTOSTART_LAUNCHD_LABEL,
  AUTOSTART_SYSTEMD_UNIT,
  AUTOSTART_TASK_NAME,
  getAutostartStatus,
  readAutostartLauncher,
  registerAutostart,
  resolveAutostartInvocation,
  resolveAutostartLauncherPath,
  unregisterAutostart,
} from "@/cron/autostart";
import { buildAutostartLauncherScript } from "@/cron/autostart-launcher";

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
  test("windows launcher is a hidden VBScript that pins the invocation", () => {
    const script = buildAutostartLauncherScript({
      platform: "win32",
      invocation,
      env: { HARUYUKI_HOME: "D:\\hryk home" },
    });

    // `wscript.exe` runs in the GUI subsystem and window style 0 is hidden:
    // that pair is what stops the every-minute tick flashing a console window.
    expect(script).toContain('Set shell = CreateObject("WScript.Shell")');
    expect(script).toContain("shell.Run cmd, 0, False");
    expect(script).not.toContain("@echo off");
    expect(script).toContain(
      'shell.Environment("Process")("HARUYUKI_HOME") = "D:\\hryk home"',
    );
    expect(script).toContain(
      'cmd = Chr(34) & "C:\\bun\\bun.exe" & Chr(34) & " " & Chr(34) & "C:\\repo\\src\\index.ts" & Chr(34) & " schedule tick"',
    );
    // WScript wants CRLF; a bare LF can truncate a long line.
    expect(script).toContain("\r\n");
    expect(script).not.toContain("\nexec ");
  });

  test("the windows launcher has no HARUYUKI_HOME line without an override", () => {
    const script = buildAutostartLauncherScript({
      platform: "win32",
      invocation,
      env: {},
    });
    expect(script).not.toContain("HARUYUKI_HOME");
    expect(script).not.toContain("shell.Environment");
    expect(script).toContain("shell.Run cmd, 0, False");
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

  test("a dev src/index.ts run is redirected to the standalone entry (C-24)", () => {
    expect(
      resolveAutostartInvocation(
        {},
        "C:\\bun\\bun.exe",
        "C:\\repo\\src\\index.ts",
      ),
    ).toEqual({
      command: "C:\\bun\\bun.exe",
      args: ["C:\\repo\\src\\standalone-entry.ts"],
    });
  });

  test("a packaged haruyuki.js entrypoint is left alone", () => {
    expect(
      resolveAutostartInvocation(
        {},
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\app\\haruyuki.js",
      ),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\app\\haruyuki.js"],
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
      registeredLauncherPath: resolveAutostartLauncherPath({
        platform: "win32",
        homeDir: home,
        env: {},
      }),
      stale: false,
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
      `wscript.exe "${status.launcherPath}"`,
    ]);
    expect(status.launcherPath?.endsWith("schedule-tick.vbs")).toBe(true);
    expect(
      readAutostartLauncher({ platform: "win32", homeDir: home, env: {} }),
    ).toContain("shell.Run cmd, 0, False");
  });

  test("a launcher path with spaces stays quoted for schtasks", async () => {
    const home = join(tempHome(), "home with spaces");
    const fake = recorder(() => undefined);

    const status = await registerAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });

    expect(status.launcherPath).toContain("home with spaces");
    expect(fake.calls[0]?.args.at(-1)).toBe(
      `wscript.exe "${status.launcherPath}"`,
    );
  });

  test("status reads the launcher path out of the wscript arguments", async () => {
    const home = tempHome();
    const launcherPath = resolveAutostartLauncherPath({
      platform: "win32",
      homeDir: home,
      env: {},
    });
    await registerAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: recorder(() => undefined).runner,
      invocation,
    });
    const fake = recorder((command) =>
      command.args.includes("/XML")
        ? {
            code: 0,
            stdout:
              "<Task><Actions><Exec><Command>wscript.exe</Command>" +
              `<Arguments>&quot;${launcherPath}&quot;</Arguments>` +
              "</Exec></Actions></Task>",
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" },
    );

    const status = await getAutostartStatus({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });

    expect(status.registered).toBe(true);
    expect(status.registeredLauncherPath).toBe(launcherPath);
    expect(status.stale).toBe(false);
  });

  test("a task still pointing at the pre-VBS .cmd launcher is stale", async () => {
    const home = tempHome();
    const launcherPath = resolveAutostartLauncherPath({
      platform: "win32",
      homeDir: home,
      env: {},
    });
    await registerAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: recorder(() => undefined).runner,
      invocation,
    });
    const legacy = join(dirname(launcherPath), "schedule-tick.cmd");
    const fake = recorder((command) =>
      command.args.includes("/XML")
        ? {
            code: 0,
            stdout: `<Task><Actions><Exec><Command>${legacy}</Command></Exec></Actions></Task>`,
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" },
    );

    const status = await getAutostartStatus({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });

    expect(status.registered).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.registeredLauncherPath).toBe(legacy);
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

  test("status reports no launcher path when the entry does not expose one", async () => {
    const home = tempHome();
    const fake = recorder((command) =>
      command.args.includes("/XML")
        ? { code: 1, stdout: "", stderr: "ERROR: access denied" }
        : { code: 0, stdout: "", stderr: "" },
    );

    const status = await getAutostartStatus({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: fake.runner,
    });

    expect(status.registered).toBe(true);
    // Never claim the current launcher is the registered one when the probe
    // failed to read it (M4 #11).
    expect(status.registeredLauncherPath).toBeUndefined();
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

  test("unregister removes the .cmd launcher a pre-VBS build left behind", async () => {
    const home = tempHome();
    const launcherPath = resolveAutostartLauncherPath({
      platform: "win32",
      homeDir: home,
      env: {},
    });
    await registerAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: recorder(() => undefined).runner,
      invocation,
    });
    const legacy = join(dirname(launcherPath), "schedule-tick.cmd");
    writeFileSync(legacy, "@echo off\r\n");

    await unregisterAutostart({
      platform: "win32",
      homeDir: home,
      env: {},
      runner: recorder(() => ({ code: 1, stdout: "", stderr: "" })).runner,
    });

    expect(existsSync(legacy)).toBe(false);
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
    // bootout+bootstrap reload the agent now, so "autostart on" takes effect
    // immediately instead of waiting for the next login (M4 #12).
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["bootout", "gui/501", plistPath],
      ["bootstrap", "gui/501", plistPath],
      ["enable", `gui/501/${AUTOSTART_LAUNCHD_LABEL}`],
    ]);
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

describe("linux mechanism probing (M4 #8)", () => {
  /** Install the unit files and the enable symlink a desktop session leaves. */
  function writeSystemdUnits(home: string, execStart: string): void {
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(join(dir, "timers.target.wants"), { recursive: true });
    writeFileSync(
      join(dir, `${AUTOSTART_SYSTEMD_UNIT}.service`),
      `[Service]\nExecStart="${execStart}"\n`,
    );
    writeFileSync(join(dir, `${AUTOSTART_SYSTEMD_UNIT}.timer`), "[Timer]\n");
    writeFileSync(
      join(dir, "timers.target.wants", `${AUTOSTART_SYSTEMD_UNIT}.timer`),
      "",
    );
  }

  function systemdUnitDir(home: string): string {
    return join(home, ".config", "systemd", "user");
  }

  function launcherFor(home: string): string {
    return resolveAutostartLauncherPath({
      platform: "linux",
      homeDir: home,
      env: {},
    });
  }

  test("status uses the installed unit without an XDG runtime dir (SSH)", async () => {
    const home = tempHome();
    const launcher = launcherFor(home);
    writeSystemdUnits(home, launcher);
    const fake = recorder((command) =>
      command.file === "crontab"
        ? { code: 1, stdout: "", stderr: "no crontab for user" }
        : { code: 1, stdout: "", stderr: "Failed to connect to bus" },
    );

    const status = await getAutostartStatus({
      platform: "linux",
      homeDir: home,
      env: {},
      runner: fake.runner,
    });

    expect(status).toMatchObject({
      registered: true,
      method: "systemd-user",
      registeredLauncherPath: launcher,
    });
    // Only the unit files mattered; no systemd bus probe was needed.
    expect(fake.calls.some((call) => call.file === "systemctl")).toBe(false);
  });

  test("off removes the installed timer from an XDG-less shell (SSH)", async () => {
    const home = tempHome();
    writeSystemdUnits(home, launcherFor(home));
    const fake = recorder((command) =>
      command.file === "crontab"
        ? { code: 1, stdout: "", stderr: "no crontab for user" }
        : { code: 1, stdout: "", stderr: "Failed to connect to bus" },
    );

    const status = await unregisterAutostart({
      platform: "linux",
      homeDir: home,
      env: {},
      runner: fake.runner,
    });

    expect(status.registered).toBe(false);
    const dir = systemdUnitDir(home);
    expect(existsSync(join(dir, `${AUTOSTART_SYSTEMD_UNIT}.timer`))).toBe(
      false,
    );
    expect(existsSync(join(dir, `${AUTOSTART_SYSTEMD_UNIT}.service`))).toBe(
      false,
    );
    // The disable attempt is made even without a bus; it is the file removal
    // that makes the registration inert.
    expect(
      fake.calls.some(
        (call) => call.file === "systemctl" && call.args.includes("disable"),
      ),
    ).toBe(true);
  });

  test("an existing crontab registration wins over the XDG hint", async () => {
    const home = tempHome();
    let crontab = "";
    const runner = async (command: AutostartCommand) => {
      if (command.file === "crontab" && command.args[0] === "-l") {
        return { code: 0, stdout: crontab, stderr: "" };
      }
      if (command.file === "crontab") {
        crontab = command.stdin ?? "";
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await registerAutostart({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: false,
      runner,
      invocation,
    });
    const xdg = { XDG_RUNTIME_DIR: "/run/user/1000" };

    const status = await getAutostartStatus({
      platform: "linux",
      homeDir: home,
      env: xdg,
      runner,
      invocation,
    });
    expect(status).toMatchObject({ registered: true, method: "crontab" });
    expect(status.stale).toBe(false);

    const after = await unregisterAutostart({
      platform: "linux",
      homeDir: home,
      env: xdg,
      runner,
      invocation,
    });
    expect(after.registered).toBe(false);
    expect(crontab).not.toContain(AUTOSTART_CRON_MARKER);
  });
});

describe("stale registration detection (M4 #11)", () => {
  test("systemd ExecStart pointing at an older launcher is stale", async () => {
    const home = tempHome();
    const fake = recorder(() => undefined);
    const status = await registerAutostart({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: true,
      runner: fake.runner,
      invocation,
    });
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(join(dir, "timers.target.wants"), { recursive: true });
    writeFileSync(
      join(dir, `${AUTOSTART_SYSTEMD_UNIT}.service`),
      '[Service]\nExecStart="/old/home/.haruyuki/bin/schedule-tick.sh"\n',
    );
    writeFileSync(
      join(dir, "timers.target.wants", `${AUTOSTART_SYSTEMD_UNIT}.timer`),
      "",
    );

    const probed = await getAutostartStatus({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: true,
      runner: fake.runner,
    });

    expect(status.stale).toBe(false);
    expect(probed.registered).toBe(true);
    expect(probed.stale).toBe(true);
    expect(probed.registeredLauncherPath).toBe(
      "/old/home/.haruyuki/bin/schedule-tick.sh",
    );
  });

  test("a launcher written by an older install is stale without a path change", async () => {
    const home = tempHome();
    const fake = recorder(() => undefined);
    await registerAutostart({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: true,
      runner: fake.runner,
      invocation,
    });
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(join(dir, "timers.target.wants"), { recursive: true });
    writeFileSync(
      join(dir, "timers.target.wants", `${AUTOSTART_SYSTEMD_UNIT}.timer`),
      "",
    );
    const launcherPath = resolveAutostartLauncherPath({
      platform: "linux",
      homeDir: home,
      env: {},
    });
    writeFileSync(
      launcherPath,
      "#!/bin/sh\nexec /old/bin/bun /old/src/index.ts\n",
    );

    const probed = await getAutostartStatus({
      platform: "linux",
      homeDir: home,
      env: {},
      systemd: true,
      runner: fake.runner,
    });

    expect(probed.registered).toBe(true);
    expect(probed.stale).toBe(true);
    expect(probed.registeredLauncherPath).toBe(launcherPath);
  });

  test("macOS plist ProgramArguments pointing at an older launcher is stale", async () => {
    const home = tempHome();
    const fake = recorder(() => undefined);
    await registerAutostart({
      platform: "darwin",
      homeDir: home,
      env: {},
      runner: fake.runner,
      invocation,
    });
    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      `${AUTOSTART_LAUNCHD_LABEL}.plist`,
    );
    const plist = readFileSync(plistPath, "utf8").replace(
      /<string>[^<]*schedule-tick\.sh<\/string>/,
      "<string>/old/home/.haruyuki/bin/schedule-tick.sh</string>",
    );
    writeFileSync(plistPath, plist);

    const probed = await getAutostartStatus({
      platform: "darwin",
      homeDir: home,
      env: {},
      runner: fake.runner,
    });

    expect(probed.registered).toBe(true);
    expect(probed.stale).toBe(true);
    expect(probed.registeredLauncherPath).toBe(
      "/old/home/.haruyuki/bin/schedule-tick.sh",
    );
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
