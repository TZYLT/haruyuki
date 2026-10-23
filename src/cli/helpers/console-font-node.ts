import { spawn } from "node:child_process";
import type {
  ConsoleFont,
  ConsoleFontPort,
  ConsoleFontTarget,
} from "./console-font";

/**
 * The console-font port for Node: a PowerShell helper that owns the Win32 calls.
 *
 * ## Why a child process
 *
 * `SetCurrentConsoleFontEx` is a Win32 call with no escape-sequence equivalent, so
 * the guard needs native access. Bun has `bun:ffi`; **Node has no FFI at all**, and
 * this fork does not ship native addons (the published CLI is a plain Node program,
 * see `AGENTS.md`). Before this module existed the Node path stood down with a log
 * line, and since the published artifact *is* `node haruyuki.js`, the guard never
 * ran for the user at all — which is why several rounds of "fix the font flip" never
 * changed what the user saw (2026-10-23).
 *
 * Windows lets any process attached to a console read and write that console's font
 * through `CONOUT$`; it is the same console handle the parent is drawing into. So a
 * long-lived `powershell.exe` child, spawned once and fed one JSON line per query,
 * is a portable FFI: `GetCurrentConsoleFontEx` to read, `SetCurrentConsoleFontEx`
 * to repair.
 *
 * ## Why the helper starts in its own console and then attaches
 *
 * Measured on 2026-10-23 in a real conhost: **starting Windows PowerShell 5.1 in a
 * console flips that console's TrueType face to the raster `Terminal` 8×12**. A
 * no-op `powershell.exe -NoProfile -Command "exit 0"` does it, `-EncodedCommand`
 * does it, and `cmd.exe`/`node.exe` children do not. PowerShell's start-up re-applies
 * console properties, and on a console it did not create that application lands on
 * the raster face. That is the user's "调用工具或者轮结束会自动换到最小号点阵字体":
 * the TUI spawns PowerShell in several paths (shell launchers, process start times,
 * archive extraction), so every such spawn used to flip the font.
 *
 * A helper that shared the TUI's console at spawn time would therefore flip the very
 * font it exists to protect, on every session start. So the child is spawned with
 * `windowsHide` (`CREATE_NO_WINDOW`): it gets its own hidden console, Windows
 * PowerShell re-applies its properties *there*, and nothing of it reaches the TUI.
 * After its own start-up it calls `FreeConsole()` + `AttachConsole(<tui pid>)` and
 * works on the console the user is looking at. Measured: the parent kept `Consolas`
 * across the child's start-up and reported the helper's write as its own font.
 *
 * A console that still does not answer (a ConPTY host, a parent with no console)
 * fails the attach, the handshake reports it, and the guard stands down with one log
 * line instead of repairing a window nobody can see.
 *
 * ## Cost, and why it is still fine
 *
 * PowerShell startup plus the `Add-Type` compile is 1-2 seconds, paid **once** per
 * session at the first frame (the guard is armed fire-and-forget, so the frame is
 * not delayed), and every later check is one line in and one line out. A check
 * every 250 ms is therefore still free, and a dead helper degrades to one logged
 * line: `read()` answers `null`, which the guard already treats as "this console
 * does not answer" and stops on.
 *
 * ## The protocol
 *
 * One UTF-8 JSON object per line, both directions:
 *
 * ```
 * helper  -> {"ok":true,"op":"ready","faces":["Consolas",...]}
 * parent  -> {"op":"read"}
 * helper  -> {"ok":true,"face":"Consolas","cellWidth":9,"cellHeight":18,...}
 * parent  -> {"op":"apply","face":"Consolas","cellHeight":18,"weight":400}
 * helper  -> {"ok":true}
 * ```
 *
 * The helper builds these with hand-written JSON (the C# side escapes the face
 * name) so no reply depends on `ConvertTo-Json`'s formatting. Requests are
 * serialized here — one in flight, the rest queued — because a `SetCurrentConsoleFontEx`
 * that overtook its read-back would make the guard judge a stale answer.
 *
 * The script is **inlined as a string** rather than shipped as a `.ps1`: nothing in
 * `package.json` `files` would carry a loose script next to the bundle, and a build
 * step that has to remember to copy a resource is a step that eventually gets
 * dropped. `-EncodedCommand` (UTF-16LE base64) means no quoting layer either.
 */

