/**
 * The wizard's small presentational pieces (48-2 §4.9 D5).
 *
 * `InfoFrame`/`InfoLine` are the shared chrome for the result screens, and
 * `MaskedTextStep` is the one text screen that is not `ScheduleWizardSteps`'
 * `TextStep`: the endpoint key field must paint mask characters while the editor
 * keeps the real value. No state lives here.
 */

import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "@/cli/components/colors";
import { StepHint } from "@/cli/components/ScheduleWizardSteps";
import { Text } from "@/cli/components/Text";
import { EMBEDDING_WIZARD_COMMAND } from "@/cli/helpers/embedding-wizard-state";
import { truncateText } from "@/cli/helpers/truncate-text";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";

const COMMAND = EMBEDDING_WIZARD_COMMAND;

// ── Small frame pieces ─────────────────────────────────────────────────────

export function InfoFrame({
  title,
  footer,
  width,
  children,
}: {
  title: string;
  footer: string;
  width: number;
  children: ReactNode;
}) {
  return (
    <OverlayFrame
      command={COMMAND}
      title={title}
      footer={<StepHint text={footer} width={width} />}
    >
      <Box flexDirection="column">{children}</Box>
    </OverlayFrame>
  );
}

export function InfoLine({
  text,
  width,
  tone = "normal",
}: {
  text: string;
  width: number;
  tone?: "normal" | "dim" | "error";
}) {
  return (
    <Text
      dimColor={tone === "dim"}
      color={tone === "error" ? colors.status.error : undefined}
    >
      {truncateText(text, width)}
    </Text>
  );
}

/** The one masked field: Escape/back and Ctrl+C stay the wizard's keys. */
export function MaskedTextStep({
  title,
  hint,
  value,
  onChange,
  onSubmit,
  placeholder,
  error,
  footer,
  width,
}: {
  title: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  error: string | null;
  footer: string;
  width: number;
}) {
  return (
    <OverlayFrame
      command={COMMAND}
      title={title}
      footer={<StepHint text={footer} width={width} />}
    >
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <StepHint text={hint} width={width} />
        </Box>
        <OverlayTextField
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
          mask="•"
        />
        {error ? (
          <Box marginTop={1}>
            <Text color={colors.status.error}>
              {truncateText(error, width)}
            </Text>
          </Box>
        ) : null}
      </Box>
    </OverlayFrame>
  );
}
