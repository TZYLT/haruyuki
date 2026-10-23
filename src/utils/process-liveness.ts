import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Signal 0 checks existence without delivering anything; EPERM means alive but not ours. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Options for the Win32 start-time query, and `windowsHide` is load-bearing.
 *
 * Measured on 2026-10-23 in a real conhost: starting Windows PowerShell 5.1 inside a
 * console re-applies console properties on start-up and drops the window from its
 * TrueType face to the raster `Terminal` 8×12 — a no-op `powershell -Command "exit
 * 0"` does it, `cmd.exe` and `node.exe` do not. This call runs for lock and memory
 * reconciliation, i.e. around turn boundaries, which is one of the paths that made
 * the TUI's font flip "when a turn ends". `windowsHide` gives the child its own
 * (invisible) console via `CREATE_NO_WINDOW`, so its start-up cannot touch the
 * terminal's window; the start time still comes back over the pipe. A/B: without
 * the flag the parent read back `Terminal|8|12`, with it `Consolas|9|18`.
 */
export const WINDOWS_START_TIME_OPTIONS: Readonly<{ windowsHide: boolean }> = {
  windowsHide: true,
};

/**
 * Start time of a process as the OS reports it, or null when it cannot be
 * read. Rendered in UTC with the C locale so every process on the machine
 * produces the same string for the same pid regardless of its own TZ.
 */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } =
      process.platform === "win32"
        ? await promisify(execFile)(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
            ],
            WINDOWS_START_TIME_OPTIONS,
          )
        : await promisify(execFile)(
            "ps",
            ["-o", "lstart=", "-p", String(pid)],
            { env: { ...process.env, TZ: "UTC", LC_ALL: "C" } },
          );
    const started = stdout.trim();
    return started.length > 0 ? started : null;
  } catch {
    return null;
  }
}

let ownStartTime: Promise<string | null> | undefined;

/** This process's own start time, resolved once; it cannot change. */
export function getOwnProcessStartTime(): Promise<string | null> {
  ownStartTime ??= getProcessStartTime(process.pid);
  return ownStartTime;
}

export interface ProcessIdentity {
  pid: number;
  /** Start time from getProcessStartTime, so a reused pid is not mistaken for the original. */
  started?: string;
}

/**
 * Is the recorded process still the one running under that pid? Liveness
 * alone is not enough because pids are recycled; a recorded start time settles
 * it. Without one, or when the OS cannot report it, liveness decides.
 */
export async function isSameProcessRunning(
  identity: ProcessIdentity,
): Promise<boolean> {
  if (!isProcessAlive(identity.pid)) return false;
  if (!identity.started) return true;
  const started = await getProcessStartTime(identity.pid);
  return started === null || started === identity.started;
}
