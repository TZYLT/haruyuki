import type { ChalkInstance } from "chalk";
import { useSyncExternalStore } from "react";
import { colors } from "./colors";
import { Text } from "./Text";

const LOGO_WIDTH = 10;

// Logo frames use abstract cell tokens instead of block/shade glyphs.
// Rendering via backgroundColor makes each logo pixel a terminal cell, avoiding
// font/terminal-specific rendering differences for Unicode block elements.
//
// EMPTY BY DESIGN. The upstream frames drew the Letta logo, which the LICENSE
// "Brand Assets Exclusion" excludes from the Apache-2.0 grant, so a derivative
// work must not reproduce it. This fork has not drawn its own mark yet, so every
// frame is blank space: the layout, the fixed LOGO_WIDTH grid and the exported
// staticLogoLines() API keep working, and no third-party brand asset ships.
// Replace these frames with this fork's own mark when it exists.
const LOGO_FRAME = `          
          
          
          
          `;

const logoFrames = [
  LOGO_FRAME, // 1
  LOGO_FRAME, // 2
  LOGO_FRAME, // 3
  LOGO_FRAME, // 4
  LOGO_FRAME, // 5
  LOGO_FRAME, // 6
  LOGO_FRAME, // 7
  LOGO_FRAME, // 8
  LOGO_FRAME, // 9
  LOGO_FRAME, // 10
  LOGO_FRAME, // 11
  LOGO_FRAME, // 12
  LOGO_FRAME, // 13
  LOGO_FRAME, // 14
];

function padFrameToFixedWidth(frame: string, width: number): string {
  return frame
    .split("\n")
    .map((line) => line.padEnd(width, " "))
    .join("\n");
}

const normalizedLogoFrames = logoFrames.map((frame) =>
  padFrameToFixedWidth(frame, LOGO_WIDTH),
);

// Shared module-level ticker for animation sync across all AnimatedLogo instances
// Single timer, guaranteed sync, no time-jump artifacts
let tick = 0;
const listeners = new Set<() => void>();
let tickerInterval: ReturnType<typeof setInterval> | null = null;

const FRAME_SEQUENCE = [
  0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13,
] as const;
const FRAME_INTERVAL_MS = 75;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  // Start ticker on first subscriber
  if (!tickerInterval) {
    tickerInterval = setInterval(() => {
      tick++;
      for (const cb of listeners) {
        cb();
      }
    }, FRAME_INTERVAL_MS);
  }
  return () => {
    listeners.delete(callback);
    // Stop ticker when no subscribers
    if (listeners.size === 0 && tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
  };
}

function getSnapshot(): number {
  return tick;
}

function logoCellColor(token: string, faceColor: string): string | undefined {
  if (token === "F") return faceColor;
  if (token === "D") return colors.logo.dot;
  if (token === "S") return colors.logo.shadow;
  return undefined;
}

function renderLogoLine(line: string, faceColor: string) {
  return Array.from(line).map((token, idx) => {
    const backgroundColor = logoCellColor(token, faceColor);

    return (
      <Text
        // biome-ignore lint/suspicious/noArrayIndexKey: Logo cells are fixed per line
        key={idx}
        backgroundColor={backgroundColor}
      >
        {" "}
      </Text>
    );
  });
}

/**
 * Static logo (frame 1, with shadow) as plain strings for one-shot console
 * output outside Ink. Cells are painted with the given chalk instance so the
 * logo follows the same color-level detection as the rest of the CLI:
 * 24-bit where supported, 256-color on terminals like Terminal.app, and no
 * escape sequences at all when chalk reports level 0.
 */
export function staticLogoLines(
  paint: ChalkInstance,
  faceColor: string = colors.welcome.accent,
): string[] {
  const lines = normalizedLogoFrames[1]?.split("\n") ?? [];
  return lines.map((line) =>
    Array.from(line)
      .map((token) => {
        const bg = logoCellColor(token, faceColor);
        return bg ? paint.bgHex(bg)(" ") : " ";
      })
      .join(""),
  );
}

interface AnimatedLogoProps {
  color?: string;
  /** When false, show static frame 1 (logo with shadow). Defaults to true. */
  animate?: boolean;
}

export function AnimatedLogo({
  color = colors.welcome.accent,
  animate = true,
}: AnimatedLogoProps) {
  const tick = useSyncExternalStore(subscribe, getSnapshot);
  const sequenceIndex = tick % FRAME_SEQUENCE.length;
  const frame = animate ? (FRAME_SEQUENCE[sequenceIndex] ?? 0) : 1;

  const logoLines = normalizedLogoFrames[frame]?.split("\n") ?? [];

  return (
    <>
      {logoLines.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Logo lines are static and never reorder
        <Text key={idx} bold>
          {renderLogoLine(line, color)}
        </Text>
      ))}
    </>
  );
}
