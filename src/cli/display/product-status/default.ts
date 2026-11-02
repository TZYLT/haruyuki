import { BRAILLE_SPINNER_FRAMES } from "@/cli/components/BlinkingSpinner";
import { colors } from "@/cli/components/colors";
import { ROW_SAFETY_COLUMNS } from "@/cli/display/statusline/formatting";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import type { ModContext, ModPanel } from "@/cli/mods/types";
import {
  DREAM_SEGMENT_SEPARATOR,
  type DreamStatusSnapshot,
  renderDreamSegment,
} from "./dream";
import { DEFAULT_PRODUCT_STATUS_ORDER } from "./order";

const ACTIVE_BACKGROUND_AGENT_STATUSES = new Set<string>([
  "pending",
  "running",
]);

const REFLECTION_BACKGROUND_AGENT_TYPE = "reflection";

export { DEFAULT_PRODUCT_STATUS_ORDER } from "./order";
export const PRODUCT_STATUS_SPINNER_INTERVAL_MS = 90;
export const PRODUCT_STATUS_SPINNER_PULSE_INTERVAL_MS = 400;

export interface DefaultProductStatusPanelOptions {
  spinnerDimmed?: boolean;
  spinnerFrame?: string;
  agentUrl?: string | null;
  /**
   * The current agent's running (or just-finished) dream, from
   * `use-dream-run-status`. The panel decides whether it is still the current
   * agent's run; the hook has already applied the 30 s done linger.
   */
  dreamStatus?: DreamStatusSnapshot | null;
}

function paddedSpinnerFrame(frame: string, width: number): string {
  // The padding is columns the terminal will draw, not `string-width`'s answer: the
  // fallback frame is `·`, which is ambiguous — one column under Consolas and two
  // under a CJK face — and a one-cell error here shifts the whole status line.
  const frameWidth = terminalTextWidth(frame);
  const targetWidth = Math.max(1, width);
  const totalPadding = Math.max(0, targetWidth - frameWidth);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return " ".repeat(leftPadding) + frame + " ".repeat(rightPadding);
}

function typeLabelForBackgroundAgent(type: string): string {
  // The background-agent types are already the user-facing feature names
  // (`reflection`, `general-purpose`, …). T-01 (R-01.8) makes the reflection
  // label the verb `reflecting`, matching `dreaming`; "dreaming" used to label
  // reflection here, but F-06 made "dream" a real feature, so that word now
  // belongs to the dream segment alone.
  const lower = type.toLowerCase();
  return lower === REFLECTION_BACKGROUND_AGENT_TYPE ? "reflecting" : lower;
}

/**
 * The current agent's dream snapshot, or `null` when this line belongs to a
 * different agent (R-01.1: only the current agent's dream is shown).
 */
function currentAgentDreamStatus(
  ctx: ModContext,
  dreamStatus: DreamStatusSnapshot | null | undefined,
): DreamStatusSnapshot | null {
  if (!dreamStatus) return null;
  if (ctx.agent.id === null || dreamStatus.agentId !== ctx.agent.id)
    return null;
  return dreamStatus;
}

export function createDefaultProductStatusPanel(
  options: DefaultProductStatusPanelOptions = {},
): ModPanel {
  return {
    id: "default:product-status",
    order: DEFAULT_PRODUCT_STATUS_ORDER,
    path: "default:product-status",
    updatedAt: 0,
    render(ctx) {
      const backgroundAgent = ctx.backgroundAgents.find((agent) =>
        ACTIVE_BACKGROUND_AGENT_STATUSES.has(agent.status),
      );
      const dreamStatus = currentAgentDreamStatus(ctx, options.dreamStatus);

      if (!backgroundAgent && !dreamStatus) return "";

      const spinnerText = paddedSpinnerFrame(
        options.spinnerFrame ?? BRAILLE_SPINNER_FRAMES[0],
        2,
      );
      const spinnerStyle = ctx.chalk.hex(colors.bgSubagent.spinner);
      const styleSpinner = (text: string): string =>
        options.spinnerDimmed ? spinnerStyle.dim(text) : spinnerStyle(text);
      const spinner = styleSpinner(spinnerText);
      // The panel assembles one row and `ctx.row` spends `ROW_SAFETY_COLUMNS`
      // on the right margin; the segments are laid out inside what is left so a
      // narrow terminal degrades the dream half by design instead of truncating
      // it mid-word.
      const contentWidth = Math.max(0, ctx.width - ROW_SAFETY_COLUMNS);

      if (!backgroundAgent) {
        // Dream only: it owns the spinner and the label (R-01.2's "drop the
        // reflection segment"). Nothing to show when it has given way.
        const segment = renderDreamSegment(
          dreamStatus as DreamStatusSnapshot,
          contentWidth,
          styleSpinner(options.spinnerFrame ?? BRAILLE_SPINNER_FRAMES[0]),
          ctx.chalk,
        );
        return segment.length > 0 ? ctx.row("", segment, ctx.width) : "";
      }

      const elapsedSeconds = Math.round(backgroundAgent.durationMs / 1000);
      const label = ctx.chalk.hex(colors.bgSubagent.label)(
        typeLabelForBackgroundAgent(backgroundAgent.type),
      );
      const elapsed = ctx.chalk.dim(` (${elapsedSeconds}s)`);
      const isTmux = Boolean(process.env.TMUX);
      const linkedLabel =
        options.agentUrl && !isTmux ? ctx.link(label, options.agentUrl) : label;
      const reflectionSegment = `${spinner}${linkedLabel}${elapsed}`;

      if (!dreamStatus) {
        // Reflection only: exactly the pre-T-01 line.
        return ctx.row("", reflectionSegment, ctx.width);
      }

      // R-01.1/R-01.2: both share this one line, reflection first. The
      // reflection half already carries the spinner, so the dream half is
      // rendered without one — two spinners on one line would animate apart.
      const separatorWidth = terminalTextWidth(DREAM_SEGMENT_SEPARATOR);
      const dreamWidth = Math.max(
        0,
        contentWidth - terminalTextWidth(reflectionSegment) - separatorWidth,
      );
      const dreamSegment = renderDreamSegment(
        dreamStatus,
        dreamWidth,
        "",
        ctx.chalk,
      );
      if (dreamSegment.length === 0) {
        // R-01.4's last step: the dream half gives way to reflection.
        return ctx.row("", reflectionSegment, ctx.width);
      }
      return ctx.row(
        "",
        `${reflectionSegment}${DREAM_SEGMENT_SEPARATOR}${dreamSegment}`,
        ctx.width,
      );
    },
  };
}

export const defaultProductStatusPanel = createDefaultProductStatusPanel();

export function withDefaultProductStatusPanel(
  panels: Record<string, ModPanel> | undefined,
  options: DefaultProductStatusPanelOptions = {},
): Record<string, ModPanel> {
  const existingPanels = panels ?? {};
  const hasUserProductStatusPanel = Object.values(existingPanels).some(
    (panel) => panel.order === DEFAULT_PRODUCT_STATUS_ORDER,
  );
  if (hasUserProductStatusPanel) {
    return existingPanels;
  }

  const defaultPanel = createDefaultProductStatusPanel(options);
  return {
    ...existingPanels,
    [defaultPanel.id]: defaultPanel,
  };
}
