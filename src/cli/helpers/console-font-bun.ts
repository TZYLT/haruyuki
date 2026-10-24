import { loadSettings } from "@/settings";
import { debugLog } from "@/utils/debug";
import {
  type ConsoleFont,
  type ConsoleFontGuard,
  type ConsoleFontMode,
  type ConsoleFontPort,
  type ConsoleFontTarget,
  chooseConsoleFace,
  consoleFontTargetFor,
  DEFAULT_CONSOLE_FONT,
  parseConsoleFontMode,
  startConsoleFontGuard,
} from "./console-font";
import { openConsoleFontHelperPort } from "./console-font-node";

/**
 * The real console-font port, and the runtime entry that arms the guard.
 *
 * ## Why the name still says "bun"
 *
 * The file started as the `bun:ffi` port and every call site imports it as the
 * runtime entry, so it keeps its name while now covering **both** runtimes. The
 * historical restriction — "Node has no FFI, so the guard stands down there" — was
 * the reason several rounds of "fix the console font flip" changed nothing for the
 * user: the published artifact is `node haruyuki.js`, so the guard never armed
 * (2026-10-23). The Node path now goes through `./console-font-node.ts`, a
 * PowerShell helper that shares this console's `CONOUT$`.
 *
 * ## The FFI surface
 *
 * Three `kernel32` entry points and one 84-byte struct, laid out by hand because
 * `CONSOLE_FONT_INFOEX` has no binding:
 *
 * ```
 *   0  uint32  cbSize
 *   4  uint32  nFont
 *   8  int16   dwFontSize.X      (cell width)
 *  10  int16   dwFontSize.Y      (cell height)
 *  12  int32   FontFamily
 *  16  int32   FontWeight
 *  20  wchar[32] FaceName
 * ```
 *
 * The console handle is `CONOUT$` opened by name rather than `GetStdHandle`, because
 * the handle has to be a *console* handle even when stdout is a pipe — which it is
 * during `bun test` and in every captured run.
 */

/** How often the console is asked what it is drawing with. */
const CHECK_INTERVAL_MS = 250;

/**
 * `FF_MODERN | TMPF_VECTOR | TMPF_TRUETYPE`.
 *
 * Both faces measured on this machine report it (0x36), and it is what conhost's own
 * font picker writes for a scalable face, so it is the family a repair asks for.
 */
const TRUE_TYPE_FAMILY = 0x36;

const FONT_INFO_SIZE = 84;
const FACE_NAME_OFFSET = 20;
const MAX_FACE_NAME_CHARS = 31;

const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_EXISTING = 3;

/** The parts of Bun's FFI this module uses, untyped: `dlopen` is dynamic. */
interface FfiBindings {
  CreateFileW(
    name: unknown,
    access: number,
    share: number,
    security: unknown,
    disposition: number,
    flags: number,
    template: unknown,
  ): number;
  GetCurrentConsoleFontEx(
    handle: number,
    largest: boolean,
    info: unknown,
  ): boolean;
  SetCurrentConsoleFontEx(
    handle: number,
    largest: boolean,
    info: unknown,
  ): boolean;
}

interface FfiModule {
  dlopen(
    name: string,
    definitions: Record<string, { args: string[]; returns: string }>,
  ): { symbols: FfiBindings };
  ptr(buffer: Uint8Array): unknown;
}

const UTF16_CONOUT = (() => {
  const bytes = new Uint8Array("CONOUT$".length * 2 + 2);
  const view = new DataView(bytes.buffer);
  for (const [index, char] of [..."CONOUT$"].entries()) {
    view.setUint16(index * 2, char.charCodeAt(0), true);
  }
  return bytes;
})();

function emptyFontInfo(): Uint8Array {
  const bytes = new Uint8Array(FONT_INFO_SIZE);
  new DataView(bytes.buffer).setUint32(0, FONT_INFO_SIZE, true);
  return bytes;
}

