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
 *
 * Two faces share this component. `/recall` opens the list; `/recall embedding
 * config` (48-4 D-16) opens the vector block's build-keys page directly through
 * `initialPage`, because that command's own answer is a table of the six keys and
 * the useful next move is to edit one. Its writes still go through
 * `/recall embedding config <key> <value>` rather than a second settings path.
 */
import { Box } from "ink";
import { memo, useCallback, useMemo, useState } from "react";
import {
  EMBEDDING_CONFIG_KEYS,
  type EmbeddingConfigKey,
} from "@/cli/commands/embedding-command-parser";
import { embeddingConfigRows } from "@/cli/commands/embedding-status";
import { parseRecallCount, parseRecallRatio } from "@/cli/commands/recall";
import { EmbeddingModelPicker } from "@/cli/components/EmbeddingModelPicker";
import type { EmbeddingModelRow } from "@/cli/helpers/embedding-models";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
  type ResolvedRecallSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import {
  isRecallDisplay,
  type RecallDisplay,
} from "@/reminders/recall-display";
import type { RecallDiversity } from "@/reminders/recall-port";
import { isRecallDiversity } from "@/reminders/recall-port";
import type { Settings } from "@/settings-manager";
import { getErrorMessage } from "@/utils/error";
import { Text } from "./Text";

/** The views a caller may raise directly; the list is the default entrance. */
export type RecallOverlayPage = "list" | "embedding-build";

export interface RecallOverlayProps {
  settings: ResolvedRecallSettings;
  /** Writes the change; the caller owns persistence and the receipt. */
  onSave: (updates: Partial<Settings>) => void;
  onCancel: () => void;
  /** Feature 48's live settings for the embedding block's labels. */
  embeddingSettings?: ResolvedEmbeddingSettings;
  /**
   * Where to open. `/recall embedding config` raises the build-settings page so
   * the keys are editable in place; every other entrance starts at the list.
   */
  initialPage?: RecallOverlayPage;
  /** Scope passed to `/recall embedding …`; the overlay may not know it. */
  agentId?: string;
  conversationId?: string;
  /**
   * Test seam: the embedding command runner. Production omits it and uses the
   * same handler `/recall embedding` uses, with the TUI lifecycle.
   */
  runEmbeddingCommand?: (args: string[]) => Promise<string>;
  /**
   * Test seam for the build page's re-read after a write. Production omits it
   * and reads the settings store, because the parent does not re-render while
   * this overlay is mounted.
   */
  reloadEmbeddingSettings?: () => ResolvedEmbeddingSettings;
  /**
   * Test seam for the model picker's listing. Production omits it and reads the
   * spaces on disk.
   */
  loadEmbeddingModels?: (agentId: string) => Promise<EmbeddingModelRow[]>;
}

type RecallSettingKey = keyof Settings & `recall${string}`;

interface RecallNumberRow {
  key: RecallSettingKey;
  label: string;
  /**
   * The current value. `embedding` carries the two vector-only knobs
   * (`weight`/`depth`), which are stored on the embedding record rather than the
   * recall one; the lexical rows ignore it.
   */
  read: (
    settings: ResolvedRecallSettings,
    embedding: ResolvedEmbeddingSettings | undefined,
  ) => number;
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
  // The two vector-only knobs live on the embedding record (48-4 D-05), so the
  // picker reads them from the resolved embedding settings; editing writes the
  // same two `Settings` keys `/recall config weight|depth` writes.
  {
    key: "recallEmbeddingWeight",
    label: "Vector arm weight",
    read: (_settings, embedding) =>
      embedding?.weight ?? EMBEDDING_SETTING_DEFAULTS.weight,
    prompt:
      "How much the vector arm contributes when both arms are on (0 to 1; needs vector recall on)",
    parse: parseRecallRatio,
  },
  {
    key: "recallEmbeddingCandidateDepth",
    label: "Vector candidate depth",
    read: (_settings, embedding) =>
      embedding?.candidateDepth ?? EMBEDDING_SETTING_DEFAULTS.candidateDepth,
    prompt:
      "Candidates each arm retrieves per turn before fusion (needs vector recall on)",
    parse: parseRecallCount,
  },
];

