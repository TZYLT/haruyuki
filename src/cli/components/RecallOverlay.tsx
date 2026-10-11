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
import { Box, type Key, useInput } from "ink";
import { memo, useCallback, useMemo, useState } from "react";
import { parseRecallCount, parseRecallRatio } from "@/cli/commands/recall";
import type { ResolvedRecallSettings } from "@/recall-settings";
import {
  isRecallDisplay,
  type RecallDisplay,
} from "@/reminders/recall-display";
import type { RecallDiversity } from "@/reminders/recall-port";
import { isRecallDiversity } from "@/reminders/recall-port";
import type { Settings } from "@/settings-manager";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { type SelectableItem, SingleSelectPicker } from "./SingleSelectPicker";
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
): SelectableItem[] {
  const rows: SelectableItem[] = [
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

export function buildDisplayRows(current: RecallDisplay): SelectableItem[] {
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

export function buildDiversityRows(current: RecallDiversity): SelectableItem[] {
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
  onBack: () => void;
  onCancel: () => void;
}

/** Second view: one line of text for one numeric knob. */
function RowEditor({ row, current, onSave, onBack, onCancel }: RowEditorProps) {
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState("");

  useInput((input: string, key: Key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (key.escape) onBack();
  });

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
    <OverlayShell command="/recall" title={row.label}>
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>{`${row.prompt} Currently ${numberRowValue(row, current)}.`}</Text>
        </Box>

        <Box>
          <Text color={colors.approval.header}>{"> "}</Text>
          <PasteAwareTextInput
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setError("");
            }}
            onSubmit={submit}
            placeholder={String(current)}
          />
        </Box>

        {error ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text dimColor>Enter to save · Esc back · Ctrl-C cancel</Text>
        </Box>
      </Box>
    </OverlayShell>
  );
}

type SubPicker = "display" | "diversity";

export const RecallOverlay = memo(function RecallOverlay({
  settings,
  onSave,
  onCancel,
}: RecallOverlayProps) {
  const [editing, setEditing] = useState<RecallNumberRow | null>(null);
  const [subPicker, setSubPicker] = useState<SubPicker | null>(null);
  const rows = useMemo(() => buildRecallPickerRows(settings), [settings]);

  const handleSelect = useCallback(
    (key: string) => {
      if (key === RECALL_TOGGLE_ROW_KEY) {
        onSave({ recallEnabled: !settings.enabled });
        return;
      }
      if (key === RECALL_DISPLAY_ROW_KEY) {
        setSubPicker("display");
        return;
      }
      if (key === RECALL_DIVERSITY_ROW_KEY) {
        setSubPicker("diversity");
        return;
      }
      const row = findNumberRow(key);
      if (row) setEditing(row);
    },
    [onSave, settings.enabled],
  );

  if (editing) {
    return (
      <RowEditor
        row={editing}
        current={editing.read(settings)}
        onSave={(value) =>
          onSave({ [editing.key]: value } as Partial<Settings>)
        }
        onBack={() => setEditing(null)}
        onCancel={onCancel}
      />
    );
  }

  if (subPicker === "display") {
    return (
      <OverlayShell
        command="/recall"
        title="How much of a recalled block to show"
      >
        <SingleSelectPicker
          items={buildDisplayRows(settings.display)}
          onSelect={(key) => {
            if (isRecallDisplay(key)) onSave({ recallDisplay: key });
          }}
          onCancel={() => setSubPicker(null)}
          footer=" Enter select · ↑↓/jk navigate · Esc back"
        />
      </OverlayShell>
    );
  }

  if (subPicker === "diversity") {
    return (
      <OverlayShell command="/recall" title="How the slots are shared out">
        <SingleSelectPicker
          items={buildDiversityRows(settings.diversity)}
          onSelect={(key) => {
            if (isRecallDiversity(key)) {
              onSave({ recallDiversity: key });
            }
          }}
          onCancel={() => setSubPicker(null)}
          footer=" Enter select · ↑↓/jk navigate · Esc back"
        />
      </OverlayShell>
    );
  }

  return (
    <OverlayShell command="/recall" title="Configure passive recall">
      <SingleSelectPicker
        items={rows}
        onSelect={handleSelect}
        onCancel={onCancel}
        footer=" Enter select · ↑↓/jk navigate · Esc cancel"
      />
    </OverlayShell>
  );
});
