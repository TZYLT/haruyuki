/**
 * The first-run vector-recall setup wizard (48-2 §4.9 step list, D5).
 *
 * Four numbered steps, exactly as 48-1 §7.2 writes them:
 *
 * 1. **Backend** — built-in model, external endpoint, or "not now" (which is a
 *    cancel and writes nothing).
 * 2. **Configuration** — the GPU role (auto / CPU-only / index-build-only, the
 *    last Windows-only), then either the built-in tier — a cached-install check
 *    for the weights *and* the onnxruntime closure, a two-size download
 *    confirmation only when something is missing, and the licence/integrity
 *    disclosure — or the endpoint form (URL → model → key-variable → masked key)
 *    followed by a test embedding.
 * 3. **Calibration** — the bounded pass (≤5 s, skippable) with its p50/p90,
 *    throughput and the derived build budget; a defaults-based result says "not
 *    measured" instead of painting zeros.
 * 4. **Finish** — one write of the D3 settings record (GPU role included), the
 *    selectable "keep building after you exit" and build-mode rows (the mode
 *    only reaches the build request), and the build start.
 *
 * The state machine lives in `@/cli/helpers/embedding-wizard-state`, its pure
 * facts in `@/cli/helpers/embedding-wizard-facts`, the async runners in
 * `@/cli/helpers/embedding-wizard-actions`, and the production dependency
 * defaults in `@/cli/helpers/embedding-wizard-defaults`; this file only draws
 * the state, binds the keys and calls a runner. Two consequences are
 * deliberate:
 *
 * - **Cancel writes nothing and a failed step keeps the screen.** The component
 *   has no write path of its own, and every async outcome goes back through the
 *   reducer, so a download/check/probe/save failure stays where it happened with
 *   the earlier answers intact.
 * - **The key is never painted.** The masked field keeps the typed value in the
 *   machine and the frame only ever shows the mask characters, or the *name* of
 *   the environment variable that holds the key.
 *
 * The production dependencies are the committed C4/C2/C6/C5/D3 seams. `calibrate`
 * uses C5's `skipEmbeddingCalibration` with a redacted reason until a runtime
 * probe is wired (the dep is injectable for exactly that reason); `startBuild`
 * is A4's host seam — until the build host is wired in, the receipt says the
 * command that starts the index instead of pretending a build started.
 */

import { Box } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalibrationStep,
  DownloadStep,
  FinishStep,
  InfoFrame,
  InfoLine,
  MaskedTextStep,
} from "@/cli/components/EmbeddingWizardFrames";
import {
  cursorIndexFor,
  PickerStep,
  TextStep,
} from "@/cli/components/ScheduleWizardSteps";
import {
  type EmbeddingWizardStateReader,
  resolveEmbeddingWizardApiKey,
  runEmbeddingWizardCalibration,
  runEmbeddingWizardDownload,
  runEmbeddingWizardEndpointTest,
  runEmbeddingWizardFinish,
  runEmbeddingWizardInstallCheck,
} from "@/cli/helpers/embedding-wizard-actions";
import { createEmbeddingWizardDefaultDeps } from "@/cli/helpers/embedding-wizard-defaults";
import {
  EMBEDDING_WIZARD_COMMAND,
  EMBEDDING_WIZARD_STEP_COUNT,
  embeddingWizardGpuRoleOptions,
  embeddingWizardModelOption,
  embeddingWizardModelOptions,
  embeddingWizardStepTitle,
  formatEmbeddingWizardBytes,
} from "@/cli/helpers/embedding-wizard-facts";
import {
  applyEmbeddingWizardEvent,
  builtinInstalled,
  createEmbeddingWizardState,
  type EmbeddingWizardDeps,
  type EmbeddingWizardEvent,
  type EmbeddingWizardState,
  embeddingWizardEndpointNeedsKey,
  isEmbeddingWizardBusy,
} from "@/cli/helpers/embedding-wizard-state";
import { type KeyBinding, namedKeyChords } from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import type { SingleSelectItem } from "@/cli/overlay/adapters";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { wizardBindings } from "@/cli/overlay/wizard";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";

const COMMAND = EMBEDDING_WIZARD_COMMAND;
const KEY_OWNER = "embedding-wizard";