/** The row that toggles the feature, and the two enum rows. */
export const RECALL_TOGGLE_ROW_KEY = "recallEnabled";
export const RECALL_DISPLAY_ROW_KEY = "recallDisplay";
export const RECALL_DIVERSITY_ROW_KEY = "recallDiversity";
/** Feature 48's block: status, on/off, build, reset and setup, one screen in. */
export const RECALL_EMBEDDING_ROW_KEY = "embedding";
/** The block's last row: the six build keys, editable in place (D-16). */
export const RECALL_EMBEDDING_BUILD_ROW_KEY = "build-settings";

/** `builtin · model` or `endpoint · model`, the one line the rows show. */
function embeddingBackendLabel(settings: ResolvedEmbeddingSettings): string {
  return settings.backend === "endpoint"
    ? `endpoint · ${settings.endpoint?.model ?? "unconfigured"}`
    : `builtin · ${settings.model}`;
}

/**
 * The embedding block's actions (48-1 §7.4: "现有 RecallOverlay 增加 embedding
 * 区块"). They are command dispatches rather than settings writes, so every
 * write still goes through the embedding handler's own validator (D3).
 */
export function buildEmbeddingRows(
  settings: ResolvedEmbeddingSettings | undefined,
): SingleSelectItem[] {
  const enabled = settings?.enabled === true;
  const backend =
    settings === undefined
      ? "not available in this process"
      : embeddingBackendLabel(settings);
  return [
    {
      key: "toggle",
      label: enabled ? "Turn vector recall off" : "Turn vector recall on",
      description: `${backend} — Enter to ${enabled ? "disable" : "enable"}`,
    },
    {
      key: "status",
      label: "Index status",
      description: "space, coverage, build state, arm counters",
    },
    {
      key: "build",
      label: "Build index now",
      description: "incremental; runs in the background",
    },
    {
      key: "reset",
      label: "Delete stored vectors",
      description: "preview first; the delete itself needs --confirm",
    },
    {
      key: "connect",
      label: "Connect a vector source",
      description: "model, endpoint, precision, then build",
    },
    {
      key: "model",
      label: "Stored models",
      description: "list, select or delete a model (48-4 D-09)",
    },
    {
      key: RECALL_EMBEDDING_BUILD_ROW_KEY,
      label: "Build settings",
      description: "chunk window, threads and the GPU role — Enter to change",
    },
  ];
}

function numberRowValue(row: RecallNumberRow, value: number): string {
  return row.unit === undefined ? String(value) : `${value} ${row.unit}`;
}

/**
 * The picker rows, in the order a person meets them: whether it runs at all, what
 * they see, then the search's own knobs.
 */
export function buildRecallPickerRows(
  settings: ResolvedRecallSettings,
  embedding?: ResolvedEmbeddingSettings,
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
      description: `${numberRowValue(row, row.read(settings, embedding))} — Enter to change`,
    });
  }
  rows.push({
    key: RECALL_EMBEDDING_ROW_KEY,
    label: "Vector recall (embedding)",
    description:
      embedding === undefined
        ? "semantic arm — Enter for status, build, setup"
        : `${embedding.enabled ? "on" : "off"} · ${embeddingBackendLabel(embedding)} — Enter for status, build, setup`,
  });
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

/** One editable `/recall embedding config` knob, as the build page shows it. */
interface EmbeddingBuildKnob {
  key: EmbeddingConfigKey;
  /** The editor's question, spelling out what the value does. */
  prompt: string;
  /** The value a person would type to reproduce the current setting. */
  value: (settings: ResolvedEmbeddingSettings) => string;
}

