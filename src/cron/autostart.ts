/**
 * OS autostart registration (F-05, M4).
 *
 * Registers a user-level timer (Windows `schtasks` / macOS LaunchAgent /
 * systemd user timer with a crontab fallback) that wakes the short-lived host
 * once a minute. Nothing here writes a system-level entry.
 *
 * Two rules shape the file:
 *
 * - **The OS entry points at a launcher script, never at the product binary
 *   directly** (C-23). The launcher pins the invocation this process is running
 *   under — the repo entry under Bun, `haruyuki.js` under Node — and carries the
 *   `HARUYUKI_HOME` override, which an OS timer entry cannot pass per task.
 * - **Every command runs through an injectable runner** (M-11). Tests assert the
 *   exact command line and never touch the machine; the real runner is the only
 *   place that spawns a process.
 *
 * Failures are returned as structured status, not thrown: the wizard keeps the
 * task it was creating and offers a retry (R-5.2.6).
 *
 * This module is in the `cron/` leaf layer, so it cannot import
 * `tools/impl/shell-env` (`tools` imports `cron`; that would be a cycle). It
 * resolves the launcher payload from `argv` itself with the same rules, and the
 * resolution is exported so a test can pin it.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { APP_SUBDIRS, appHomePath, resolveHomeDir } from "@/utils/app-paths";
import type { AutostartStatus } from "./cron-types";

// ── Public constants ───────────────────────────────────────────────

/** Windows scheduled-task name. Stable: re-registering replaces this one entry. */
export const AUTOSTART_TASK_NAME = "Haruyuki Schedule Tick";
/** macOS LaunchAgent label. */
export const AUTOSTART_LAUNCHD_LABEL = "com.haruyuki.schedule-tick";
/** systemd user unit name (`.service` and `.timer`). */
export const AUTOSTART_SYSTEMD_UNIT = "haruyuki-schedule-tick";
/** Marker that identifies our crontab line, so unregister can find it again. */
export const AUTOSTART_CRON_MARKER = "# haruyuki-schedule-tick";
/** One minute: the short-lived host's own cadence (R-5.3.1). */
export const AUTOSTART_INTERVAL_SECONDS = 60;

export type AutostartPlatform = "win32" | "darwin" | "linux";
export type AutostartMethod =
  | "schtasks"
  | "launchd"
  | "systemd-user"
  | "crontab";

// ── Injectable process runner ──────────────────────────────────────

export interface AutostartCommand {
  file: string;
  args: string[];
  /** Written to the child's stdin; only `crontab -` needs it. */
  stdin?: string;
}

export interface AutostartCommandResult {
  /** Process exit code; a spawn failure is reported as `1`. */
  code: number;
  stdout: string;
  stderr: string;
}

export type AutostartCommandRunner = (
  command: AutostartCommand,
) => Promise<AutostartCommandResult>;

