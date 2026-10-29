/**
 * Launcher bodies for the OS autostart entry (F-05).
 *
 * Windows runs the launcher through `wscript.exe`, a GUI-subsystem host: the
 * scheduled `schedule tick` starts with no console window. The previous `.cmd`
 * entry flashed one every minute because Task Scheduler gives a console program
 * a window.
 *
 * The script pins the invocation and the `HARUYUKI_HOME` override, builds the
 * command line with `Chr(34)` so a path with spaces works, and runs it through
 * `shell.Run cmd, 0, False`: window style 0 is hidden, and the call returns
 * without waiting. macOS/Linux keep the POSIX shell launcher.
 *
 * Lives beside `autostart.ts` rather than inside it because that module is at
 * the source-file-size ceiling; this payload builder has no other dependency.
 */

export interface AutostartLauncherInvocation {
  command: string;
  args: string[];
}

/** Single-quote a value for a POSIX shell (the crontab line uses this too). */
export function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for a VBScript string literal: a quote is escaped by doubling. */
function vbLiteral(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function windowsLauncherScript(
  invocation: AutostartLauncherInvocation,
  home: string | undefined,
): string {
  const quoted = (part: string) => `Chr(34) & ${vbLiteral(part)} & Chr(34)`;
  const commandLine = [invocation.command, ...invocation.args]
    .map(quoted)
    .join(' & " " & ');
  const lines = [
    "rem Written by Haruyuki F-05 autostart. Removed by `haruyuki schedule autostart off`.",
    'Set shell = CreateObject("WScript.Shell")',
  ];
  if (home) {
    lines.push(
      `shell.Environment("Process")("HARUYUKI_HOME") = ${vbLiteral(home)}`,
    );
  }
  lines.push(
    `cmd = ${commandLine} & " schedule tick"`,
    "shell.Run cmd, 0, False",
    "",
  );
  return lines.join("\r\n");
}

/** The launcher body the OS entry references, for one platform. */
export function buildAutostartLauncherScript(input: {
  platform: NodeJS.Platform;
  invocation: AutostartLauncherInvocation;
  env: NodeJS.ProcessEnv;
}): string {
  const home = input.env.HARUYUKI_HOME?.trim();
  if (input.platform === "win32") {
    return windowsLauncherScript(input.invocation, home);
  }

  const commandLine = [input.invocation.command, ...input.invocation.args]
    .map(quoteForShell)
    .join(" ");
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
