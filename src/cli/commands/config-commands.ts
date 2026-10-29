// src/cli/commands/config-commands.ts
// The `/config` subcommands that own real behaviour: terminal keybindings, the
// ambiguous-width pin, and the Windows console-font guard.
//
// They live here rather than inline in the registry because the registry is the
// index, not an implementation: everything entered through a hub needs a target
// that a test can call without building the whole command record, and the
// registry is already at its size ceiling.

export async function handleTerminalCommand(args: string[]): Promise<string> {
  if (args.includes("help")) {
    return [
      "/config terminal help",
      "",
      "Setup terminal keyboard shortcuts.",
      "",
      "USAGE",
      "  /config terminal            — install Shift+Enter keybinding",
      "  /config terminal --revert   — remove keybinding",
      "  /config terminal help       — show this help",
    ].join("\n");
  }

  const {
    detectTerminalType,
    getKeybindingsPath,
    installKeybinding,
    removeKeybinding,
  } = await import("@/cli/utils/terminal-keybinding-installer");
  const { updateSettings } = await import("@/settings");

  const isRevert = args.includes("--revert") || args.includes("--remove");
  const terminal = detectTerminalType();

  if (!terminal) {
    return "Not running in a VS Code-like terminal. Shift+Enter keybinding is not needed.";
  }

  const terminalName = {
    vscode: "VS Code",
    cursor: "Cursor",
    windsurf: "Windsurf",
  }[terminal];

  const keybindingsPath = getKeybindingsPath(terminal);
  if (!keybindingsPath) {
    return `Could not determine keybindings.json path for ${terminalName}`;
  }

  if (isRevert) {
    const result = removeKeybinding(keybindingsPath);
    if (!result.success) {
      return `Failed to remove keybinding: ${result.error}`;
    }
    await updateSettings({ shiftEnterKeybindingInstalled: false });
    return `Removed Shift+Enter keybinding from ${terminalName}`;
  }

  const result = installKeybinding(keybindingsPath);
  if (!result.success) {
    return `Failed to install keybinding: ${result.error}`;
  }

  if (result.alreadyExists) {
    return `Shift+Enter keybinding already exists in ${terminalName}`;
  }

  await updateSettings({ shiftEnterKeybindingInstalled: true });
  return `Installed Shift+Enter keybinding for ${terminalName}\nLocation: ${keybindingsPath}`;
}

export async function handleFontWidthCommand(args: string[]): Promise<string> {
  const requested = (args[0] ?? "").toLowerCase();
  const {
    getAmbiguousWidth,
    getAmbiguousWidthMode,
    getAmbiguousWidthSource,
    setAmbiguousWidthMode,
  } = await import("@/cli/helpers/char-width");
  // Every answer starts with what is in force. The machine's report was
  // "changing the font width has no visible effect": a one-column difference in a
  // dozen rows of prose is not something an eye can confirm, so the command has to
  // say the number rather than let the frame be the evidence.
  const source =
    getAmbiguousWidthSource() === "probe"
      ? "the terminal's own answer"
      : getAmbiguousWidthSource() === "mode"
        ? "pinned by this command"
        : "the width table's default";
  const inForce = `In force: ${getAmbiguousWidth()} column(s) — ${source}${getAmbiguousWidthMode() === "auto" ? " (auto)" : ` (${getAmbiguousWidthMode()})`}.`;
  if (requested !== "auto" && requested !== "narrow" && requested !== "wide") {
    return [
      inForce,
      "",
      "/config font-width auto | narrow | wide",
      "",
      "Unicode calls `— … ≥ → · “ ”` *ambiguous*: a Western monospace font draws",
      "them one column, a CJK font (or a CJK fallback) draws them two. The app",
      "asks the terminal at startup and after each resize; this command pins the",
      "answer for a terminal that is wrong or will not reply.",
      "",
      "  auto    — ask the terminal (the default)",
      "  narrow  — one column, e.g. Consolas",
      "  wide    — two columns, e.g. MS Gothic",
    ].join("\n");
  }
  const { startAmbiguousWidthProbe } = await import(
    "@/cli/helpers/ambiguous-width-probe"
  );
  const previous = getAmbiguousWidth();
  setAmbiguousWidthMode(requested);
  try {
    // The same writer `/config terminal` uses: read-merge-write of
    // `~/.haruyuki/settings.json`, so keys this module does not model survive.
    const { updateSettings } = await import("@/settings");
    await updateSettings({ ambiguousCharWidth: requested });
  } catch {
    // An unreadable settings file still leaves the session value in force.
  }
  if (requested === "auto") {
    const started = startAmbiguousWidthProbe();
    return started.kind === "armed"
      ? `${inForce}\nProbing the terminal… (rows and selections follow its answer)`
      : `${inForce}\nNo terminal to ask; keeping the width table's answer.`;
  }
  const now = getAmbiguousWidth();
  const change =
    now === previous
      ? "unchanged"
      : `was ${previous}, so every row is being laid out again`;
  return `${inForce}\n${requested}: ${now} column(s) — ${change}; saved to settings.`;
}

