/**
 * The first-run dream setup wizard (F-06 R-5.9.2: "first enable opens a
 * wizard", asked once for permission, windows, silence and budget).
 *
 * Three properties are the requirement's, not a preference:
 *
 * - **Cancel writes nothing.** Escape at the root (and Ctrl+C anywhere) closes
 *   the overlay; every answer lives in this component's state until the final
 *   step saves in one call, so leaving halfway cannot leave a half-configured
 *   agent behind. The master switch is written *by that save*, not before it.
 * - **A failed last step keeps what was typed.** The save is the only write, so
 *   when it throws the wizard stays on the budget step with every earlier answer
 *   intact and the error on screen — re-answering four questions because the
 *   settings file was busy would be the whole face's cost for no reason.
 * - **It asks exactly the four things a run needs.** Pressure threshold, budget
 *   factor and the tier switches stay on the Settings page: they have sane
 *   defaults and the wizard's job is to make a first run legal, not to be a
 *   second settings page.
 *
 * The step frames and the two key helpers (`wizardBindings`/`useWizard`) are the
 * shared overlay toolkit, not a schedule-specific copy: the wizard's order is its
 * own, and one owner of the keyboard at a time (`overlay/README.md`).
 */

import { useState } from "react";
import {
  formatDreamWindowsInput,
  parseDreamWindowsInput,
} from "@/cli/commands/dream";
import {
  cursorIndexFor,
  PERMISSION_ROWS,
  PickerStep,
  TextStep,
} from "@/cli/components/ScheduleWizardSteps";
import { ensureDreamTask } from "@/cli/helpers/dream-launcher";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import {
  type ResolvedDreamSettings,
  readDreamSettings,
  type StoredDreamSettings,
  updateDreamSettings,
} from "@/dream-settings";

type DreamWizardStep = "permission" | "windows" | "silence" | "budget";

const STEP_ORDER: readonly DreamWizardStep[] = [
  "permission",
  "windows",
  "silence",
  "budget",
];

const STEP_LABELS: Record<DreamWizardStep, string> = {
  permission: "Permission",
  windows: "Idle windows",
  silence: "Silence",
  budget: "Budget",
};

const COMMAND = "/dream on";

function stepTitle(step: DreamWizardStep): string {
  const index = STEP_ORDER.indexOf(step);
  return `${index + 1}/${STEP_ORDER.length} ${STEP_LABELS[step]}`;
}

export interface DreamWizardProps {
  agentId: string;
  /** Escape at the root, and Ctrl+C: nothing has been written. */
  onClose: () => void;
  /** The save landed: the overlay closes with a receipt. */
  onCompleted?: () => void;
  /** Injected by tests; defaults to the real settings reader. */
  initialSettings?: ResolvedDreamSettings;
  /** Injected by tests; defaults to the real settings writer. */
  saveSettings?: (patch: StoredDreamSettings) => void;
  /**
   * Make sure the agent has its dream carrier task after the save (T1's
   * `ensureDreamTask`). Injected by tests so the wizard test never writes the
   * schedule store.
   */
  ensureTask?: (agentId: string) => unknown;
}

/** Parse a whole-number answer; `null` when the text is not one. */
function parseWhole(raw: string): number | null {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : null;
}