async function runProcess(
  command: AutostartCommand,
): Promise<AutostartCommandResult> {
  return await new Promise<AutostartCommandResult>((resolve) => {
    let settled = false;
    const finish = (result: AutostartCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = execFile(
        command.file,
        command.args,
        { windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          finish({
            code: err ? exitCodeOf(err) : 0,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
      child.on("error", (err) => {
        finish({ code: 1, stdout: "", stderr: err.message });
      });
      if (command.stdin !== undefined) {
        child.stdin?.end(command.stdin);
      }
    } catch (err) {
      finish({
        code: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function exitCodeOf(err: Error): number {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "number" ? code : 1;
}

// ── Options ────────────────────────────────────────────────────────

/** The command the launcher runs: this executable plus the current entrypoint. */
export interface AutostartInvocation {
  command: string;
  args: string[];
}

export interface AutostartOptions {
  /** Overrides `process.platform`; tests use it to assert all three branches. */
  platform?: NodeJS.Platform;
  /** Home directory the launcher and OS entries are resolved against. */
  homeDir?: string;
  /** Environment used for `HARUYUKI_HOME` / `XDG_RUNTIME_DIR`. */
  env?: NodeJS.ProcessEnv;
  /** Process runner; tests inject one, production uses {@link runProcess}. */
  runner?: AutostartCommandRunner;
  /** Overrides the launcher payload. */
  invocation?: AutostartInvocation;
  /** Overrides the launcher path (tests keep it inside their temp home). */
  launcherPath?: string;
  /** systemd availability on Linux. Defaults to "an XDG runtime dir exists". */
  systemd?: boolean;
  /**
   * Forces the Linux mechanism. Callers that know how this machine registered
   * pass it; otherwise the machine's own artifacts decide (M4 #8).
   */
  method?: AutostartMethod;
  /** macOS uid for the `gui/<uid>` launchctl domain; defaults to the process uid. */
  uid?: number;
}

/**
 * Resolve what the launcher should execute.
 *
 * `HARUYUKI_CODE_BIN` wins (the same convention the shell tool and subagent
 * launcher use). Otherwise the pair is the current executable plus its
 * entrypoint: a packaged `haruyuki.js` is already the light standalone entry,
 * while a dev `bun src/index.ts` run is redirected to the sibling
 * `src/standalone-entry.ts` so the timer never loads the whole application
 * just to fire `schedule tick` (C-24/P1-6).
 */
export function resolveAutostartInvocation(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  entrypoint: string | undefined = process.argv[1],
): AutostartInvocation {
  const explicit = env.HARUYUKI_CODE_BIN?.trim().replace(/^["']|["']$/g, "");
  if (explicit) {
    return { command: explicit, args: [] };
  }
  if (entrypoint) {
    const devEntry = /src[\\/]index\.ts$/.test(entrypoint)
      ? `${entrypoint.slice(0, -"index.ts".length)}standalone-entry.ts`
      : entrypoint;
    return { command: execPath, args: [devEntry] };
  }
  return {
    command: process.platform === "win32" ? "haruyuki.cmd" : "haruyuki",
    args: [],
  };
}

// ── Paths and launcher script ──────────────────────────────────────

function platformOf(options: AutostartOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

/** Absolute path of the launcher script the OS entry will point at. */
export function resolveAutostartLauncherPath(
  options: AutostartOptions = {},
): string {
  if (options.launcherPath) return options.launcherPath;
  const name =
    platformOf(options) === "win32" ? "schedule-tick.cmd" : "schedule-tick.sh";
  return appHomePath([APP_SUBDIRS.bin, name], {
    homeDir: options.homeDir,
    env: options.env,
  });
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launcher body. It is written once per registration and is the only thing
 * the OS entry references, so the entry survives updates that move the binary.
 */
export function buildAutostartLauncherScript(input: {
  platform: NodeJS.Platform;
  invocation: AutostartInvocation;
  env: NodeJS.ProcessEnv;
}): string {
  const home = input.env.HARUYUKI_HOME?.trim();
  const commandLine = [input.invocation.command, ...input.invocation.args]
    .map((part) =>
      input.platform === "win32" ? quoteForCmd(part) : quoteForShell(part),
    )
    .join(" ");

  if (input.platform === "win32") {
    return [
      "@echo off",
      "setlocal",
      "rem Written by Haruyuki F-05 autostart. Removed by `haruyuki schedule autostart off`.",
      home ? `set "HARUYUKI_HOME=${home}"` : undefined,
      `${commandLine} schedule tick`,
      "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\r\n");
  }

  return [
    "#!/bin/sh",
    "# Written by Haruyuki F-05 autostart. Removed by `haruyuki schedule autostart off`.",
    home ? `export HARUYUKI_HOME=${quoteForShell(home)}` : undefined,
    `exec ${commandLine} schedule tick`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function writeLauncher(
  path: string,
  platform: NodeJS.Platform,
  content: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  if (platform !== "win32") {
    try {
      chmodSync(path, 0o755);
    } catch {
      // A filesystem without POSIX modes (a mounted FAT volume) still runs the
      // script through `sh <path>`; the OS entry uses the direct path, so this
      // only matters when the mount refuses the bit.
    }
  }
}

// ── Platform pieces ────────────────────────────────────────────────

interface AutostartContext {
  platform: AutostartPlatform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  runner: AutostartCommandRunner;
  launcherPath: string;
  invocation: AutostartInvocation;
  /** An XDG runtime dir says a user systemd manager is reachable right now. */
  systemdAvailable: boolean;
  /** Explicit mechanism override; `null` means "decide from the machine". */
  method: AutostartMethod | null;
  /** macOS launchctl domain uid. */
  uid: number;
}

function failure(
  context: { platform: AutostartPlatform; method: AutostartMethod | null },
  launcherPath: string,
  result: AutostartCommandResult,
): AutostartStatus {
  const detail = (result.stderr || result.stdout).trim();
  return {
    registered: false,
    platform: context.platform,
    method: context.method,
    launcherPath,
    error: detail || `exit code ${result.code}`,
  };
}

function launchAgentsPlistPath(homeDir: string): string {
  return join(
    homeDir,
    "Library",
    "LaunchAgents",
    `${AUTOSTART_LAUNCHD_LABEL}.plist`,
  );
}

function launchdDomain(context: { uid: number }): string {
  return `gui/${context.uid}`;
}

interface LinuxUnitPaths {
  directory: string;
  service: string;
  timer: string;
  /** Symlink `systemctl --user enable` creates; readable without a bus. */
  wantsTimer: string;
}

function linuxUnitPaths(homeDir: string): LinuxUnitPaths {
  const directory = join(homeDir, ".config", "systemd", "user");
  return {
    directory,
    service: join(directory, `${AUTOSTART_SYSTEMD_UNIT}.service`),
    timer: join(directory, `${AUTOSTART_SYSTEMD_UNIT}.timer`),
    wantsTimer: join(
      directory,
      "timers.target.wants",
      `${AUTOSTART_SYSTEMD_UNIT}.timer`,
    ),
  };
}

/** Registration status; a true result points at the current launcher. */
function statusOf(
  context: AutostartContext,
  method: AutostartMethod,
  registered: boolean,
): AutostartStatus {
  const base = {
    registered,
    platform: context.platform,
    method,
    launcherPath: context.launcherPath,
  };
  return registered
    ? {
        ...base,
        registeredLauncherPath: context.launcherPath,
        stale: false,
      }
    : base;
}

function unquotePath(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** First capture group of `pattern` in `text`, or `undefined`. */
function matchGroup(pattern: RegExp, text: string): string | undefined {
  return pattern.exec(text)?.[1];
}

/** The launcher path an existing OS entry references (M4 #8/#11). */
async function readRegisteredLauncherPath(
  context: AutostartContext,
  method: AutostartMethod,
  crontab?: string,
): Promise<string | undefined> {
  try {
    switch (method) {
      case "schtasks": {
        const result = await context.runner({
          file: "schtasks",
          args: ["/Query", "/TN", AUTOSTART_TASK_NAME, "/XML"],
        });
        if (result.code !== 0) return undefined;
        const command = matchGroup(
          /<Command>([\s\S]*?)<\/Command>/,
          result.stdout,
        );
        return command === undefined ? undefined : decodeXmlEntities(command);
      }
      case "launchd": {
        const plistPath = launchAgentsPlistPath(context.homeDir);
        if (!existsSync(plistPath)) return undefined;
        const command = matchGroup(
          /<key>ProgramArguments<\/key>\s*<array>\s*<string>([\s\S]*?)<\/string>/,
          readFileSync(plistPath, "utf8"),
        );
        return command === undefined
          ? undefined
          : decodeXmlEntities(command).trim();
      }
      case "systemd-user": {
        const { service } = linuxUnitPaths(context.homeDir);
        if (!existsSync(service)) return undefined;
        const raw = matchGroup(
          /^ExecStart=(.+)$/m,
          readFileSync(service, "utf8"),
        );
        return raw === undefined ? undefined : unquotePath(raw);
      }
      case "crontab": {
        const content = crontab ?? (await readCrontab(context)).content;
        const line = content
          .split(/\r?\n/)
          .find((entry) => entry.includes(AUTOSTART_CRON_MARKER));
        if (!line) return undefined;
        const schedule = line
          .slice(0, line.indexOf(AUTOSTART_CRON_MARKER))
          .trim();
        const command = matchGroup(
          /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/,
          schedule,
        );
        return unquotePath(command ?? schedule);
      }
    }
  } catch {
    return undefined;
  }
}

/**
 * True when the registration no longer matches this build (R-5.2.3);
 * `undefined` when the OS entry does not expose its path.
 */
function staleRegistration(
  context: AutostartContext,
  registeredLauncherPath: string | undefined,
): boolean | undefined {
  let actualLauncher: string | null = null;
  try {
    actualLauncher = existsSync(context.launcherPath)
      ? readFileSync(context.launcherPath, "utf8")
      : null;
  } catch {
    // Unreadable launcher: stale, not silently fine.
  }
  const expectedLauncher = buildAutostartLauncherScript({
    platform: context.platform,
    invocation: context.invocation,
    env: context.env,
  });
  if (actualLauncher !== expectedLauncher) return true;
  if (registeredLauncherPath === undefined) return undefined;
  const normalize = (value: string) =>
    context.platform === "win32"
      ? value.replace(/\//g, "\\").toLowerCase()
      : value;
  return normalize(registeredLauncherPath) !== normalize(context.launcherPath);
}

function systemdUnitPresent(homeDir: string): boolean {
  const units = linuxUnitPaths(homeDir);
  const present = existsSync(units.service) || existsSync(units.timer);
  return present || existsSync(units.wantsTimer);
}

/** `systemctl --user is-enabled`, only meaningful inside a user session. */
async function systemdUnitEnabled(context: AutostartContext): Promise<boolean> {
  if (existsSync(linuxUnitPaths(context.homeDir).wantsTimer)) return true;
  if (!context.systemdAvailable) return false;
  const result = await context.runner({
    file: "systemctl",
    args: ["--user", "is-enabled", `${AUTOSTART_SYSTEMD_UNIT}.timer`],
  });
  return result.code === 0;
}

/**
 * Which Linux mechanism this machine is registered with: an existing unit
 * wins, then an existing crontab line, then the XDG hint (M4 #8).
 */
function resolveLinuxMethod(
  context: AutostartContext,
  crontab: { content: string; ok: boolean },
): AutostartMethod {
  if (context.method === "systemd-user" || context.method === "crontab") {
    return context.method;
  }
  if (systemdUnitPresent(context.homeDir)) return "systemd-user";
  if (crontab.ok && crontab.content.includes(AUTOSTART_CRON_MARKER)) {
    return "crontab";
  }
  return context.systemdAvailable ? "systemd-user" : "crontab";
}

function systemdServiceUnit(launcherPath: string): string {
  return [
    "[Unit]",
    "Description=Haruyuki scheduled task tick",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart="${launcherPath}"`,
    "",
  ].join("\n");
}

function systemdTimerUnit(): string {
  return [
    "[Unit]",
    "Description=Haruyuki scheduled task tick (every minute)",
    "",
    "[Timer]",
    "OnBootSec=1min",
    "OnUnitActiveSec=1min",
    "AccuracySec=1s",
    `Unit=${AUTOSTART_SYSTEMD_UNIT}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

function launchdPlist(launcherPath: string): string {
  const escaped = launcherPath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${AUTOSTART_LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escaped}</string>`,
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${AUTOSTART_INTERVAL_SECONDS}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function cronLine(launcherPath: string): string {
  return `* * * * * ${quoteForShell(launcherPath)} ${AUTOSTART_CRON_MARKER}`;
}

function crontabWithoutMarker(current: string): string {
  return current
    .split(/\r?\n/)
    .filter((line) => !line.includes(AUTOSTART_CRON_MARKER))
    .join("\n")
    .replace(/\n+$/, "");
}

async function readCrontab(
  context: AutostartContext,
): Promise<{ content: string; ok: boolean }> {
  const result = await context.runner({ file: "crontab", args: ["-l"] });
  // `crontab -l` exits 1 when the user has no crontab; that is not an error.
  if (result.code !== 0 && !/no crontab/i.test(result.stderr)) {
    return { content: "", ok: false };
  }
  return { content: result.stdout, ok: true };
}

// ── Register ───────────────────────────────────────────────────────

/**
 * Write the launcher and register (or overwrite) the single OS entry.
 *
 * Idempotent on every platform: Windows uses `/F`, the LaunchAgent plist is
 * rewritten and reloaded, systemd uses `enable --now`, and the crontab line is
 * keyed by {@link AUTOSTART_CRON_MARKER}.
 */
export async function registerAutostart(
  options: AutostartOptions = {},
): Promise<AutostartStatus> {
  const context = buildContext(options);
  if (typeof context === "string") {
    return {
      registered: false,
      platform: platformOf(options) as AutostartPlatform,
      method: null,
      error: context,
    };
  }

  try {
    writeLauncher(
      context.launcherPath,
      context.platform,
      buildAutostartLauncherScript({
        platform: context.platform,
        invocation: context.invocation,
        env: context.env,
      }),
    );

    switch (context.platform) {
      case "win32":
        return await registerWindows(context);
      case "darwin":
        return await registerLaunchd(context);
      case "linux": {
        // Registering prefers the mechanism this machine already uses: an
        // installed unit survives an XDG-less login shell, and without a user
        // manager the crontab is the only option (M4 #8).
        const systemd =
          context.method === "systemd-user" ||
          (context.method !== "crontab" &&
            (systemdUnitPresent(context.homeDir) || context.systemdAvailable));
        return systemd
          ? await registerSystemd(context)
          : await registerCrontab(context);
      }
    }
  } catch (err) {
    return {
      registered: false,
      platform: context.platform,
      method: methodFor(context),
      launcherPath: context.launcherPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function methodFor(context: AutostartContext): AutostartMethod {
  if (context.method !== null) return context.method;
  if (context.platform === "win32") return "schtasks";
  if (context.platform === "darwin") return "launchd";
  if (systemdUnitPresent(context.homeDir)) return "systemd-user";
  return context.systemdAvailable ? "systemd-user" : "crontab";
}

function buildContext(options: AutostartOptions): AutostartContext | string {
  const raw = platformOf(options);
  if (raw !== "win32" && raw !== "darwin" && raw !== "linux") {
    return `autostart is not supported on ${raw}`;
  }
  const env = options.env ?? process.env;
  return {
    platform: raw,
    homeDir: options.homeDir ?? resolveHomeDir(env),
    env,
    runner: options.runner ?? runProcess,
    launcherPath: resolveAutostartLauncherPath(options),
    invocation: options.invocation ?? resolveAutostartInvocation(env),
    systemdAvailable: options.systemd ?? Boolean(env.XDG_RUNTIME_DIR?.trim()),
    method: options.method ?? null,
    uid:
      options.uid ??
      (typeof process.getuid === "function" ? process.getuid() : 501),
  };
}

async function registerWindows(
  context: AutostartContext,
): Promise<AutostartStatus> {
  const method = "schtasks" as const;
  const result = await context.runner({
    file: "schtasks",
    args: [
      "/Create",
      "/F",
      "/SC",
      "MINUTE",
      "/MO",
      "1",
      "/TN",
      AUTOSTART_TASK_NAME,
      "/TR",
      `"${context.launcherPath}"`,
    ],
  });
  if (result.code !== 0)
    return failure({ platform: "win32", method }, context.launcherPath, result);
  return statusOf(context, method, true);
}

async function registerLaunchd(
  context: AutostartContext,
): Promise<AutostartStatus> {
  const method = "launchd" as const;
  const plistPath = launchAgentsPlistPath(context.homeDir);
  const domain = launchdDomain(context);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, launchdPlist(context.launcherPath), "utf8");

  // `bootout` + `bootstrap` replace the deprecated `load`/`unload` pair: the
  // bootout reloads, so a rewritten plist applies immediately (M4 #12).
  await context.runner({
    file: "launchctl",
    args: ["bootout", domain, plistPath],
  });
  const bootstrapped = await context.runner({
    file: "launchctl",
    args: ["bootstrap", domain, plistPath],
  });
  if (
    bootstrapped.code !== 0 &&
    !/already (loaded|bootstrapped)|Bootstrap failed: 37|Load failed: 37|service already loaded/i.test(
      bootstrapped.stderr,
    )
  ) {
    return failure(
      { platform: "darwin", method },
      context.launcherPath,
      bootstrapped,
    );
  }
  // `bootstrap` refuses a service marked disabled; `enable` clears that state.
  await context.runner({
    file: "launchctl",
    args: ["enable", `${domain}/${AUTOSTART_LAUNCHD_LABEL}`],
  });
  return statusOf(context, method, true);
}

async function registerSystemd(
  context: AutostartContext,
): Promise<AutostartStatus> {
  const method = "systemd-user" as const;
  const units = linuxUnitPaths(context.homeDir);
  mkdirSync(units.directory, { recursive: true });
  writeFileSync(
    units.service,
    systemdServiceUnit(context.launcherPath),
    "utf8",
  );
  writeFileSync(units.timer, systemdTimerUnit(), "utf8");

  const reload = await context.runner({
    file: "systemctl",
    args: ["--user", "daemon-reload"],
  });
  if (reload.code !== 0) {
    return failure({ platform: "linux", method }, context.launcherPath, reload);
  }
  const enable = await context.runner({
    file: "systemctl",
    args: ["--user", "enable", "--now", `${AUTOSTART_SYSTEMD_UNIT}.timer`],
  });
  if (enable.code !== 0) {
    return failure({ platform: "linux", method }, context.launcherPath, enable);
  }
  return statusOf(context, method, true);
}

async function registerCrontab(
  context: AutostartContext,
): Promise<AutostartStatus> {
  const method = "crontab" as const;
  const current = await readCrontab(context);
  if (!current.ok) {
    return failure({ platform: "linux", method }, context.launcherPath, {
      code: 1,
      stdout: "",
      stderr: "could not read the current crontab",
    });
  }
  const next = [
    crontabWithoutMarker(current.content),
    cronLine(context.launcherPath),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const written = await context.runner({
    file: "crontab",
    args: ["-"],
    stdin: `${next}\n`,
  });
  if (written.code !== 0) {
    return failure(
      { platform: "linux", method },
      context.launcherPath,
      written,
    );
  }
  return statusOf(context, method, true);
}

// ── Status ─────────────────────────────────────────────────────────

/**
 * Read the registration state. The mechanism is probed from the machine's own
 * artifacts, never re-decided from `XDG_RUNTIME_DIR` (M4 #8); `stale` exposes
 * a registration left by an older install path (M4 #11).
 */
export async function getAutostartStatus(
  options: AutostartOptions = {},
): Promise<AutostartStatus> {
  const context = buildContext(options);
  if (typeof context === "string") {
    return {
      registered: false,
      platform: platformOf(options) as AutostartPlatform,
      method: null,
      error: context,
    };
  }
  const registrationInfo = (
    registeredPath: string | undefined,
  ): Pick<AutostartStatus, "registeredLauncherPath" | "stale"> => ({
    // Explicitly `undefined` when the entry does not expose its path: the
    // optimistic value from `statusOf` must not be reported as the real one.
    registeredLauncherPath: registeredPath,
    stale: staleRegistration(context, registeredPath) ?? false,
  });
  try {
    switch (context.platform) {
      case "win32": {
        const result = await context.runner({
          file: "schtasks",
          args: ["/Query", "/TN", AUTOSTART_TASK_NAME],
        });
        if (result.code !== 0) return statusOf(context, "schtasks", false);
        const registeredPath = await readRegisteredLauncherPath(
          context,
          "schtasks",
        );
        return {
          ...statusOf(context, "schtasks", true),
          ...registrationInfo(registeredPath),
        };
      }
      case "darwin": {
        const plistPath = launchAgentsPlistPath(context.homeDir);
        if (!existsSync(plistPath)) return statusOf(context, "launchd", false);
        const result = await context.runner({
          file: "launchctl",
          args: ["list", AUTOSTART_LAUNCHD_LABEL],
        });
        if (result.code !== 0) return statusOf(context, "launchd", false);
        const registeredPath = await readRegisteredLauncherPath(
          context,
          "launchd",
        );
        return {
          ...statusOf(context, "launchd", true),
          ...registrationInfo(registeredPath),
        };
      }
      case "linux": {
        const crontab = await readCrontab(context);
        const method = resolveLinuxMethod(context, crontab);
        if (method === "systemd-user") {
          const units = linuxUnitPaths(context.homeDir);
          const present = existsSync(units.service) || existsSync(units.timer);
          if (!present || !(await systemdUnitEnabled(context))) {
            return statusOf(context, method, false);
          }
          const registeredPath = await readRegisteredLauncherPath(
            context,
            "systemd-user",
          );
          return {
            ...statusOf(context, method, true),
            ...registrationInfo(registeredPath),
          };
        }
        if (!crontab.ok) {
          return {
            ...statusOf(context, method, false),
            error: "could not read the current crontab",
          };
        }
        if (!crontab.content.includes(AUTOSTART_CRON_MARKER)) {
          return statusOf(context, method, false);
        }
        const registeredPath = await readRegisteredLauncherPath(
          context,
          "crontab",
          crontab.content,
        );
        return {
          ...statusOf(context, method, true),
          ...registrationInfo(registeredPath),
        };
      }
    }
  } catch (err) {
    return {
      registered: false,
      platform: context.platform,
      method: methodFor(context),
      launcherPath: context.launcherPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Unregister ─────────────────────────────────────────────────────

/**
 * Remove the OS entry. Only an explicit shutdown calls this (Q-43). On Linux
 * both mechanisms are cleaned when their artifacts are present, never decided
 * from `XDG_RUNTIME_DIR`, so `off` over SSH still removes the desktop timer
 * (M4 #8).
 */
export async function unregisterAutostart(
  options: AutostartOptions = {},
): Promise<AutostartStatus> {
  const context = buildContext(options);
  if (typeof context === "string") {
    return {
      registered: false,
      platform: platformOf(options) as AutostartPlatform,
      method: null,
      error: context,
    };
  }

  try {
    if (context.platform === "win32") {
      await context.runner({
        file: "schtasks",
        args: ["/Delete", "/TN", AUTOSTART_TASK_NAME, "/F"],
      });
    } else if (context.platform === "darwin") {
      const plistPath = launchAgentsPlistPath(context.homeDir);
      // bootout stops the agent now; removing the plist alone would leave it
      // running until the next login.
      await context.runner({
        file: "launchctl",
        args: ["bootout", launchdDomain(context), plistPath],
      });
      rmSync(plistPath, { force: true });
    } else {
      const crontab = await readCrontab(context);
      const units = linuxUnitPaths(context.homeDir);
      if (resolveLinuxMethod(context, crontab) === "systemd-user") {
        await context.runner({
          file: "systemctl",
          args: [
            "--user",
            "disable",
            "--now",
            `${AUTOSTART_SYSTEMD_UNIT}.timer`,
          ],
        });
        rmSync(units.timer, { force: true });
        rmSync(units.service, { force: true });
        rmSync(units.wantsTimer, { force: true });
        await context.runner({
          file: "systemctl",
          args: ["--user", "daemon-reload"],
        });
      }
      if (crontab.ok && crontab.content.includes(AUTOSTART_CRON_MARKER)) {
        const next = crontabWithoutMarker(crontab.content);
        await context.runner({
          file: "crontab",
          args: ["-"],
          stdin: `${next}${next.length > 0 ? "\n" : ""}`,
        });
      }
    }

    // Report the postcondition rather than assuming the delete worked: an
    // already-absent entry is success, a still-registered one is an error.
    return await getAutostartStatus(options);
  } catch (err) {
    return {
      registered: false,
      platform: context.platform,
      method: methodFor(context),
      launcherPath: context.launcherPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Diagnostics ────────────────────────────────────────────────────

/** Read the launcher script back; used by tests and by `schedule status`. */
export function readAutostartLauncher(
  options: AutostartOptions = {},
): string | null {
  const path = resolveAutostartLauncherPath(options);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