export async function handleConsoleFontCommand(
  args: string[],
): Promise<string> {
  const { parseConsoleFontMode } = await import("@/cli/helpers/console-font");
  const {
    getConsoleFontGuardStatus,
    restartConsoleFontGuardRuntime,
    stopConsoleFontGuardRuntime,
  } = await import("@/cli/helpers/console-font-bun");

  const describe = (
    status: ReturnType<typeof getConsoleFontGuardStatus>,
  ): string[] => {
    const mode =
      typeof status.mode === "object" ? status.mode.pinnedFace : status.mode;
    const standing =
      status.mode === "off"
        ? " (off)"
        : status.running
          ? ` — restoring ${status.targetFace}`
          : ` — not running (${status.reason ?? "not started"})`;
    // The command answers with what is in force first, the way `/config font-width`
    // does: a repair that happened once is invisible on screen, so the state
    // has to be written down rather than left to the frame.
    const lines = [`In force: ${mode}${standing}`];
    if (status.baseline !== null) {
      lines.push(
        `This session started on: ${status.baseline.face} ${status.baseline.cellWidth}x${status.baseline.cellHeight}.`,
      );
    }
    lines.push(`Repairs this session: ${status.repairs}.`);
    return lines;
  };

  const requested = (args[0] ?? "").trim();
  if (requested === "") {
    return [
      ...describe(getConsoleFontGuardStatus()),
      "",
      "/config console-font auto | off | <face>",
      "",
      "Classic Windows `conhost.exe` changes a live window's font by itself —",
      "`Consolas` → `SimSun` around startup (the console's saved default being",
      "re-applied), `Consolas` → `Terminal` 8×12 mid-turn (the smallest raster face,",
      "which has none of the block or ambiguous glyphs this UI is drawn with) — and",
      "keeps it until the window's properties are changed by hand. No escape",
      "sequence selects a font, so the only way to keep the font still is to hold",
      "it: the guard asks the console what it is drawing with four times a second",
      "and writes the target face back.",
      "",
      "Runtime: classic Windows console host (`conhost.exe`) only — under Bun the",
      "guard calls Win32 in-process, under Node a PowerShell helper attached to the",
      "same console does. Windows Terminal / VS Code own their terminal's font, so",
      "the guard stands down there.",
      "",
      "  (unset)  — the preset, `Consolas`",
      "  auto     — whatever face this session started with",
      "  off      — stop watching",
      "  <face>   — draw with that face, e.g. LXGW WenKai Mono",
    ].join("\n");
  }

  const mode = parseConsoleFontMode(requested);
  try {
    const { updateSettings } = await import("@/settings");
    await updateSettings({
      consoleFont: typeof mode === "object" ? mode.pinnedFace : mode,
    });
  } catch {
    // An unreadable settings file still leaves the session value in force.
  }
  if (mode === "off") {
    stopConsoleFontGuardRuntime();
    return [
      ...describe(getConsoleFontGuardStatus()),
      "Stopped; saved to settings.",
    ].join("\n");
  }
  await restartConsoleFontGuardRuntime();
  return [...describe(getConsoleFontGuardStatus()), "Saved to settings."].join(
    "\n",
  );
}
