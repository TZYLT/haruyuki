import { Box } from "ink";
import { useState } from "react";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { wizardBindings } from "@/cli/overlay/wizard";
import { colors } from "./colors";
import { Text } from "./Text";

interface FeedbackDialogProps {
  onSubmit: (message: string) => void;
  onCancel: () => void;
  initialValue?: string;
}

/**
 * One line of feedback, and the two keys out of it.
 *
 * The frame draws the header it always drew (`> /feedback`, the rule, a blank
 * line), the prompt line is the body, and the field is the toolkit's editor —
 * so this dialog stops hand-rolling Escape and Ctrl+C and stops painting the
 * draft as a plain `<Text>`.
 */
export function FeedbackDialog({
  onSubmit,
  onCancel,
  initialValue = "",
}: FeedbackDialogProps) {
  const [feedbackText, setFeedbackText] = useState(initialValue);
  const [error, setError] = useState("");

  useKeyBindings("feedback-dialog", [
    {
      scope: "overlay",
      // One step, so Escape and Ctrl+C are the same key: close.
      bindings: wizardBindings({
        canGoBack: false,
        onBack: onCancel,
        onCancel,
      }),
    },
  ]);

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Feedback message cannot be empty");
      return;
    }
    if (trimmed.length > 10000) {
      setError("Feedback message is too long (max 10,000 characters)");
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <OverlayFrame command="/feedback">
      <Box flexDirection="column" marginBottom={1}>
        <Text>{"  "}Enter your feedback:</Text>
      </Box>

      <OverlayTextField
        markerColor={colors.selector.itemHighlighted}
        value={feedbackText}
        onChange={(value) => {
          setFeedbackText(value);
          setError("");
        }}
        onSubmit={handleSubmit}
        placeholder="(type your feedback)"
      />

      {error && (
        <Box marginTop={1}>
          <Text color="red">
            {"  "}
            {error}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter to submit · Esc cancel</Text>
      </Box>
    </OverlayFrame>
  );
}
