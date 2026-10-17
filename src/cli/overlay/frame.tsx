import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { useInputScopeClaim } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";

/**
 * The chrome every overlay is drawn inside.
 *
 * The same markup `OverlayShell` renders — `> /command`, a solid line, the title,
 * the body, an optional footer — because that shape is what every overlay in this
 * tree already looks like and this module is where it becomes *one* component
 * instead of a pattern repeated in a dozen selectors.
 *
 * It also declares the input scope its container occupies, which is the half of
 * the frame a picture cannot show: the router routes overlay keys only while an
 * overlay scope is claimed (`focus-ledger.ts`), so an overlay that binds keys
 * through `useOverlayList` and never claims the scope would be wired correctly
 * and receive nothing. The claim is ref-counted, so this one and the shell's own
 * claim (`ShellFrame`, which knows the open route) coexist without either having
 * to know about the other.
 *
 * A frame that is on screen *is* an open overlay, so the claim is unconditional
 * for its mounted life rather than driven by a boolean prop.
 */

const SOLID_LINE = "─";

/** Which layer of the router's priority chain this container occupies. */
export type OverlayContainer = "overlay" | "modal";

export interface OverlayFrameProps {
  /** The command that opened this overlay, e.g. "/personality". */
  command: string;
  /** Title displayed below the solid line. */
  title: string;
  children: ReactNode;
  /**
   * Optional footer (the hint line). A plain string or number is wrapped in
   * `<Text>` here — Ink rejects a bare string inside a `<Box>`, and passing one
   * raw crashes the whole overlay during commit.
   */
  footer?: ReactNode;
  /**
   * The scope this container owns input in. `overlay` for a selector or dialog
   * route; `modal` for a confirmation that outranks one.
   */
  container?: OverlayContainer;
}

export function OverlayFrame({
  command,
  title,
  children,
  footer,
  container = "overlay",
}: OverlayFrameProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  useInputScopeClaim(container, true);

  const renderedFooter =
    typeof footer === "string" || typeof footer === "number" ? (
      <Text dimColor>{footer}</Text>
    ) : (
      footer
    );

  return (
    <Box flexDirection="column">
      <Text dimColor>{`> ${command}`}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          {title}
        </Text>
      </Box>

      {children}

      {footer && <Box marginTop={1}>{renderedFooter}</Box>}
    </Box>
  );
}