/**
 * The six build keys (48-4 D-16), keyed by the parser's own union.
 *
 * Typed as a `Record<EmbeddingConfigKey, …>` for the reason the completion hints
 * are: a key added to the vocabulary without an editor (or an editor for a key
 * the parser refuses) is a type error, not a page that silently omits a knob.
 */
const EMBEDDING_BUILD_KNOBS: Readonly<
  Record<EmbeddingConfigKey, Omit<EmbeddingBuildKnob, "key">>
> = {
  "chunk-target": {
    prompt: "Target chunk window in tokens (changing it creates a new space)",
    value: (settings) => String(settings.chunkTarget),
  },
  "chunk-max": {
    prompt: "Hard chunk ceiling in tokens (changing it creates a new space)",
    value: (settings) => String(settings.chunkMax),
  },
  "chunk-overlap": {
    prompt: "Chunk overlap in tokens (changing it creates a new space)",
    value: (settings) => String(settings.chunkOverlap),
  },
  "max-chunks": {
    prompt:
      "Chunks embedded per message (changing it creates a new space; 0 is refused)",
    value: (settings) => String(settings.maxChunksPerMessage),
  },
  threads: {
    prompt: "Encode and build threads (0 = automatic)",
    value: (settings) => String(settings.threads),
  },
  gpu: {
    prompt: "Use the GPU for index builds: auto or off (Windows only)",
    value: (settings) => settings.gpu,
  },
};

/**
 * The build page's rows: the key, the current value in the same phrasing
 * `/recall embedding config` prints, and the edit hint. Reading through
 * `embeddingConfigRows` is what keeps the page and the table from disagreeing.
 */
export function buildEmbeddingBuildRows(
  settings: ResolvedEmbeddingSettings,
): SingleSelectItem[] {
  const values = embeddingConfigRows(settings);
  return EMBEDDING_CONFIG_KEYS.map((key) => ({
    key,
    label: key,
    description: `${values[key]} — Enter to change`,
  }));
}

function findEmbeddingBuildKnob(key: string): EmbeddingBuildKnob | undefined {
  const found = EMBEDDING_CONFIG_KEYS.find((candidate) => candidate === key);
  return found === undefined
    ? undefined
    : { key: found, ...EMBEDDING_BUILD_KNOBS[found] };
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

interface EmbeddingBuildEditorProps {
  knob: EmbeddingBuildKnob;
  current: string;
  /**
   * Save one value through `/recall embedding config <key> <value>`.
   *
   * Resolves to the handler's refusal text (shown in red, the row stays open) or
   * `""` when the value was written — the caller then moves on to the receipt,
   * so the editor does not decide what happens next.
   */
  onSave: (value: string) => Promise<string>;
}

/**
 * The build page's one-line editor, the same shape as {@link RowEditor}.
 *
 * The value is not parsed here: `/recall embedding config <key> <value>` is the
 * only writer, and its validator is the one that accepts or refuses. This is why
 * the refusal text is the handler's own sentence rather than a second message
 * that could disagree with the typed command.
 */
function EmbeddingBuildEditor({
  knob,
  current,
  onSave,
}: EmbeddingBuildEditorProps) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState("");

  const submit = useCallback(
    async (text: string) => {
      setError("");
      const refusal = await onSave(text);
      if (refusal !== "") setError(refusal);
    },
    [onSave],
  );

  return (
    <OverlayFrame command="/recall embedding" title={`Config · ${knob.key}`}>
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>{`${knob.prompt} Currently ${current}.`}</Text>
        </Box>

        <OverlayTextField
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setError("");
          }}
          onSubmit={(text) => {
            void submit(text);
          }}
          placeholder={current}
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

type SubPicker =
  | "display"
  | "diversity"
  | "embedding"
  | "models"
  | "embedding-build";

/** Which of the overlay's views is on screen. */
type RecallStep =
  | "list"
  | SubPicker
  | "edit"
  | "embedding-build-edit"
  | "embedding-output";

