/**
 * `/recall` with no arguments: the settings picker.
 *
 * A picker rather than a wall of usage text because every one of these knobs is a
 * preference with a documented default, and a person changing one wants to see the
 * current value next to it (《26》§6.8). Selecting a row either toggles it (the
 * on/off switch) or opens a one-line editor for it.
 *
 * The rows are built by pure functions and the editors parse with the same helpers
 * the `/recall` command uses, so the picker and the typed form cannot disagree
 * about what a valid value is.
 */
import { Box } from "ink";
import { memo, useCallback, useMemo, useState } from "react";
import { parseRecallCount, parseRecallRatio } from "@/cli/commands/recall";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import type { ResolvedRecallSettings } from "@/recall-settings";
import {
  isRecallDisplay,
  type RecallDisplay,
} from "@/reminders/recall-display";
import type { RecallDiversity } from "@/reminders/recall-port";
import { isRecallDiversity } from "@/reminders/recall-port";
import type { Settings } from "@/settings-manager";
import { Text } from "./Text";

export interface RecallOverlayProps {
  settings: ResolvedRecallSettings;
  /** Writes the change; the caller owns persistence and the receipt. */
  onSave: (updates: Partial<Settings>) => void;
  onCancel: () => void;
}

type RecallSettingKey = keyof Settings & `recall${string}`;

interface RecallNumberRow {
  key: RecallSettingKey;
  label: string;
  read: (settings: ResolvedRecallSettings) => number;
  prompt: string;
  /** `chars` rows show a plain number; the ratio row accepts decimals. */
  parse: (raw: string) => number | null;
  unit?: string;
}

const NUMBER_ROWS: readonly RecallNumberRow[] = [
  {
    key: "recallLimit",
    label: "Passages per turn",
    read: (settings) => settings.limit,
    prompt: "How many passages should be injected per turn? (0 = none)",
    parse: parseRecallCount,
  },
  {
    key: "recallTimeoutMs",
    label: "Timeout",
    read: (settings) => settings.timeoutMs,
    prompt: "Wall-clock budget per turn in milliseconds (0 = no limit)",
    parse: parseRecallCount,
    unit: "ms",
  },
  {
    key: "recallDedupTurns",
    label: "Dedup window",
    read: (settings) => settings.dedupTurns,
    prompt:
      "User turns a recalled passage stays suppressed for (0 = no window)",
    parse: parseRecallCount,
    unit: "turns",
  },
  {
    key: "recallExcerptLines",
    label: "Memory context",
    read: (settings) => settings.excerptLines,
    prompt: "Lines of context on each side of a memory hit (0 = the hit line)",
    parse: parseRecallCount,
    unit: "lines",
  },
  {
    key: "recallExcerptCharacters",
    label: "Per-passage budget",
    read: (settings) => settings.excerptCharacters,
    prompt: "Characters kept per passage before truncation",
    parse: parseRecallCount,
    unit: "chars",
  },
  {
    key: "recallTotalCharacters",
    label: "Total budget",
    read: (settings) => settings.totalCharacters,
    prompt: "Characters of excerpt text injected per turn",
    parse: parseRecallCount,
    unit: "chars",
  },
  {
    key: "recallMinScoreRatio",
    label: "Score floor",
    read: (settings) => settings.minScoreRatio,
    prompt: "Keep hits scoring at least this share of the best one (0 to 1)",
    parse: parseRecallRatio,
  },
];

/** The row that toggles the feature, and the two enum rows. */
export const RECALL_TOGGLE_ROW_KEY = "recallEnabled";
export const RECALL_DISPLAY_ROW_KEY = "recallDisplay";
export const RECALL_DIVERSITY_ROW_KEY = "recallDiversity";

function numberRowValue(row: RecallNumberRow, value: number): string {
  return row.unit === undefined ? String(value) : `${value} ${row.unit}`;
}

/**
 * The picker rows, in the order a person meets them: whether it runs at all, what
 * they see, then the search's own knobs.
 */
export function buildRecallPickerRows(
  settings: ResolvedRecallSettings,
): SingleSelectItem[] {
  const rows: SingleSelectItem[] = [
    {
      key: RECALL_TOGGLE_ROW_KEY,
      label: "Passive recall",
      description: settings.enabled
        ? "on — Enter to turn off"
        : "off — Enter to turn on",
      isCurrent: false,
    },
    {
      key: RECALL_DISPLAY_ROW_KEY,
      label: "Display",
      description: `${settings.display} — Enter to change`,
    },
  ];
  for (const row of NUMBER_ROWS) {
    rows.push({
      key: row.key,
      label: row.label,
      description: `${numberRowValue(row, row.read(settings))} — Enter to change`,
    });
  }
  rows.push({
    key: RECALL_DIVERSITY_ROW_KEY,
    label: "Diversity",
    description: `${settings.diversity} — Enter to change`,
  });
  return rows;
}

export function buildDisplayRows(current: RecallDisplay): SingleSelectItem[] {
  return [
    {
      key: "summary",
      label: "Summary",
      description: "one line; ctrl+r shows the passages",
      isCurrent: current === "summary",
    },
    {
      key: "silent",
      label: "Silent",
      description: "injected but never shown in the transcript",
      isCurrent: current === "silent",
    },
    {
      key: "full",
      label: "Full",
      description: "the passages are shown as they are sent",
      isCurrent: current === "full",
    },
  ];
}