function writeFaceName(bytes: Uint8Array, face: string): void {
  const view = new DataView(bytes.buffer);
  const chars = [...face].slice(0, MAX_FACE_NAME_CHARS);
  for (const [index, char] of chars.entries()) {
    view.setUint16(FACE_NAME_OFFSET + index * 2, char.charCodeAt(0), true);
  }
}

function readConsoleFont(bytes: Uint8Array): ConsoleFont {
  const view = new DataView(bytes.buffer);
  let face = "";
  for (let index = 0; index < MAX_FACE_NAME_CHARS + 1; index += 1) {
    const code = view.getUint16(FACE_NAME_OFFSET + index * 2, true);
    if (code === 0) break;
    face += String.fromCharCode(code);
  }
  return {
    face,
    cellWidth: view.getInt16(8, true),
    cellHeight: view.getInt16(10, true),
    family: view.getInt32(12, true),
    weight: view.getInt32(16, true),
  };
}

/**
 * Why the guard must stand down here, or `null` when it can work.
 *
 * The guard is for the legacy console host: there the window's font is a property of
 * the console the app is attached to, so the app can write it. Under Windows
 * Terminal, VS Code, ConEmu or any ConPTY host the font belongs to the terminal's own
 * settings and the console behind `CONOUT$` is one nobody looks at, so standing down
 * is both cheaper and more honest than "repairing" an invisible console.
 */
export function consoleFontGuardVeto(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (process.platform !== "win32") return "not a Windows console";
  if (process.stdout.isTTY !== true) return "stdout is not a console";
  if (env.WT_SESSION || env.WT_PROFILE_ID) {
    return "the font belongs to Windows Terminal, not to the console behind CONOUT$";
  }
  if (env.TERM_PROGRAM?.toLowerCase().includes("vscode")) {
    return "the font belongs to VS Code's terminal, not to the console behind CONOUT$";
  }
  if (env.ConEmuANSI) {
    return "the font belongs to ConEmu, not to the console behind CONOUT$";
  }
  return null;
}

/**
 * Whether the guard can do anything here.
 *
 * Both runtimes are supported now: Bun in process, Node through the PowerShell
 * helper. The remaining vetoes are about *which* console owns the window.
 */
export function consoleFontGuardAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return consoleFontGuardVeto(env) === null;
}

/**
 * The `bun:ffi` port.
 *
 * `bun:ffi` is imported through a variable so a Node bundle never has to resolve
 * it: the specifier only exists inside Bun.
 */
async function openBunConsoleFontPort(): Promise<ConsoleFontPort | null> {
  let ffi: FfiModule;
  try {
    const specifier = "bun:ffi";
    ffi = (await import(specifier)) as FfiModule;
  } catch {
    return null;
  }

  const { symbols } = ffi.dlopen("kernel32.dll", {
    CreateFileW: {
      args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"],
      returns: "ptr",
    },
    GetCurrentConsoleFontEx: { args: ["ptr", "bool", "ptr"], returns: "bool" },
    SetCurrentConsoleFontEx: { args: ["ptr", "bool", "ptr"], returns: "bool" },
  });

  const handle = symbols.CreateFileW(
    ffi.ptr(UTF16_CONOUT),
    GENERIC_READ_WRITE,
    3,
    null,
    OPEN_EXISTING,
    0,
    null,
  );
  if (handle === 0 || handle === -1) return null;

  return {
    async read(): Promise<ConsoleFont | null> {
      const info = emptyFontInfo();
      return symbols.GetCurrentConsoleFontEx(handle, false, ffi.ptr(info))
        ? readConsoleFont(info)
        : null;
    },
    async apply(target: ConsoleFontTarget): Promise<boolean> {
      const info = emptyFontInfo();
      const view = new DataView(info.buffer);
      view.setInt16(10, target.cellHeight, true);
      view.setInt32(12, TRUE_TYPE_FAMILY, true);
      view.setInt32(16, target.weight, true);
      writeFaceName(info, target.face);
      return symbols.SetCurrentConsoleFontEx(handle, false, ffi.ptr(info));
    },
  };
}