export const RecallOverlay = memo(function RecallOverlay({
  settings,
  onSave,
  onCancel,
  embeddingSettings,
  initialPage,
  agentId,
  conversationId,
  runEmbeddingCommand,
  reloadEmbeddingSettings,
  loadEmbeddingModels,
}: RecallOverlayProps) {
  const wizard = useWizard<RecallStep>({
    initial: initialPage === "embedding-build" ? "embedding-build" : "list",
  });
  const { canGoBack, back, goTo, popTo } = wizard;
  const [editing, setEditing] = useState<RecallNumberRow | null>(null);
  const [editingBuild, setEditingBuild] = useState<EmbeddingBuildKnob | null>(
    null,
  );
  /**
   * The build page's values after a write.
   *
   * The prop is a snapshot taken when the face was raised, and the parent does
   * not re-render while this overlay is mounted, so a saved key would otherwise
   * keep showing its old value. The reader is the same one the prop comes from.
   */
  const [rereadEmbedding, setRereadEmbedding] =
    useState<ResolvedEmbeddingSettings | null>(null);
  const embeddingNow =
    rereadEmbedding ?? embeddingSettings ?? EMBEDDING_SETTING_DEFAULTS;
  const [embeddingOutput, setEmbeddingOutput] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const rows = useMemo(
    () => buildRecallPickerRows(settings, embeddingNow),
    [embeddingNow, settings],
  );

  /**
   * Run one `/recall embedding …` action through the same handler the typed
   * command uses. The runtime port is imported lazily: opening this picker must
   * not load the worker/ONNX modules unless the user actually runs an action.
   */
  const runEmbedding = useCallback(
    async (args: string[]): Promise<string> => {
      if (runEmbeddingCommand !== undefined) {
        return await runEmbeddingCommand(args);
      }
      const [{ handleEmbeddingCommand }, { createEmbeddingRuntimePort }] =
        await Promise.all([
          import("@/cli/commands/embedding"),
          import("@/cli/helpers/embedding-runtime"),
        ]);
      const scope =
        agentId === undefined
          ? undefined
          : { agentId, conversationId: conversationId ?? null };
      return await handleEmbeddingCommand(args, scope, {
        runtime: createEmbeddingRuntimePort({ lifecycle: "tui" }),
      });
    },
    [agentId, conversationId, runEmbeddingCommand],
  );

  const runEmbeddingAction = useCallback(
    (key: string) => {
      // The model row opens its own picker instead of printing the table: the
      // cursor, D and P are the whole reason it exists (48-4 D-09). The build
      // row opens the six-key page for the same reason: a table of settings is
      // something to change, not something to print over the face.
      if (key === "model") {
        goTo("models");
        return;
      }
      if (key === RECALL_EMBEDDING_BUILD_ROW_KEY) {
        goTo("embedding-build");
        return;
      }
      const enabled = embeddingNow.enabled;
      const args =
        key === "toggle"
          ? [enabled ? "off" : "on"]
          : key === "status"
            ? ["status"]
            : key === "build"
              ? ["build"]
              : key === "reset"
                ? ["reset"]
                : ["connect"];
      void (async () => {
        try {
          const text = await runEmbedding(args);
          setEmbeddingOutput({ title: `Vector recall · ${args[0]}`, text });
        } catch (error) {
          setEmbeddingOutput({
            title: "Vector recall",
            text: `Could not run it: ${getErrorMessage(error)}`,
          });
        }
        goTo("embedding-output");
      })();
    },
    [embeddingNow.enabled, goTo, runEmbedding],
  );

  /**
   * Write one build key through `/recall embedding config <key> <value>`.
   *
   * That command is the only writer (D-03's validator), so its refusal sentence
   * is what the editor shows and a success re-reads the settings — the parent
   * does not re-render under an open overlay — before printing the same receipt
   * the typed command prints.
   */
  const saveEmbeddingBuildValue = useCallback(
    async (key: EmbeddingConfigKey, value: string): Promise<string> => {
      try {
        const text = await runEmbedding(["config", key, value]);
        // `runSet` is the only writer for a key's value and its success receipt
        // is `Updated <label>.`; everything else — the validator's "Not saved"
        // sentence, or the parser's syntax message plus the usage block — is a
        // refusal and must leave the editor open with its text.
        if (!text.startsWith("Updated ")) {
          return text.length === 0 ? "The value was not saved." : text;
        }
        setRereadEmbedding(
          (reloadEmbeddingSettings ?? readEmbeddingSettings)(),
        );
        setEmbeddingOutput({ title: `Vector recall · ${key}`, text });
        setEditingBuild(null);
        popTo("embedding-build");
        goTo("embedding-output");
        return "";
      } catch (error) {
        return `Could not save it: ${getErrorMessage(error)}`;
      }
    },
    [goTo, popTo, reloadEmbeddingSettings, runEmbedding],
  );

  /**
   * Escape from a view that has one below it, and the close when it does not.
   *
   * The pickers are handed this as their own cancel, which is exactly what this
   * face did before: their cancel binding consumes Escape *and* Ctrl+C, so
   * Ctrl+C on a sub-picker went back rather than out. That is preserved here on
   * purpose — the wizard's rule (Ctrl+C closes from anywhere) is the one
   * `/config connect` needed, and changing it under a face that never asked is not what
   * this batch is for.
   */
  const leave = useCallback(() => {
    setEditing(null);
    setEditingBuild(null);
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
      if (key === RECALL_EMBEDDING_ROW_KEY) {
        goTo("embedding");
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
        current={editing.read(settings, embeddingNow)}
        onSave={(value) =>
          onSave({ [editing.key]: value } as Partial<Settings>)
        }
      />
    );
  }

  if (editingBuild) {
    return (
      <EmbeddingBuildEditor
        knob={editingBuild}
        current={editingBuild.value(embeddingNow)}
        onSave={(value) => saveEmbeddingBuildValue(editingBuild.key, value)}
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

  if (wizard.step === "embedding") {
    return (
      <OverlayFrame command="/recall" title="Vector recall">
        <SingleSelectPicker
          items={buildEmbeddingRows(embeddingNow)}
          onSelect={(key) => runEmbeddingAction(key)}
          onCancel={leave}
          footer=" Enter run · ↑↓/jk navigate · Esc back"
        />
      </OverlayFrame>
    );
  }

  if (wizard.step === "embedding-build") {
    return (
      <OverlayFrame command="/recall embedding" title="Build settings">
        <SingleSelectPicker
          items={buildEmbeddingBuildRows(embeddingNow)}
          onSelect={(key) => {
            const knob = findEmbeddingBuildKnob(key);
            if (knob === undefined) return;
            setEditingBuild(knob);
            goTo("embedding-build-edit");
          }}
          onCancel={leave}
          footer=" Enter edit · ↑↓/jk navigate · Esc back"
        />
      </OverlayFrame>
    );
  }

  if (wizard.step === "models") {
    return (
      <EmbeddingModelPicker
        agentId={agentId}
        runCommand={runEmbedding}
        {...(loadEmbeddingModels === undefined
          ? {}
          : { loadModels: loadEmbeddingModels })}
      />
    );
  }

  if (wizard.step === "embedding-output") {
    return (
      <OverlayFrame
        command="/recall"
        title={embeddingOutput?.title ?? "Vector recall"}
      >
        <Box flexDirection="column">
          {(embeddingOutput?.text ?? "").split("\n").map((line, index) => (
            // Status lines are stable text; their position is the identity.
            <Text key={`${index}-${line}`}>{line}</Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>Esc back · Ctrl-C close</Text>
          </Box>
        </Box>
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