export function buildDiversityRows(
  current: RecallDiversity,
): SingleSelectItem[] {
  return [
    {
      key: "none",
      label: "None",
      description: "the best scores win, even from one file",
      isCurrent: current === "none",
    },
    {
      key: "file",
      label: "One per file",
      description: "at most one passage per conversation or memory file",
      isCurrent: current === "file",
    },
    {
      key: "split",
      label: "Split",
      description: "half the slots for transcripts, half for memory",
      isCurrent: current === "split",
    },
  ];
}

function findNumberRow(key: string): RecallNumberRow | undefined {
  return NUMBER_ROWS.find((row) => row.key === key);
}

interface RowEditorProps {
  row: RecallNumberRow;
  current: number;
  onSave: (value: number) => void;
}

/**
 * Second view: one line of text for one numeric knob.
 *
 * It binds nothing. Escape from here is "back to the list" and Ctrl+C is "close
 * the overlay", which is the pair `wizardBindings` answers for every step — so
 * the editor is only the line, the caret and the parse.
 */
function RowEditor({ row, current, onSave }: RowEditorProps) {
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState("");

  const submit = useCallback(
    (text: string) => {
      const parsed = row.parse(text);
      if (parsed === null) {
        setError("Enter a number the setting accepts.");
        return;
      }
      onSave(parsed);
    },
    [onSave, row],
  );

  return (
    <OverlayFrame command="/recall" title={row.label}>
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>{`${row.prompt} Currently ${numberRowValue(row, current)}.`}</Text>
        </Box>

        <OverlayTextField
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setError("");
          }}
          onSubmit={submit}
          placeholder={String(current)}
        />

        {error ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text dimColor>Enter to save · Esc back · Ctrl-C cancel</Text>
        </Box>
      </Box>
    </OverlayFrame>
  );
}

type SubPicker = "display" | "diversity";

/** Which of the overlay's views is on screen. */
type RecallStep = "list" | SubPicker | "edit";

export const RecallOverlay = memo(function RecallOverlay({
  settings,
  onSave,
  onCancel,
}: RecallOverlayProps) {
  const wizard = useWizard<RecallStep>({ initial: "list" });
  const { canGoBack, back, goTo } = wizard;
  const [editing, setEditing] = useState<RecallNumberRow | null>(null);
  const rows = useMemo(() => buildRecallPickerRows(settings), [settings]);

  /**
   * Escape from a view that has one below it, and the close when it does not.
   *
   * The pickers are handed this as their own cancel, which is exactly what this
   * face did before: their cancel binding consumes Escape *and* Ctrl+C, so
   * Ctrl+C on a sub-picker went back rather than out. That is preserved here on
   * purpose — the wizard's rule (Ctrl+C closes from anywhere) is the one
   * `/connect` needed, and changing it under a face that never asked is not what
   * this batch is for.
   */
  const leave = useCallback(() => {
    setEditing(null);
    if (canGoBack) {
      back();
    } else {
      onCancel();
    }
  }, [back, canGoBack, onCancel]);

  useKeyBindings("recall-overlay", [
    {
      scope: "overlay",
      bindings: wizardBindings({ canGoBack, onBack: leave, onCancel }),
    },
  ]);

  const handleSelect = useCallback(
    (key: string) => {
      if (key === RECALL_TOGGLE_ROW_KEY) {
        onSave({ recallEnabled: !settings.enabled });
        return;
      }
      if (key === RECALL_DISPLAY_ROW_KEY) {
        goTo("display");
        return;
      }
      if (key === RECALL_DIVERSITY_ROW_KEY) {
        goTo("diversity");
        return;
      }
      const row = findNumberRow(key);
      if (row) {
        setEditing(row);
        goTo("edit");
      }
    },
    [goTo, onSave, settings.enabled],
  );

  if (editing) {
    return (
      <RowEditor
        row={editing}
        current={editing.read(settings)}
        onSave={(value) =>
          onSave({ [editing.key]: value } as Partial<Settings>)
        }
      />
    );
  }

  if (wizard.step === "display") {
    return (
      <OverlayFrame
        command="/recall"
        title="How much of a recalled block to show"
      >
        <SingleSelectPicker
          items={buildDisplayRows(settings.display)}
          onSelect={(key) => {
            if (isRecallDisplay(key)) onSave({ recallDisplay: key });
          }}
          onCancel={leave}
          footer=" Enter select · ↑↓/jk navigate · Esc back"
        />
      </OverlayFrame>
    );
  }

  if (wizard.step === "diversity") {
    return (
      <OverlayFrame command="/recall" title="How the slots are shared out">
        <SingleSelectPicker
          items={buildDiversityRows(settings.diversity)}
          onSelect={(key) => {
            if (isRecallDiversity(key)) {
              onSave({ recallDiversity: key });
            }
          }}
          onCancel={leave}
          footer=" Enter select · ↑↓/jk navigate · Esc back"
        />
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame command="/recall" title="Configure passive recall">
      <SingleSelectPicker
        items={rows}
        onSelect={handleSelect}
        onCancel={leave}
        footer=" Enter select · ↑↓/jk navigate · Esc cancel"
      />
    </OverlayFrame>
  );
});