/**
 * Open the console's font port for this runtime, or `null` when this console cannot
 * be programmed.
 */
async function openConsoleFontPort(): Promise<ConsoleFontPort | null> {
  if (typeof Bun !== "undefined") {
    return openBunConsoleFontPort();
  }
  // Node: no FFI, so a helper process owns the Win32 calls. It shares this console,
  // which is what makes its `CONOUT$` the window the user is looking at.
  return openConsoleFontHelperPort({
    log: (message: string) => debugLog("console-font", message),
  });
}

export interface ConsoleFontGuardStatus {
  mode: ConsoleFontMode;
  running: boolean;
  /** Why the guard is not running, when it is not. */
  reason: string | null;
  /** The face a repair restores, which is the mode's answer without a baseline. */
  targetFace: string;
  baseline: ConsoleFont | null;
  repairs: number;
}

interface GuardState {
  guard: ConsoleFontGuard | null;
  mode: ConsoleFontMode;
  reason: string | null;
  baseline: ConsoleFont | null;
  repairs: number;
  /** The face the guard falls back to; the preset unless it is not installed. */
  defaultFace: string;
}

const state: GuardState = {
  guard: null,
  mode: "auto",
  reason: null,
  baseline: null,
  repairs: 0,
  defaultFace: DEFAULT_CONSOLE_FONT.face,
};

interface ResolvedConsoleFontMode {
  mode: ConsoleFontMode;
  /** False when nothing was stored, i.e. the preset is a default and not a choice. */
  explicit: boolean;
}

/** The stored mode, with the environment winning over the settings file. */
async function resolveConsoleFontMode(): Promise<ResolvedConsoleFontMode> {
  const fromEnv = process.env.HARUYUKI_CONSOLE_FONT;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return { mode: parseConsoleFontMode(fromEnv), explicit: true };
  }
  try {
    const settings = await loadSettings();
    if (
      typeof settings.consoleFont === "string" &&
      settings.consoleFont.trim() !== ""
    ) {
      return {
        mode: parseConsoleFontMode(settings.consoleFont),
        explicit: true,
      };
    }
  } catch {
    // An unreadable settings file falls through to the preset.
  }
  // Nothing stored: the **preset**, never the console's own face. `auto` adopts
  // whatever conhost happened to be drawing when the guard armed, and on a machine
  // whose console default is 宋体 that means adopting 宋体 — the guard then faithfully
  // puts the user back into the font they were escaping (report, 2026-10-23).
  return { mode: { pinnedFace: DEFAULT_CONSOLE_FONT.face }, explicit: false };
}

/**
 * Arm the guard for this session.
 *
 * Called once, before the first frame: the console's font is already whatever the
 * window was given, and the first raster reading is what the repair needs to see.
 */
