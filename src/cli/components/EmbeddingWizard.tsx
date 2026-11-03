/**
 * The first-run vector-recall setup wizard (48-2 §4.9 step list, D5).
 *
 * Four numbered steps, exactly as 48-1 §7.2 writes them:
 *
 * 1. **Backend** — built-in model, external endpoint, or "not now" (which is a
 *    cancel and writes nothing).
 * 2. **Configuration** — the built-in tier with its size / licence / integrity
 *    disclosure and a separate download confirmation, or the endpoint form
 *    (URL → model → key-variable → masked key) followed by a test embedding that
 *    shows the reported dimension, norm and latency.
 * 3. **Calibration** — the bounded pass (≤5 s, skippable) with its p50/p90,
 *    throughput and the derived build budget.
 * 4. **Finish** — one write of the D3 settings record, the "keep building after
 *    exit" switch (off by default, R-34) and the build start.
 *
 * The state machine lives in `@/cli/helpers/embedding-wizard-state`, the async
 * runners in `@/cli/helpers/embedding-wizard-actions`, and the production
 * dependency defaults in `@/cli/helpers/embedding-wizard-defaults`; this file
 * only draws the state, binds the keys and calls a runner. Two consequences are
 * deliberate:
 *
 * - **Cancel writes nothing and a failed step keeps the screen.** The component
 *   has no write path of its own, and every async outcome goes back through the
 *   reducer, so a download/probe/save failure stays where it happened with the
 *   earlier answers intact.
 * - **The key is never painted.** The masked field keeps the typed value in the
 *   machine and the frame only ever shows the mask characters, or the *name* of
 *   the environment variable that holds the key.
 *
 * The production dependencies are the committed C4/C6/C5/D3 seams. `calibrate`
 * uses C5's `skipEmbeddingCalibration` with a redacted reason until a runtime
 * probe is wired (the dep is injectable for exactly that reason); `startBuild`
 * is A4's host seam — until `cli/helpers/embedding-build-host` is wired in, the
 * receipt says the command that starts the index instead of pretending a build
 * started.
 */

import { Box } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  InfoFrame,
  InfoLine,
  MaskedTextStep,
} from "@/cli/components/EmbeddingWizardFrames";
import {
  cursorIndexFor,
  PickerStep,
  StepHint,
  TextStep,
} from "@/cli/components/ScheduleWizardSteps";
import { Text } from "@/cli/components/Text";
import {
  type EmbeddingWizardStateReader,
  embeddingWizardSettingsPatch,
  runEmbeddingWizardCalibration,
  runEmbeddingWizardDownload,
  runEmbeddingWizardEndpointTest,
  runEmbeddingWizardFinish,
} from "@/cli/helpers/embedding-wizard-actions";
import { createEmbeddingWizardDefaultDeps } from "@/cli/helpers/embedding-wizard-defaults";
import {
  applyEmbeddingWizardEvent,
  createEmbeddingWizardState,
  EMBEDDING_WIZARD_COMMAND,
  EMBEDDING_WIZARD_STEP_COUNT,
  type EmbeddingWizardDeps,
  type EmbeddingWizardEvent,
  type EmbeddingWizardState,
  embeddingWizardEndpointNeedsKey,
  embeddingWizardModelOption,
  embeddingWizardModelOptions,
  embeddingWizardStepTitle,
  formatEmbeddingWizardBytes,
  isEmbeddingWizardBusy,
  resolveEmbeddingWizardApiKey,
} from "@/cli/helpers/embedding-wizard-state";
import { type KeyBinding, namedKeyChords } from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import { wizardBindings } from "@/cli/overlay/wizard";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";

const COMMAND = EMBEDDING_WIZARD_COMMAND;
const KEY_OWNER = "embedding-wizard";

/** Step 1's rows, in the order the requirement names them. */
const BACKEND_ITEMS: readonly SingleSelectItem[] = [
  {
    key: "builtin",
    label: "Built-in model",
    description:
      "Download once, runs locally; queries never leave this machine",
  },
  {
    key: "endpoint",
    label: "External endpoint",
    description:
      "OpenAI-compatible or Ollama; query text is sent to that endpoint",
  },
  {
    key: "later",
    label: "Not now",
    description: "Leave vector recall off; nothing is written",
  },
];