export function DreamWizard({
  agentId,
  onClose,
  onCompleted,
  initialSettings,
  saveSettings,
  ensureTask,
}: DreamWizardProps) {
  const width = Math.max(1, useTerminalWidth() - 2);
  const [initial] = useState<ResolvedDreamSettings>(
    () => initialSettings ?? readDreamSettings(agentId),
  );
  const wizard = useWizard<DreamWizardStep>({ initial: "permission" });

  const [permission, setPermission] = useState<
    NonNullable<StoredDreamSettings["permissionMode"]>
  >(initial.permissionMode);
  const [windowsText, setWindowsText] = useState(() =>
    formatDreamWindowsInput(initial.idleWindows),
  );
  const [silenceText, setSilenceText] = useState(
    String(initial.silenceMinutes),
  );
  const [budgetText, setBudgetText] = useState(String(initial.maxPerRun));
  const [error, setError] = useState<string | null>(null);

  const leave = () => {
    setError(null);
    onClose();
  };

  const commit = (): void => {
    const idleWindows = parseDreamWindowsInput(windowsText);
    const silenceMinutes = parseWhole(silenceText);
    const maxPerRun = parseWhole(budgetText);
    if (!idleWindows) {
      setError("Use HH:MM-HH:MM pairs, comma separated.");
      return;
    }
    if (silenceMinutes === null || silenceMinutes > 24 * 60) {
      setError("Silence needs a whole number of minutes, 0 to 1440.");
      return;
    }
    if (maxPerRun === null || maxPerRun <= 0) {
      setError("Budget needs a positive whole number of tokens.");
      return;
    }
    try {
      const save = saveSettings ?? updateDreamSettings;
      save({
        enabled: true,
        permissionMode: permission,
        idleWindows,
        silenceMinutes,
        maxPerRun,
      });
      // The carrier task is what a listener-only host's trigger hangs its
      // occurrences on; it is created here, right after the explicit enable, so
      // "enabled" cannot mean "nothing will ever run". A failure after the save
      // keeps the wizard on the step (the answers and the settings survive) and
      // Enter retries the whole idempotent pair.
      try {
        const ensure = ensureTask ?? ((id: string) => ensureDreamTask(id));
        ensure(agentId);
      } catch (taskError) {
        setError(
          `Saved, but the dream task could not be created: ${
            taskError instanceof Error ? taskError.message : String(taskError)
          }.`,
        );
        return;
      }
      if (onCompleted) onCompleted();
      else onClose();
    } catch (saveError) {
      // The last step's failure keeps every answer: the state is untouched and
      // the user stays on the budget screen.
      setError(
        `Could not save dream settings: ${
          saveError instanceof Error ? saveError.message : String(saveError)
        }`,
      );
    }
  };

  // One owner of the keyboard per step: a picker owns its own keys, and the
  // text steps use the wizard's back/cancel pair.
  const onTextStep = wizard.step !== "permission";
  useKeyBindings("dream-wizard", [
    {
      scope: "overlay",
      bindings: onTextStep
        ? wizardBindings({
            canGoBack: wizard.canGoBack,
            onBack: () => {
              setError(null);
              wizard.back();
            },
            onCancel: leave,
          })
        : [],
    },
  ]);

  if (wizard.step === "permission") {
    return (
      <PickerStep
        command={COMMAND}
        title={stepTitle("permission")}
        hint="What a dream run may do while you are away. It runs unattended: there is nobody to answer an approval."
        items={PERMISSION_ROWS}
        initialCursorIndex={cursorIndexFor(PERMISSION_ROWS, permission)}
        onSelect={(key) => {
          setPermission(
            key === "standard" || key === "unrestricted" ? key : "acceptEdits",
          );
          setError(null);
          wizard.goTo("windows");
        }}
        onCancel={leave}
        footer="Enter select · ↑↓ move · Esc cancel"
        width={width}
      />
    );
  }

  if (wizard.step === "windows") {
    return (
      <TextStep
        command={COMMAND}
        title={stepTitle("windows")}
        hint="When a run may start, in 24-hour HH:MM-HH:MM pairs, comma separated. Cross-midnight windows are fine (22:00-07:00)."
        value={windowsText}
        onChange={(value) => {
          setWindowsText(value);
          setError(null);
        }}
        onSubmit={(value) => {
          if (!parseDreamWindowsInput(value)) {
            setError("Use HH:MM-HH:MM pairs, comma separated.");
            return;
          }
          setWindowsText(value);
          setError(null);
          wizard.goTo("silence");
        }}
        placeholder="22:00-07:00"
        error={error}
        footer="Enter continue · Esc back · ctrl+c cancel"
        width={width}
      />
    );
  }

  if (wizard.step === "silence") {
    return (
      <TextStep
        command={COMMAND}
        title={stepTitle("silence")}
        hint="How many minutes you must be away before a run may start."
        value={silenceText}
        onChange={(value) => {
          setSilenceText(value);
          setError(null);
        }}
        onSubmit={(value) => {
          const minutes = parseWhole(value);
          if (minutes === null || minutes > 24 * 60) {
            setError("Silence needs a whole number of minutes, 0 to 1440.");
            return;
          }
          setSilenceText(value);
          setError(null);
          wizard.goTo("budget");
        }}
        placeholder="30"
        error={error}
        footer="Enter continue · Esc back · ctrl+c cancel"
        width={width}
      />
    );
  }

  return (
    <TextStep
      command={COMMAND}
      title={stepTitle("budget")}
      hint="The most tokens one run may spend. A run stops (and keeps what it committed) when it reaches this."
      value={budgetText}
      onChange={(value) => {
        setBudgetText(value);
        setError(null);
      }}
      onSubmit={(value) => {
        setBudgetText(value);
        commit();
      }}
      placeholder="100000"
      error={error}
      footer="Enter save · Esc back · ctrl+c cancel"
      width={width}
    />
  );
}

/**
 * The receipt the overlay wants once the wizard closes: a short line the
 * command row can finish with (kept here so AppView stays wiring).
 */
export function dreamWizardCompletedText(): string {
  return "Dream configured and enabled. Runs will trigger in the next idle window.";
}

/** Exported for the frame test: the number of questions the wizard asks. */
export function dreamWizardStepCount(): number {
  return STEP_ORDER.length;
}
