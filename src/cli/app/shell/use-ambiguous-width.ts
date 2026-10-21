// src/cli/app/shell/use-ambiguous-width.ts

import { useEffect, useSyncExternalStore } from "react";
import {
  disarmAmbiguousWidthProbe,
  startAmbiguousWidthProbe,
} from "@/cli/helpers/ambiguous-width-probe";
import {
  type AmbiguousWidthMode,
  getAmbiguousWidthMode,
  getAmbiguousWidthSource,
  getAmbiguousWidthVersion,
  setAmbiguousWidthMode,
  subscribeToAmbiguousWidth,
} from "@/cli/helpers/char-width";
import { loadSettings } from "@/settings";

/** How long after the last resize the probe is armed, in milliseconds. */
const REPROBE_DELAY_MS = 250;

function normalizeMode(value: unknown): AmbiguousWidthMode | null {
  return value === "auto" || value === "narrow" || value === "wide"
    ? value
    : null;
}

/**
 * The mode the environment asks for, or `null` when it says nothing.
 *
 * The environment wins over the settings file because it is the per-launch
 * override (`HARUYUKI_AMBIGUOUS_WIDTH=narrow bun run dev`): someone debugging a
 * font should not have to edit a file to try one value.
 */
export function envAmbiguousWidthMode(
  env: NodeJS.ProcessEnv = process.env,
): AmbiguousWidthMode | null {
  return normalizeMode(env.HARUYUKI_AMBIGUOUS_WIDTH);
}

/**
 * Ask the terminal how wide the ambiguous characters are, once, and again after a
 * resize.
 *
 * **Mounted by the full-screen shell.** Two reasons it cannot live lower: the probe
 * writes to the screen (it must be a screen the app owns — the alternate buffer —
 * so nothing lands in the user's scrollback), and the answer is a whole-tree fact,
 * so the repaint it triggers has to re-render the shell's own chrome too.
 *
 * **Re-armed on resize** because that is the one event a font change reliably
 * produces: a different font has different metrics, so the column count moves and
 * the terminal sends `resize` (2026-10-21: the user's Consolas-versus-等宽楷体 test
 * is exactly this case). The delay collapses a drag-resize into one probe; the
 * write is behind a `\r`, so a burst of them costs a repaint, not a broken frame.
 *
 * **Three sources, in order:** the environment, the stored setting, the terminal
 * itself. The stored value arrives asynchronously (the settings file is a promise
 * on this path), so it is applied only when nothing has resolved the width yet — a
 * `/font-width` run before it lands must not be overwritten by the file it just
 * wrote.
 *
 * The value is read through a store rather than state: the frames that measure with
 * it are spread across the tree (`formatting.ts` → tab strip, rail, status line),
 * and they all read the module directly. Subscribing here is what makes the shell
 * lay them out a second time once the terminal has answered.
 */
export function useAmbiguousWidthProbe(): void {
  const version = useSyncExternalStore(
    subscribeToAmbiguousWidth,
    getAmbiguousWidthVersion,
    getAmbiguousWidthVersion,
  );
  // Read so the subscription above has an observable effect per render; the layout
  // itself reads the module's own `getAmbiguousWidth()`.
  void version;

  useEffect(() => {
    const apply = (mode: AmbiguousWidthMode): void => {
      setAmbiguousWidthMode(mode);
      // A pinned mode needs no question: the answer would only overwrite it.
      if (mode === "auto") startAmbiguousWidthProbe();
    };

    let cancelled = false;
    const fromEnv = envAmbiguousWidthMode();
    if (fromEnv !== null) {
      apply(fromEnv);
    } else {
      apply("auto");
      void loadSettings()
        .then((stored) => {
          if (cancelled) return;
          const storedMode = normalizeMode(stored.ambiguousCharWidth);
          if (
            storedMode !== null &&
            storedMode !== "auto" &&
            getAmbiguousWidthSource() === "default"
          ) {
            apply(storedMode);
          }
        })
        .catch(() => {
          // An unreadable settings file leaves `auto` in force.
        });
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (getAmbiguousWidthMode() === "auto") startAmbiguousWidthProbe();
      }, REPROBE_DELAY_MS);
    };
    process.stdout.on("resize", onResize);
    return () => {
      cancelled = true;
      process.stdout.off("resize", onResize);
      if (timer !== null) clearTimeout(timer);
      disarmAmbiguousWidthProbe();
    };
  }, []);
}