/** Startup is dominated by `Add-Type`; a cold machine can take a few seconds. */
const STARTUP_TIMEOUT_MS = 8000;

/** A single line query is microseconds; anything near this is a wedged child. */
const REQUEST_TIMEOUT_MS = 3000;

/**
 * The helper program: one `Add-Type`, then a line loop.
 *
 * Everything here runs in Windows PowerShell 5.1, which is why it reads the font
 * registry through `Get-Item` rather than the .NET registry API and why the JSON is
 * assembled by hand. The two byte-order marks are deliberately absent: the parent
 * writes UTF-8 without a BOM and the reader is created with the same encoding.
 */
export const CONSOLE_FONT_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class HaruyukiConsoleFont
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CONSOLE_FONT_INFOEX
    {
        public uint cbSize;
        public uint nFont;
        public short dwFontSizeX;
        public short dwFontSizeY;
        public int FontFamily;
        public int FontWeight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FaceName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetCurrentConsoleFontEx(IntPtr handle, bool largest, ref CONSOLE_FONT_INFOEX info);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetCurrentConsoleFontEx(IntPtr handle, bool largest, ref CONSOLE_FONT_INFOEX info);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    private const uint GENERIC_READ_WRITE = 0xC0000000;
    private static IntPtr consoleHandle = IntPtr.Zero;

    private static IntPtr Handle()
    {
        if (consoleHandle == IntPtr.Zero)
        {
            consoleHandle = CreateFileW("CONOUT$", GENERIC_READ_WRITE, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        }
        return consoleHandle;
    }

    private static string Escape(string value)
    {
        if (value == null) return "";
        StringBuilder text = new StringBuilder(value.Length + 8);
        foreach (char c in value)
        {
            if (c == '"' || c == '\\\\') text.Append('\\\\').Append(c);
            else if (c < ' ') text.Append(' ');
            else text.Append(c);
        }
        return text.ToString();
    }

    public static string ReadJson()
    {
        IntPtr handle = Handle();
        if (handle == IntPtr.Zero || handle.ToInt64() == -1)
        {
            return "{\\"ok\\":false,\\"error\\":\\"open\\",\\"win32\\":" + Marshal.GetLastWin32Error() + "}";
        }
        CONSOLE_FONT_INFOEX info = new CONSOLE_FONT_INFOEX();
        info.cbSize = (uint)Marshal.SizeOf(typeof(CONSOLE_FONT_INFOEX));
        info.FaceName = "";
        if (!GetCurrentConsoleFontEx(handle, false, ref info))
        {
            return "{\\"ok\\":false,\\"error\\":\\"read\\",\\"win32\\":" + Marshal.GetLastWin32Error() + "}";
        }
        return "{\\"ok\\":true,\\"face\\":\\"" + Escape(info.FaceName) + "\\",\\"cellWidth\\":" + info.dwFontSizeX +
            ",\\"cellHeight\\":" + info.dwFontSizeY + ",\\"family\\":" + info.FontFamily +
            ",\\"weight\\":" + info.FontWeight + "}";
    }

    public static string ApplyJson(string face, int cellHeight, int weight)
    {
        IntPtr handle = Handle();
        if (handle == IntPtr.Zero || handle.ToInt64() == -1)
        {
            return "{\\"ok\\":false,\\"error\\":\\"open\\",\\"win32\\":" + Marshal.GetLastWin32Error() + "}";
        }
        CONSOLE_FONT_INFOEX info = new CONSOLE_FONT_INFOEX();
        info.cbSize = (uint)Marshal.SizeOf(typeof(CONSOLE_FONT_INFOEX));
        info.dwFontSizeX = 0;
        info.dwFontSizeY = (short)cellHeight;
        info.FontFamily = 54;
        info.FontWeight = weight;
        info.FaceName = face == null ? "" : face;
        if (!SetCurrentConsoleFontEx(handle, false, ref info))
        {
            return "{\\"ok\\":false,\\"error\\":\\"set\\",\\"win32\\":" + Marshal.GetLastWin32Error() + "}";
        }
        return "{\\"ok\\":true}";
    }
}
'@
} catch {
  $writer.WriteLine('{"ok":false,"op":"ready","error":"add-type"}')
  exit 1
}
$attachPid = 0
if ($env:HARUYUKI_CONSOLE_FONT_ATTACH_PID) { $attachPid = [uint32]$env:HARUYUKI_CONSOLE_FONT_ATTACH_PID }
$attached = $false
if ($attachPid -ne 0) {
  [HaruyukiConsoleFont]::FreeConsole() | Out-Null
  $attached = [HaruyukiConsoleFont]::AttachConsole($attachPid)
}
if (-not $attached) {
  $writer.WriteLine('{"ok":false,"op":"ready","error":"attach"}')
  exit 1
}
$faces = New-Object System.Collections.Generic.List[string]
foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')) {
  if (Test-Path $root) {
    foreach ($name in (Get-Item $root).Property) {
      $trimmed = $name -replace '\\s*\\((TrueType|OpenType)\\)\\s*$', ''
      foreach ($part in ($trimmed -split '\\s*&\\s*')) {
        $face = $part.Trim()
        if ($face.Length -gt 0 -and -not $faces.Contains($face)) { $faces.Add($face) }
      }
    }
  }
}
$jsonFaces = New-Object System.Collections.Generic.List[string]
foreach ($face in $faces) {
  $jsonFaces.Add('"' + $face.Replace('\\', '\\\\').Replace('"', '\\"') + '"')
}
$writer.WriteLine('{"ok":true,"op":"ready","faces":[' + ($jsonFaces -join ',') + ']}')
while ($true) {
  $line = $reader.ReadLine()
  if ($line -eq $null) { break }
  if ($line.Trim().Length -eq 0) { continue }
  try {
    $request = $line | ConvertFrom-Json
    $op = [string]$request.op
    if ($op -eq 'read') {
      $writer.WriteLine([HaruyukiConsoleFont]::ReadJson())
    } elseif ($op -eq 'apply') {
      $writer.WriteLine([HaruyukiConsoleFont]::ApplyJson([string]$request.face, [int]$request.cellHeight, [int]$request.weight))
    } else {
      $writer.WriteLine('{"ok":false,"error":"unknown-op"}')
    }
  } catch {
    $message = $_.Exception.Message.Replace('\\', '\\\\').Replace('"', '\\"')
    $message = $message -replace '[\\r\\n]+', ' '
    $writer.WriteLine('{"ok":false,"error":"' + $message + '"}')
  }
}
`;

/** One parsed reply from the helper. Unknown fields are ignored on purpose. */
export interface ConsoleFontHelperReply {
  ok: boolean;
  op?: string;
  face?: string;
  cellWidth?: number;
  cellHeight?: number;
  family?: number;
  weight?: number;
  faces?: string[];
  error?: string;
  win32?: number;
}

/**
 * Read one helper line as a reply, or `null` when it is not one.
 *
 * Anything that is not a JSON object carrying a boolean `ok` is discarded: the
 * helper is the only writer on that pipe, but a PowerShell warning or a stray
 * `Write-Host` must never be mistaken for an answer — and a `null` here is what
 * makes the guard treat a garbled console as unavailable instead of repairing.
 */
export function parseConsoleFontHelperReply(
  line: string,
): ConsoleFontHelperReply | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return null;
  const reply: ConsoleFontHelperReply = { ok: record.ok };
  if (typeof record.op === "string") reply.op = record.op;
  if (typeof record.face === "string") reply.face = record.face;
  const numeric = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const cellWidth = numeric(record.cellWidth);
  const cellHeight = numeric(record.cellHeight);
  const family = numeric(record.family);
  const weight = numeric(record.weight);
  const win32 = numeric(record.win32);
  if (cellWidth !== undefined) reply.cellWidth = cellWidth;
  if (cellHeight !== undefined) reply.cellHeight = cellHeight;
  if (family !== undefined) reply.family = family;
  if (weight !== undefined) reply.weight = weight;
  if (win32 !== undefined) reply.win32 = win32;
  if (Array.isArray(record.faces)) {
    reply.faces = record.faces.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (typeof record.error === "string") reply.error = record.error;
  return reply;
}

/** The readable half of a spawned helper, with the two methods used here. */
interface HelperReadable {
  on: NodeJS.ReadableStream["on"];
  setEncoding?(encoding: BufferEncoding): unknown;
  unref?(): void;
}

/** The writable half of a spawned helper. */
interface HelperWritable {
  write(chunk: string): boolean;
  end(): void;
  unref?(): void;
}

interface HelperChild {
  stdin: HelperWritable | null;
  stdout: HelperReadable | null;
  stderr: HelperReadable | null;
  kill(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  unref?(): void;
}

export interface OpenConsoleFontHelperPortOptions {
  /** Test seam: replace `child_process.spawn`. */
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  /**
   * Whose console the helper should attach to.
   *
   * The caller's own process by default: the guard runs inside the TUI, and the TUI's
   * console is the window the user is looking at. It is an explicit pid rather than
   * "my parent" because a console app launched from Explorer or a wrapper is not
   * necessarily a child of the shell that owns the console.
   */
  attachPid?: number;
  /** One-line diagnostics; the runtime passes `debugLog`. */
  log?: (message: string) => void;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * The Windows PowerShell that every Windows install has.
 *
 * `SystemRoot` is read from the caller's environment rather than hard-coded so a
 * test (and a relocated Windows) can point at a different tree.
 */
export function consoleFontHelperExecutable(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** The argv for the helper: no profile, no logo, and the script in one blob. */
export function consoleFontHelperArgs(script: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/** Resolve `line`-delimited stdout into whole lines, UTF-8 safe across chunks. */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      onLine(line);
    }
  };
}

/**
 * Start the helper and return a port speaking to it, or `null` when it cannot run.
 *
 * Every failure path is one debug line plus `null`: the helper is an optimisation
 * for a console bug, not something the TUI may crash over. The child is unref'd so
 * a session that exits does not wait for PowerShell, and `close()` terminates it
 * when the guard stops or the mode changes.
 */
export async function openConsoleFontHelperPort(
  options: OpenConsoleFontHelperPortOptions = {},
): Promise<ConsoleFontPort | null> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const spawnImpl = options.spawnImpl ?? spawn;
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const attachPid = options.attachPid ?? process.pid;
  const executable = consoleFontHelperExecutable(env);
  const args = consoleFontHelperArgs(CONSOLE_FONT_HELPER_SCRIPT);

  let child: HelperChild;
  try {
    // `windowsHide` is load-bearing, not cosmetic: `CREATE_NO_WINDOW` gives the child
    // its **own** (invisible) console, so Windows PowerShell's start-up re-applies its
    // console properties there instead of on the TUI's console — that re-application
    // is what drops the window to the raster font (see the header). The helper then
    // attaches to `attachPid`'s console itself.
    child = spawnImpl(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, HARUYUKI_CONSOLE_FONT_ATTACH_PID: String(attachPid) },
      windowsHide: true,
    }) as unknown as HelperChild;
  } catch (error) {
    log(`helper did not spawn: ${String(error)}`);
    return null;
  }

  if (child.stdout === null || child.stdin === null) {
    log("helper spawned without pipes");
    child.kill();
    return null;
  }

  child.stdout.setEncoding?.("utf8");
  child.stdin.unref?.();
  child.stdout.unref?.();
  child.stderr?.unref?.();
  child.unref?.();

  let dead = false;
  let faces: readonly string[] | null = null;
  let pending: {
    resolve: (reply: ConsoleFontHelperReply | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let startup: {
    resolve: (reply: ConsoleFontHelperReply | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let stderrTail = "";

  const settle = (reply: ConsoleFontHelperReply | null): void => {
    if (pending !== null) {
      clearTimeout(pending.timer);
      const { resolve } = pending;
      pending = null;
      resolve(reply);
    }
    if (startup !== null) {
      clearTimeout(startup.timer);
      const { resolve } = startup;
      startup = null;
      resolve(reply);
    }
  };

  const fail = (reason: string): void => {
    if (dead) return;
    dead = true;
    log(
      `${reason}${stderrTail === "" ? "" : `: ${stderrTail.trim().slice(-300)}`}`,
    );
    settle(null);
    // A helper that stopped answering may still be alive; nothing is going to read
    // its pipes again, so do not leave it behind.
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };

  child.stdout.on(
    "data",
    lineReader((line) => {
      const reply = parseConsoleFontHelperReply(line);
      if (reply === null) return;
      if (reply.op === "ready") {
        if (reply.ok) faces = reply.faces ?? [];
        if (startup !== null) {
          clearTimeout(startup.timer);
          const { resolve } = startup;
          startup = null;
          resolve(reply.ok ? reply : null);
        }
        return;
      }
      if (pending !== null) {
        clearTimeout(pending.timer);
        const { resolve } = pending;
        pending = null;
        resolve(reply);
      }
    }),
  );
  child.stderr?.on("data", (chunk: unknown) => {
    if (typeof chunk === "string") {
      stderrTail = `${stderrTail}${chunk}`.slice(-600);
    }
  });
  child.on("error", (error: unknown) => {
    fail(`helper failed: ${String(error)}`);
  });
  child.on("exit", (code: unknown) => {
    fail(`helper exited (${String(code)})`);
  });

  const request = (
    payload: Record<string, unknown>,
  ): Promise<ConsoleFontHelperReply | null> => {
    const run = tail.then(
      () =>
        new Promise<ConsoleFontHelperReply | null>((resolve) => {
          if (dead || child.stdin === null) {
            resolve(null);
            return;
          }
          pending = {
            resolve,
            timer: setTimeout(() => {
              fail("helper stopped answering");
              settle(null);
            }, requestTimeoutMs),
          };
          try {
            child.stdin.write(`${JSON.stringify(payload)}\n`);
          } catch (error) {
            fail(`helper write failed: ${String(error)}`);
            settle(null);
          }
        }),
    );
    tail = run.catch(() => undefined);
    return run;
  };

  const ready = await new Promise<ConsoleFontHelperReply | null>((resolve) => {
    startup = {
      resolve,
      timer: setTimeout(() => {
        startup = null;
        resolve(null);
      }, startupTimeoutMs),
    };
  });
  if (ready === null) {
    fail("helper did not report ready");
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    return null;
  }

  const toFont = (reply: ConsoleFontHelperReply): ConsoleFont => ({
    face: reply.face ?? "",
    cellWidth: reply.cellWidth ?? 0,
    cellHeight: reply.cellHeight ?? 0,
    family: reply.family ?? 0,
    weight: reply.weight ?? 0,
  });

  return {
    async read(): Promise<ConsoleFont | null> {
      const reply = await request({ op: "read" });
      if (reply === null || !reply.ok) return null;
      const font = toFont(reply);
      // An empty face is a failed read, not a font: conhost never reports that.
      return font.face === "" ? null : font;
    },
    async apply(target: ConsoleFontTarget): Promise<boolean> {
      const reply = await request({
        op: "apply",
        face: target.face,
        cellHeight: target.cellHeight,
        weight: target.weight,
      });
      return reply?.ok === true;
    },
    async listFaces(): Promise<readonly string[] | null> {
      return faces;
    },
    close(): void {
      if (dead) return;
      dead = true;
      settle(null);
      try {
        child.stdin?.end();
      } catch {
        // The pipe is already gone.
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
  };
}