export async function startConsoleFontGuardRuntime(): Promise<void> {
  if (state.guard !== null) return;
  const resolved = await resolveConsoleFontMode();
  state.mode = resolved.mode;
  if (state.mode === "off") {
    state.reason = "off";
    return;
  }
  const veto = consoleFontGuardVeto();
  if (veto !== null) {
    state.reason = veto;
    debugLog("console-font", `guard not armed: ${state.reason}`);
    return;
  }

  const port = await openConsoleFontPort();
  if (port === null) {
    state.reason = "the console does not answer";
    debugLog("console-font", `guard not armed: ${state.reason}`);
    return;
  }

  // A default that is not installed is a repair conhost accepts and does not take,
  // which ends the guard after two tries. Ask the inventory first when the port can
  // answer, and hold a face that exists. Only the preset is reassigned this way: an
  // explicit `/config console-font <face>` is the user's call and must be tried verbatim.
  if (!resolved.explicit) {
    const faces = (await port.listFaces?.()) ?? null;
    const chosen = chooseConsoleFace(DEFAULT_CONSOLE_FONT.face, faces);
    state.defaultFace = chosen;
    state.mode = { pinnedFace: chosen };
    if (chosen !== DEFAULT_CONSOLE_FONT.face) {
      debugLog(
        "console-font",
        `preset ${DEFAULT_CONSOLE_FONT.face} is not installed; holding ${chosen}`,
      );
    }
  }

  const mode = state.mode;
  try {
    state.guard = await startConsoleFontGuard({
      port,
      mode,
      defaultFace: state.defaultFace,
      intervalMs: CHECK_INTERVAL_MS,
      onEvent: (event) => {
        if (event.kind === "baseline") {
          state.baseline = event.font;
          debugLog(
            "console-font",
            `baseline ${event.font.face} ${event.font.cellWidth}x${event.font.cellHeight} family=${event.font.family}`,
          );
          return;
        }
        if (event.kind === "repaired") {
          state.repairs += 1;
          debugLog(
            "console-font",
            `repaired ${event.before.face} ${event.before.cellWidth}x${event.before.cellHeight} -> ${event.target.face} ${event.target.cellHeight}`,
          );
          return;
        }
        if (event.kind === "repair-failed") {
          debugLog(
            "console-font",
            `console refused ${event.target.face} ${event.target.cellHeight}`,
          );
          return;
        }
        if (event.kind === "not-taken") {
          // conhost accepted the call and drew something else: on a CJK-only console
          // a Western face is substituted. Worth one line per attempt — it is the
          // only record of what the console decided.
          state.reason = `the console draws ${event.observed.face} instead of ${event.target.face}`;
          debugLog(
            "console-font",
            `asked for ${event.target.face} ${event.target.cellHeight}, console drew ${event.observed.face} ${event.observed.cellWidth}x${event.observed.cellHeight}`,
          );
          return;
        }
        state.reason = "the console stopped answering";
        debugLog("console-font", `guard stopping: ${state.reason}`);
      },
    });
  } catch (error) {
    port.close?.();
    state.reason = "the console port failed";
    debugLog("console-font", `guard not armed: ${String(error)}`);
    return;
  }
  debugLog(
    "console-font",
    `guard armed (mode=${typeof mode === "object" ? mode.pinnedFace : mode}, every ${CHECK_INTERVAL_MS}ms)`,
  );
}

/** Apply a new mode at runtime, which is what `/console-font` does after saving. */
export async function restartConsoleFontGuardRuntime(): Promise<void> {
  state.guard?.stop();
  state.guard = null;
  state.reason = null;
  state.repairs = 0;
  state.baseline = null;
  state.defaultFace = DEFAULT_CONSOLE_FONT.face;
  await startConsoleFontGuardRuntime();
}

export function stopConsoleFontGuardRuntime(): void {
  state.guard?.stop();
  state.guard = null;
  state.reason = "off";
}

export function getConsoleFontGuardStatus(): ConsoleFontGuardStatus {
  const target = consoleFontTargetFor(
    state.mode,
    state.baseline,
    state.defaultFace,
  );
  return {
    mode: state.mode,
    running: state.guard !== null && state.reason === null,
    reason: state.reason,
    targetFace:
      state.mode === "off"
        ? DEFAULT_CONSOLE_FONT.face
        : (target?.face ?? DEFAULT_CONSOLE_FONT.face),
    baseline: state.baseline,
    repairs: state.repairs,
  };
}

/** Test seam: drop the module's guard so a test can arm a fresh one. */
export function resetConsoleFontGuardForTests(): void {
  state.guard?.stop();
  state.guard = null;
  state.mode = "auto";
  state.reason = null;
  state.baseline = null;
  state.repairs = 0;
  state.defaultFace = DEFAULT_CONSOLE_FONT.face;
}