/** Step 4's fixed rows: keep switch, incremental, full, and the action row. */
const FINISH_ITEM_COUNT = 4;

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

  // Step 4's list cursor lives here, not in the machine: it is navigation, not
  // an answer, and only the machine's state is ever written to settings.
  const [finishCursor, setFinishCursor] = useState(0);
  const finishCursorRef = useRef(0);
  const moveFinishCursor = useCallback((delta: number) => {
    const next = Math.min(
      FINISH_ITEM_COUNT - 1,
      Math.max(0, finishCursorRef.current + delta),
    );
    finishCursorRef.current = next;
    setFinishCursor(next);
  }, []);

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

  // Step 2 asks C4/C2 whether both installs are already on disk before it ever
  // offers a download; the answer decides "download screen" vs "calibration".
  useEffect(() => {
    if (state.step !== "builtin-check") return;
    if (state.builtin.installCheck.phase !== "idle") return;
    runAction((current, listener) =>
      runEmbeddingWizardInstallCheck(
        current,
        depsRef.current,
        listener,
        stateReader,
      ),
    );
  }, [state.step, state.builtin.installCheck.phase, runAction, stateReader]);

  // Entering step 4 starts the list cursor on the first option row.
  useEffect(() => {
    if (state.step !== "finish") return;
    finishCursorRef.current = 0;
    setFinishCursor(0);
  }, [state.step]);

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
    state.step === "gpu-role" ||
    state.step === "builtin-model" ||
    state.step === "builtin-download" ||
    state.step === "endpoint-kind";

  // Step 4's rows: two checkbox options, two mutually exclusive build modes and
  // the action row at the bottom. Only "Start build" runs the one write path.
  const finishItems: OverlayListItem[] = [
    {
      key: "keep",
      label: `[${state.finish.keepAfterExit ? "x" : " "}] Keep building after you exit`,
      description: state.finish.keepAfterExit
        ? "runs detached; survives exit"
        : "off (default); stops on exit",
    },
    {
      key: "mode-incremental",
      label: `[${state.finish.buildMode === "incremental" ? "x" : " "}] Build mode: incremental`,
      description: "new/changed chunks only (default)",
    },
    {
      key: "mode-full",
      label: `[${state.finish.buildMode === "full" ? "x" : " "}] Build mode: full`,
      description: "rebuild every chunk",
    },
    {
      key: "start",
      label: "Start build",
      description: "save once, then start the index build",
    },
  ];

  /** What Space/Enter does on the row under the step-4 cursor. */
  const activateFinishRow = (): "consumed" | "declined" => {
    const current = stateRef.current;
    if (isEmbeddingWizardBusy(current)) return "declined";
    const key = finishItems[finishCursorRef.current]?.key;
    if (key === "start") {
      startFinish();
      return "consumed";
    }
    if (key === "keep") dispatch({ type: "toggle-keep-after-exit" });
    else if (key === "mode-incremental") {
      dispatch({ type: "choose-build-mode", mode: "incremental" });
    } else if (key === "mode-full") {
      dispatch({ type: "choose-build-mode", mode: "full" });
    }
    return "consumed";
  };

  const extraBindings: KeyBinding[] = [];
  if (state.step === "builtin-check") {
    extraBindings.push({
      id: "embedding-wizard.install-check-retry",
      chords: namedKeyChords("return"),
      run: () => {
        const current = stateRef.current;
        if (isEmbeddingWizardBusy(current)) return "declined";
        const check = current.builtin.installCheck;
        if (
          check.phase === "failed" ||
          (check.phase === "done" && builtinInstalled(current))
        ) {
          dispatch({ type: "next" });
          return "consumed";
        }
        return "declined";
      },
    });
  }
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
        id: "embedding-wizard.finish-row-up",
        chords: namedKeyChords("upArrow"),
        run: () => {
          if (isEmbeddingWizardBusy(stateRef.current)) return "declined";
          moveFinishCursor(-1);
          return "consumed";
        },
      },
      {
        id: "embedding-wizard.finish-row-down",
        chords: namedKeyChords("downArrow"),
        run: () => {
          if (isEmbeddingWizardBusy(stateRef.current)) return "declined";
          moveFinishCursor(1);
          return "consumed";
        },
      },
      {
        id: "embedding-wizard.finish-row-space",
        chords: [{ key: "space" }],
        run: () => activateFinishRow(),
      },
      {
        id: "embedding-wizard.finish-row-enter",
        chords: namedKeyChords("return"),
        run: () => activateFinishRow(),
      },
      {
        id: "embedding-wizard.keep-after-exit",
        chords: [{ key: "t" }],
        run: () => {
          if (isEmbeddingWizardBusy(stateRef.current)) return "declined";
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

  // ── Step 2: GPU role ────────────────────────────────────────────────────
  if (state.step === "gpu-role") {
    const items: SingleSelectItem[] = embeddingWizardGpuRoleOptions(
      process.platform,
    ).map((option) => ({
      key: option.role,
      label: option.label,
      description: option.description,
      disabled: option.disabled,
    }));
    return (
      <PickerStep
        key="gpu-role"
        command={COMMAND}
        title={embeddingWizardStepTitle("gpu-role")}
        hint="How the local embedding runtime may use a GPU. Auto probes during calibration; index-only builds the index on the GPU while every query stays on the CPU."
        items={items}
        initialCursorIndex={cursorIndexFor(items, state.gpu)}
        onSelect={(key) =>
          dispatch({
            type: "choose-gpu",
            role: key === "off" || key === "index-only" ? key : "auto",
          })
        }
        onCancel={back}
        footer="Enter select · ↑↓ move · Esc back"
        width={width}
      />
    );
  }

  // ── Step 2: cached-install check (model + runtime) ──────────────────────
  if (state.step === "builtin-check") {
    const check = state.builtin.installCheck;
    const model = embeddingWizardModelOption(state.builtin.modelId);
    return (
      <InfoFrame
        key="builtin-check"
        title={embeddingWizardStepTitle("builtin-check")}
        footer={
          check.phase === "failed"
            ? "Enter retry · Esc back · ctrl+c cancel"
            : "Esc back · ctrl+c cancel"
        }
        width={width}
      >
        <InfoLine
          text={`Model: ${model?.displayName ?? state.builtin.modelId}`}
          width={width}
        />
        {check.phase === "idle" || check.phase === "checking" ? (
          <InfoLine
            text="Checking the model cache and the embedding runtime…"
            width={width}
          />
        ) : null}
        {check.phase === "failed" ? (
          <>
            <InfoLine
              text={`Install check failed: ${check.error ?? "unknown error"}`}
              tone="error"
              width={width}
            />
            <InfoLine
              text="The check only reads the cache; nothing was written. Enter retries, Esc goes back."
              tone="dim"
              width={width}
            />
          </>
        ) : null}
        {check.phase === "done" ? (
          <>
            <InfoLine
              text={
                check.modelInstalled
                  ? `Model: cached at ${check.modelDir ?? "the model cache"}`
                  : "Model: not installed"
              }
              width={width}
            />
            <InfoLine
              text={
                check.runtimeInstalled
                  ? `Runtime: cached at ${check.runtimeDir ?? "the runtime cache"}`
                  : "Runtime: not installed"
              }
              width={width}
            />
            {builtinInstalled(state) ? (
              <InfoLine
                text="Both installs were found; Enter continues to calibration without downloading anything."
                tone="dim"
                width={width}
              />
            ) : null}
          </>
        ) : null}
      </InfoFrame>
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

  // ── Step 2a: download confirmation (runtime + model) ────────────────────
  if (state.step === "builtin-download") {
    return (
      <DownloadStep
        key="builtin-download"
        state={state}
        busy={busy}
        onSelect={(key) => {
          if (key === "download") {
            startDownload();
            return;
          }
          back();
        }}
        onCancel={back}
        width={width}
      />
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
    return (
      <CalibrationStep
        key="calibrate"
        state={state}
        footer={
          calibration.phase === "running"
            ? "s skip · Esc waits for the measurement"
            : calibration.phase === "failed"
              ? "Enter continue · r retry · s skip · Esc back"
              : "Enter continue · s skip · Esc back"
        }
        width={width}
      />
    );
  }

  // ── Step 4: finish ──────────────────────────────────────────────────────
  return (
    <FinishStep
      key="finish"
      state={state}
      items={finishItems}
      cursor={finishCursor}
      footer={
        state.finish.phase === "saving"
          ? "Saving settings and starting the build…"
          : "↑↓ move · Space/Enter toggle · Enter on Start build · t keep-after-exit · Esc back"
      }
      width={width}
    />
  );
}

/** Exported for the frame test: the number of numbered questions. */
export function embeddingWizardStepCount(): number {
  return EMBEDDING_WIZARD_STEP_COUNT;
}
