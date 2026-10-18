import { Box } from "ink";
import { useCallback, useState } from "react";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { listBindings } from "@/cli/overlay/list-bindings";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { colors } from "./colors";
import { Text } from "./Text";

interface PinDialogProps {
  currentName: string;
  onSubmit: (newName: string | null) => void; // null means keep current name
  onCancel: () => void;
}

/**
 * Validate agent name against backend rules.
 * Matches: Unicode letters, digits, underscores, spaces, hyphens, apostrophes
 * Blocks: / \ : * ? " < > |
 */
export function validateAgentName(name: string): string | null {
  if (!name || !name.trim()) {
    return "Name cannot be empty";
  }

  const trimmed = name.trim();

  // Match backend regex: ^[\w '-]+$ with unicode
  // \w matches Unicode letters, digits, underscores
  // We also allow spaces, hyphens, and apostrophes
  const validPattern = /^[\w '-]+$/u;

  if (!validPattern.test(trimmed)) {
    return "Name contains invalid characters. Only letters, digits, spaces, hyphens, underscores, and apostrophes are allowed.";
  }

  if (trimmed.length > 100) {
    return "Name is too long (max 100 characters)";
  }

  return null;
}

/**
 * Check if the name is the default Haruyuki agent name.
 */
export function isDefaultAgentName(name: string): boolean {
  return name === DEFAULT_AGENT_NAME;
}

/** The two rows of the keep-or-rename choice, in the order they are offered. */
const CHOICE_ROWS = [
  { label: "Keep name", value: "keep" },
  { label: "Change name", value: "change" },
] as const;

/** Which of the dialog's two views is on screen. */
type PinStep = "choose" | "input";

export function PinDialog({ currentName, onSubmit, onCancel }: PinDialogProps) {
  const isDefault = isDefaultAgentName(currentName);
  // A default-named agent has nothing to keep, so the name field *is* the dialog
  // and Escape closes it; otherwise the choice comes first and Escape goes back.
  const wizard = useWizard<PinStep>({
    initial: isDefault ? "input" : "choose",
  });
  const { canGoBack, back, goTo } = wizard;
  const [nameInput, setNameInput] = useState("");
  const [selectedOption, setSelectedOption] = useState(0);
  const [error, setError] = useState("");

  const leave = useCallback(() => {
    if (canGoBack) {
      back();
    } else {
      onCancel();
    }
  }, [back, canGoBack, onCancel]);

  useKeyBindings("pin-dialog", [
    {
      scope: "overlay",
      bindings: wizardBindings({
        canGoBack,
        onBack: leave,
        onCancel,
        extra: [
          ...listBindings({
            count: CHOICE_ROWS.length,
            cursor: selectedOption,
            onMoveCursor: setSelectedOption,
            onConfirm: () => {
              if (selectedOption === 0) {
                // Keep the current name.
                onSubmit(null);
              } else {
                goTo("input");
              }
            },
            // The wizard owns Escape and Ctrl+C for both views.
            onCancel: undefined,
            navigationEnabled: wizard.step === "choose",
          }),
        ],
      }),
    },
  ]);

  const handleNameSubmit = (text: string) => {
    const trimmed = text.trim();
    const validationError = validateAgentName(trimmed);

    if (validationError) {
      setError(validationError);
      return;
    }

    onSubmit(trimmed);
  };

  // Input-only mode for default names, and the second step of the choice.
  if (wizard.step === "input") {
    return (
      <OverlayFrame
        command="/pin"
        title={isDefault ? "Name your agent" : "Rename your agent"}
      >
        <Box flexDirection="column" paddingY={1}>
          {isDefault && (
            <Box marginBottom={1}>
              <Text dimColor>
                Give your agent a memorable name before pinning.
              </Text>
            </Box>
          )}

          <Box flexDirection="column" marginBottom={1}>
            <Box marginBottom={1}>
              <Text>Enter a name:</Text>
            </Box>
            <OverlayTextField
              value={nameInput}
              onChange={(val) => {
                setNameInput(val);
                setError("");
              }}
              onSubmit={handleNameSubmit}
              placeholder={isDefault ? "e.g., my-coding-agent" : currentName}
            />
          </Box>

          {error && (
            <Box marginBottom={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}

          <Box>
            <Text dimColor>
              Press Enter to confirm {!isDefault && "• Esc to go back"}
              {isDefault && "• Esc to cancel"}
            </Text>
          </Box>
        </Box>
      </OverlayFrame>
    );
  }

  // Choice mode for custom names
  return (
    <OverlayFrame command="/pin" title="Pin agent">
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text dimColor>
            Would you like to keep the current name or change it?
          </Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          {CHOICE_ROWS.map((option, index) => {
            const isSelected = index === selectedOption;
            return (
              <Box key={option.value} flexDirection="row">
                <Box width={2} flexShrink={0}>
                  <Text color={isSelected ? colors.approval.header : undefined}>
                    {isSelected ? ">" : " "}
                  </Text>
                </Box>
                <Text color={isSelected ? colors.approval.header : undefined}>
                  {index + 1}. {option.label}
                  {option.value === "keep" ? ` "${currentName}"` : ""}
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box>
          <Text dimColor>
            ↑↓/jk to select • Enter to confirm • Esc to cancel
          </Text>
        </Box>
      </Box>
    </OverlayFrame>
  );
}