/** Step 2b's protocol rows. */
const ENDPOINT_KIND_ITEMS: readonly SingleSelectItem[] = [
  {
    key: "openai",
    label: "OpenAI-compatible",
    description: "POST /v1/embeddings (OpenAI, vLLM, LM Studio, most gateways)",
  },
  {
    key: "ollama",
    label: "Ollama",
    description: "POST /api/embed on a local Ollama daemon",
  },
];

export interface EmbeddingWizardProps {
  agentId: string;
  /** Escape at the root, Ctrl+C anywhere, or "Not now": nothing was written. */
  onClose: () => void;
  /**
   * The final write landed and the build was asked to start. The optional
   * receipt is what the overlay finishes its command row with.
   */
  onCompleted?: (receipt?: string) => void;
  /** Injected by tests; defaults to the real settings reader. */
  initialSettings?: ResolvedEmbeddingSettings;
  /** Injected by tests; production defaults are the C4/C6/C5/D3 seams. */
  deps?: Partial<EmbeddingWizardDeps>;
  /** Injected by tests for the key-by-environment-variable path. */
  env?: Record<string, string | undefined>;
}

/** The completion receipt when the build host has one to add. */
export function embeddingWizardCompletedText(): string {
  return "Vector recall configured and enabled. The index build starts in the background.";
}

// ── The wizard ─────────────────────────────────────────────────────────────

export function EmbeddingWizard({
  agentId,
  onClose,
  onCompleted,
  initialSettings,
  deps,
  env,
}: EmbeddingWizardProps) {
  const width = Math.max(1, useTerminalWidth() - 2);
  const [state, setState] = useState<EmbeddingWizardState>(() =>
    createEmbeddingWizardState({
      settings: initialSettings ?? readEmbeddingSettings(),
    }),
  );
  const stateRef = useRef(state);
  const busyRef = useRef(false);
  const closedRef = useRef(false);

  const resolvedDeps = useMemo(
    () => ({ ...createEmbeddingWizardDefaultDeps(agentId, env), ...deps }),
    [agentId, deps, env],
  );
  const depsRef = useRef(resolvedDeps);
  depsRef.current = resolvedDeps;

  /** Every state write goes through here so a runner's closure sees the latest. */
  const commit = useCallback((next: EmbeddingWizardState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const dispatch = useCallback(
    (event: EmbeddingWizardEvent) => {
      commit(applyEmbeddingWizardEvent(stateRef.current, event));
    },
    [commit],
  );

  /** What a runner applies its late outcome to: the wizard as it is now. */
  const stateReader = useCallback<EmbeddingWizardStateReader>(
    () => stateRef.current,
    [],
  );

  const runAction = useCallback(
    (
      action: (
        current: EmbeddingWizardState,
        listener: (next: EmbeddingWizardState) => void,
      ) => Promise<EmbeddingWizardState>,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      void action(stateRef.current, commit)
        .then((final) => {
          if (!closedRef.current) commit(final);
        })
        .catch(() => {
          // The runners turn dependency failures into state; nothing throws
          // here, and a thrown bug must not kill the overlay's render loop.
        })
        .finally(() => {
          busyRef.current = false;
        });
    },
    [commit],
  );

  // The trail's Escape/back and Ctrl+C. While an async action runs the keys are
  // consumed but do nothing: leaving mid-download or mid-save would race the
  // only write path.
  const busy = isEmbeddingWizardBusy(state);
  const onBack = useCallback(() => {
    if (isEmbeddingWizardBusy(stateRef.current)) return;
    dispatch({ type: "back" });
  }, [dispatch]);
  const onCancel = useCallback(() => {
    if (isEmbeddingWizardBusy(stateRef.current)) return;
    dispatch({ type: "cancel" });
  }, [dispatch]);

  // Close exactly once, when the machine reports an outcome.
  useEffect(() => {
    if (closedRef.current) return;
    if (state.outcome === "cancelled") {
      closedRef.current = true;
      onClose();
    } else if (state.outcome === "completed") {
      closedRef.current = true;
      const receipt = state.finish.buildReceipt ?? undefined;
      if (onCompleted) onCompleted(receipt);
      else onClose();
    }
  }, [state.outcome, state.finish.buildReceipt, onClose, onCompleted]);

  // Step 3 measures itself on arrival; the dep is instant when it is C5's
  // documented-defaults path, so this is not a spinner the user has to dismiss.
  useEffect(() => {
    if (state.step !== "calibrate") return;
    if (state.calibration.phase !== "idle") return;
    runAction((current, listener) =>
      runEmbeddingWizardCalibration(
        current,
        depsRef.current,
        listener,
        stateReader,
      ),
    );
  }, [state.step, state.calibration.phase, runAction, stateReader]);

  const startDownload = useCallback(() => {
    runAction((current, listener) =>
      runEmbeddingWizardDownload(
        current,
        depsRef.current,
        listener,
        stateReader,
      ),
    );
  }, [runAction, stateReader]);

  const startEndpointTest = useCallback(() => {
    runAction((current, listener) =>
      runEmbeddingWizardEndpointTest(
        current,
        depsRef.current,
        listener,
        stateReader,
      ),
    );
  }, [runAction, stateReader]);

  const startFinish = useCallback(() => {
    runAction((current, listener) =>
      runEmbeddingWizardFinish(current, depsRef.current, listener, stateReader),
    );
  }, [runAction, stateReader]);

  // Step 2b sends its one test embedding on arrival: the screen exists to show
  // the dimension/norm/error of that round trip, so making the user press Enter
  // again would just add a keystroke before the same request. The Enter binding
  // stays for retrying a failed test.
  useEffect(() => {
    if (state.step !== "endpoint-test") return;
    if (state.endpoint.test.phase !== "idle") return;
    runAction((current, listener) =>
      runEmbeddingWizardEndpointTest(
        current,
        depsRef.current,
        listener,
        stateReader,
      ),
    );
  }, [state.step, state.endpoint.test.phase, runAction, stateReader]);

  const isPickerStep =
    state.step === "backend" ||
    state.step === "builtin-model" ||
    state.step === "builtin-download" ||
    state.step === "endpoint-kind";

  const extraBindings: KeyBinding[] = [];
  if (state.step === "endpoint-test") {
    extraBindings.push({
      id: "embedding-wizard.endpoint-test",
      chords: namedKeyChords("return"),
      run: () => {
        const current = stateRef.current;
        if (isEmbeddingWizardBusy(current)) return "declined";
        if (
          current.endpoint.test.phase === "passed" &&
          current.endpoint.verified !== null
        ) {
          dispatch({ type: "next" });
          return "consumed";
        }
        startEndpointTest();
        return "consumed";
      },
    });
  }
  if (state.step === "calibrate") {
    extraBindings.push(
      {
        id: "embedding-wizard.calibrate-continue",
        chords: namedKeyChords("return"),
        run: () => {
          const current = stateRef.current;
          if (current.calibration.phase === "running") return "declined";
          if (current.calibration.phase === "idle") {
            runAction((latest, listener) =>
              runEmbeddingWizardCalibration(
                latest,
                depsRef.current,
                listener,
                stateReader,
              ),
            );
            return "consumed";
          }
          dispatch({ type: "next" });
          return "consumed";
        },
      },
      {
        id: "embedding-wizard.calibrate-skip",
        chords: [{ key: "s" }],
        run: () => {
          if (stateRef.current.calibration.phase === "done") {
            dispatch({ type: "next" });
            return "consumed";
          }
          dispatch({ type: "calibration-skip" });
          return "consumed";
        },
      },
      {
        id: "embedding-wizard.calibrate-retry",
        chords: [{ key: "r" }],
        run: () => {
          if (stateRef.current.calibration.phase !== "failed") {
            return "declined";
          }
          dispatch({ type: "calibration-reset" });
          return "consumed";
        },
      },
    );
  }
  if (state.step === "finish") {
    extraBindings.push(
      {
        id: "embedding-wizard.finish",
        chords: namedKeyChords("return"),
        run: () => {
          const current = stateRef.current;
          if (current.finish.phase === "saving") return "declined";
          startFinish();
          return "consumed";
        },
      },
      {
        id: "embedding-wizard.keep-after-exit",
        chords: [{ key: "t" }, { key: "space" }],
        run: () => {
          dispatch({ type: "toggle-keep-after-exit" });
          return "consumed";
        },
      },
    );
  }

  useKeyBindings(KEY_OWNER, [
    {
      scope: "overlay",
      bindings: isPickerStep
        ? []
        : [
            ...wizardBindings({
              canGoBack: !busy && state.step !== "backend",
              onBack,
              onCancel,
            }),
            ...extraBindings,
          ],
    },
  ]);

  const back = () => {
    if (isEmbeddingWizardBusy(stateRef.current)) return;
    dispatch({ type: "back" });
  };
  const cancel = () => {
    if (isEmbeddingWizardBusy(stateRef.current)) return;
    dispatch({ type: "cancel" });
  };

  // ── Step 1: backend ─────────────────────────────────────────────────────
  if (state.step === "backend") {
    return (
      <PickerStep
        key="backend"
        command={COMMAND}
        title={embeddingWizardStepTitle("backend")}
        hint="Where query vectors come from. The built-in model keeps every query on this machine; an endpoint sends the query text to it."
        items={BACKEND_ITEMS}
        initialCursorIndex={cursorIndexFor(
          BACKEND_ITEMS,
          state.backend ?? "builtin",
        )}
        onSelect={(key) => {
          if (key === "later") {
            cancel();
            return;
          }
          dispatch({
            type: "choose-backend",
            backend: key === "endpoint" ? "endpoint" : "builtin",
          });
        }}
        onCancel={cancel}
        footer="Enter select · ↑↓ move · Esc cancel"
        width={width}
      />
    );
  }

  // ── Step 2a: built-in model choice ──────────────────────────────────────
  if (state.step === "builtin-model") {
    const models = embeddingWizardModelOptions();
    const items: SingleSelectItem[] = models.map((model) => ({
      key: model.id,
      label: model.displayName,
      description: `${model.dimensions}d · ${
        model.totalBytes > 0
          ? formatEmbeddingWizardBytes(model.totalBytes)
          : "size unknown"
      } · ${model.licenseId}`,
    }));
    return (
      <PickerStep
        key="builtin-model"
        command={COMMAND}
        title={embeddingWizardStepTitle("builtin-model")}
        hint="The model is downloaded once and used for both indexing and queries. Pick the tier before downloading."
        items={items}
        initialCursorIndex={cursorIndexFor(items, state.builtin.modelId)}
        onSelect={(key) => dispatch({ type: "choose-model", modelId: key })}
        onCancel={back}
        footer="Enter select · ↑↓ move · Esc back"
        width={width}
      />
    );
  }

  // ── Step 2a: download confirmation ──────────────────────────────────────
  if (state.step === "builtin-download") {
    const option = embeddingWizardModelOption(state.builtin.modelId);
    const download = state.builtin.download;
    const items: SingleSelectItem[] = [
      {
        key: "download",
        label: download.phase === "failed" ? "Retry download" : "Download now",
        description:
          "Transfers the model files once, verifies them, then installs",
      },
      {
        key: "back",
        label: "Back",
        description: "Choose a different model",
      },
    ];
    return (
      <OverlayFrame
        key="builtin-download"
        command={COMMAND}
        title={embeddingWizardStepTitle("builtin-download")}
        footer={
          <StepHint
            text={
              busy
                ? "Downloading… Esc waits for the current file"
                : "Enter select · ↑↓ move · Esc back"
            }
            width={width}
          />
        }
      >
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <InfoLine
              text={
                option === undefined
                  ? `Model: ${state.builtin.modelId}`
                  : `Model: ${option.displayName}`
              }
              width={width}
            />
          </Box>
          {option === undefined ? null : (
            <>
              <InfoLine
                text={`Size: ${formatEmbeddingWizardBytes(option.totalBytes)} (one-time download)`}
                width={width}
              />
              <InfoLine
                text={`License: ${option.licenseName} (${option.licenseId})`}
                width={width}
              />
              <InfoLine text={`Terms: ${option.licenseNotice}`} width={width} />
              <InfoLine
                text={`More: ${option.licenseUrl}`}
                tone="dim"
                width={width}
              />
              <InfoLine
                text={
                  option.integrityPinned
                    ? "Integrity: every required file is sha256-pinned"
                    : "Integrity: some required files are verified by size only (sha256 not recorded)"
                }
                tone={option.integrityPinned ? "normal" : "dim"}
                width={width}
              />
              <Box height={1} />
            </>
          )}
          {download.phase === "running" ? (
            <InfoLine
              text={`Downloading… ${Math.round(download.progress * 100)}%`}
              width={width}
            />
          ) : null}
          {download.phase === "failed" ? (
            <>
              <InfoLine
                text={`Download failed: ${download.error ?? "unknown error"}`}
                tone="error"
                width={width}
              />
              {download.hint === null ? null : (
                <InfoLine text={download.hint} tone="dim" width={width} />
              )}
              <Box height={1} />
            </>
          ) : null}
          {download.phase === "done" ? (
            <InfoLine
              text={`Installed in ${download.modelDir ?? "the model cache"}`}
              tone="dim"
              width={width}
            />
          ) : null}
          <SingleSelectPicker
            items={items}
            onSelect={(key) => {
              if (isEmbeddingWizardBusy(stateRef.current)) return;
              if (key === "download") {
                startDownload();
                return;
              }
              back();
            }}
            onCancel={back}
            footer={
              <Text dimColor>
                {download.phase === "failed"
                  ? "Enter retry · Esc back"
                  : "Enter download · Esc back"}
              </Text>
            }
          />
        </Box>
      </OverlayFrame>
    );
  }

  // ── Step 2b: endpoint protocol ──────────────────────────────────────────
  if (state.step === "endpoint-kind") {
    return (
      <PickerStep
        key="endpoint-kind"
        command={COMMAND}
        title={embeddingWizardStepTitle("endpoint-kind")}
        hint="Which wire protocol the endpoint speaks. Both are tested with one embedding before they are accepted."
        items={ENDPOINT_KIND_ITEMS}
        initialCursorIndex={cursorIndexFor(
          ENDPOINT_KIND_ITEMS,
          state.endpoint.kind,
        )}
        onSelect={(key) =>
          dispatch({
            type: "choose-endpoint-kind",
            kind: key === "ollama" ? "ollama" : "openai",
          })
        }
        onCancel={back}
        footer="Enter select · ↑↓ move · Esc back"
        width={width}
      />
    );
  }

  // ── Step 2b: endpoint form ──────────────────────────────────────────────
  if (state.step === "endpoint-url") {
    return (
      <TextStep
        key="endpoint-url"
        command={COMMAND}
        title={embeddingWizardStepTitle("endpoint-url")}
        hint="Absolute https URL of the endpoint. Plain http is accepted only for localhost. No credentials in the URL."
        value={state.endpoint.baseUrl}
        onChange={(value) =>
          dispatch({ type: "update-endpoint", field: "baseUrl", value })
        }
        onSubmit={() => dispatch({ type: "next" })}
        placeholder="https://api.example.com/v1"
        error={state.error}
        footer="Enter continue · Esc back · ctrl+c cancel"
        width={width}
      />
    );
  }

  if (state.step === "endpoint-model") {
    return (
      <TextStep
        key="endpoint-model"
        command={COMMAND}
        title={embeddingWizardStepTitle("endpoint-model")}
        hint="Embedding model id advertised by the endpoint, e.g. text-embedding-3-small or nomic-embed-text."
        value={state.endpoint.model}
        onChange={(value) =>
          dispatch({ type: "update-endpoint", field: "model", value })
        }
        onSubmit={() => dispatch({ type: "next" })}
        placeholder="text-embedding-3-small"
        error={state.error}
        footer="Enter continue · Esc back · ctrl+c cancel"
        width={width}
      />
    );
  }

  if (state.step === "endpoint-key-env") {
    return (
      <TextStep
        key="endpoint-key-env"
        command={COMMAND}
        title={embeddingWizardStepTitle("endpoint-key-env")}
        hint="Optional: name of the environment variable holding the API key, e.g. HARUYUKI_EMBEDDING_API_KEY. The value is read here and stored write-only; it is never written to settings."
        value={state.endpoint.apiKeyEnv}
        onChange={(value) =>
          dispatch({ type: "update-endpoint", field: "apiKeyEnv", value })
        }
        onSubmit={() => dispatch({ type: "next" })}
        placeholder="HARUYUKI_EMBEDDING_API_KEY"
        error={state.error}
        footer="Enter continue · Esc back · ctrl+c cancel"
        width={width}
      />
    );
  }

  if (state.step === "endpoint-key") {
    return (
      <MaskedTextStep
        key="endpoint-key"
        title={embeddingWizardStepTitle("endpoint-key")}
        hint={
          embeddingWizardEndpointNeedsKey(state)
            ? "API key, masked. Leave empty when the environment variable above holds it."
            : "Ollama usually needs no key; leave empty unless the daemon is behind auth."
        }
        value={state.endpoint.apiKey}
        onChange={(value) =>
          dispatch({ type: "update-endpoint", field: "apiKey", value })
        }
        onSubmit={() => dispatch({ type: "next" })}
        placeholder="(hidden)"
        error={state.error}
        footer="Enter continue · Esc back · ctrl+c cancel"
        width={width}
      />
    );
  }

  // ── Step 2b: test embedding ─────────────────────────────────────────────
  if (state.step === "endpoint-test") {
    const test = state.endpoint.test;
    const resolution = resolveEmbeddingWizardApiKey(
      state,
      (name) => (env ?? process.env)[name],
    );
    const keyLine =
      state.endpoint.apiKeyEnv.trim().length > 0
        ? `API key: from $${state.endpoint.apiKeyEnv.trim()}`
        : resolution.source === "typed"
          ? "API key: typed (hidden)"
          : "API key: none";
    return (
      <InfoFrame
        key="endpoint-test"
        title={embeddingWizardStepTitle("endpoint-test")}
        footer={
          test.phase === "passed"
            ? "Enter continue · Esc back · ctrl+c cancel"
            : "Enter test · Esc back · ctrl+c cancel"
        }
        width={width}
      >
        <InfoLine
          text={`Endpoint: ${state.endpoint.kind} · ${state.endpoint.baseUrl}`}
          width={width}
        />
        <InfoLine text={`Model: ${state.endpoint.model}`} width={width} />
        <InfoLine text={keyLine} width={width} />
        <InfoLine
          text="Egress: the test text and every later query are sent to this endpoint."
          tone="dim"
          width={width}
        />
        <Box height={1} />
        {test.phase === "running" ? (
          <InfoLine text="Sending one test embedding…" width={width} />
        ) : null}
        {test.phase === "passed" ? (
          <>
            <InfoLine
              text={`Test embedding OK · ${test.dimensions ?? 0}d · norm ${(test.norm ?? 0).toFixed(3)} · ${test.latencyMs ?? 0}ms`}
              width={width}
            />
            <InfoLine
              text="The endpoint's dimension is what the vector space will use."
              tone="dim"
              width={width}
            />
          </>
        ) : null}
        {test.phase === "failed" ? (
          <InfoLine
            text={`Test embedding failed: ${test.error ?? "unknown error"}`}
            tone="error"
            width={width}
          />
        ) : null}
        {test.phase === "idle" ? (
          <InfoLine
            text="Send one test embedding to verify connectivity, the dimension and the L2 norm."
            tone="dim"
            width={width}
          />
        ) : null}
      </InfoFrame>
    );
  }

  // ── Step 3: calibration ─────────────────────────────────────────────────
  if (state.step === "calibrate") {
    const calibration = state.calibration;
    const result = calibration.result;
    return (
      <InfoFrame
        key="calibrate"
        title={embeddingWizardStepTitle("calibrate")}
        footer={
          calibration.phase === "running"
            ? "s skip · Esc waits for the measurement"
            : calibration.phase === "failed"
              ? "Enter continue · r retry · s skip · Esc back"
              : "Enter continue · s skip · Esc back"
        }
        width={width}
      >
        {calibration.phase === "idle" || calibration.phase === "running" ? (
          <>
            <InfoLine
              text="Measuring query latency and deriving the build budget (bounded to 5s)…"
              width={width}
            />
            <InfoLine
              text="The measurement is bounded: the documented defaults are used if it runs out of time."
              tone="dim"
              width={width}
            />
          </>
        ) : null}
        {result === null ? null : (
          <>
            <InfoLine
              text={`Query latency: p50 ${result.p50Ms}ms · p90 ${result.p90Ms}ms · ${result.throughputPerSec}/s`}
              width={width}
            />
            <InfoLine
              text={`Budget: query +${result.queryBudgetMs}ms · ${result.threads} threads · ${result.gpuRole} gpu · ${result.quantization}`}
              width={width}
            />
            <InfoLine
              text={`Memory: RSS ${formatEmbeddingWizardBytes(result.rssBytes)} · disk ${formatEmbeddingWizardBytes(result.diskFreeBytes)} free (${result.diskHeadroomOk ? "ok" : "low"})`}
              width={width}
            />
            <InfoLine
              text={`Tier: ${result.tier}${result.calibrated ? " (calibrated)" : ` (uncalibrated: ${result.reason ?? "unknown reason"})`}`}
              tone={result.calibrated ? "normal" : "dim"}
              width={width}
            />
            <Box height={1} />
          </>
        )}
        {calibration.phase === "skipped" ? (
          <InfoLine
            text="Calibration skipped: the documented defaults are used and can be re-measured later."
            tone="dim"
            width={width}
          />
        ) : null}
        {calibration.phase === "failed" ? (
          <InfoLine
            text={`Calibration failed: ${calibration.error ?? "unknown error"} — the documented defaults will be used.`}
            tone="error"
            width={width}
          />
        ) : null}
        {calibration.phase === "done" && result?.calibrated === false ? (
          <InfoLine
            text="The measurement could not complete, so the documented defaults above are shown instead of measurements."
            tone="dim"
            width={width}
          />
        ) : null}
      </InfoFrame>
    );
  }

  // ── Step 4: finish ──────────────────────────────────────────────────────
  const option = embeddingWizardModelOption(state.builtin.modelId);
  const patchPreview = embeddingWizardSettingsPatch(state);
  const finish = state.finish;
  const calibrationLine =
    state.calibration.result === null
      ? "Calibration: skipped (documented defaults)"
      : `Calibration: p50 ${state.calibration.result.p50Ms}ms · p90 ${state.calibration.result.p90Ms}ms · query budget ${state.calibration.result.queryBudgetMs}ms`;
  const backendLine =
    state.backend === "endpoint"
      ? `Backend: endpoint · ${state.endpoint.kind} · ${state.endpoint.verified?.baseUrl ?? state.endpoint.baseUrl} · ${state.endpoint.verified?.model ?? state.endpoint.model}`
      : `Backend: built-in · ${option?.displayName ?? state.builtin.modelId}`;
  return (
    <InfoFrame
      key="finish"
      title={embeddingWizardStepTitle("finish")}
      footer={
        finish.phase === "saving"
          ? "Saving settings and starting the build…"
          : "Enter finish · t toggle keep-after-exit · Esc back · ctrl+c cancel"
      }
      width={width}
    >
      <InfoLine text={backendLine} width={width} />
      <InfoLine text={calibrationLine} width={width} />
      {state.backend === "endpoint" ? (
        <InfoLine
          text="Egress: query text leaves this machine (endpoint); the egress marker stays on the status line."
          tone="dim"
          width={width}
        />
      ) : null}
      <Box height={1} />
      <InfoLine
        text={
          finish.keepAfterExit
            ? "Build: starts when you finish; keep-after-exit keeps it running after you leave (detached)."
            : "Build: starts when you finish; closing Haruyuki stops it and it resumes next run."
        }
        width={width}
      />
      <InfoLine
        text={`${finish.keepAfterExit ? "[x]" : "[ ]"} Keep building after you exit`}
        width={width}
      />
      <InfoLine
        text={
          finish.keepAfterExit
            ? "On: the build runs detached and survives closing Haruyuki."
            : "Off (default): closing Haruyuki stops the build; it resumes next run."
        }
        tone="dim"
        width={width}
      />
      {patchPreview.error === null ? null : (
        <InfoLine text={patchPreview.error} tone="error" width={width} />
      )}
      {finish.phase === "saving" ? (
        <InfoLine text="Saving settings…" tone="dim" width={width} />
      ) : null}
      {finish.phase === "failed" ? (
        <InfoLine
          text={`Finish failed: ${finish.error ?? "unknown error"}. Nothing else was written; Enter retries.`}
          tone="error"
          width={width}
        />
      ) : null}
    </InfoFrame>
  );
}

/** Exported for the frame test: the number of numbered questions. */
export function embeddingWizardStepCount(): number {
  return EMBEDDING_WIZARD_STEP_COUNT;
}
