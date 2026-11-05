/**
 * The wizard's presentational pieces (48-2 §4.9 D5).
 *
 * `InfoFrame`/`InfoLine` are the shared chrome for the result screens, and
 * `MaskedTextStep` is the one text screen that is not `ScheduleWizardSteps`'
 * `TextStep`: the endpoint key field must paint mask characters while the editor
 * keeps the real value.
 *
 * The three screens that grew past a few lines — the download confirmation, the
 * calibration result and the step-4 recap — live here so `EmbeddingWizard.tsx`
 * stays a view over the state machine rather than a second state machine of its
 * own. Nothing here holds state: a screen draws the state it is handed and
 * reports through the callbacks its caller passes.
 */

import { Box } from "ink";
import type { ReactNode } from "react";
import { colors } from "@/cli/components/colors";
import { StepHint } from "@/cli/components/ScheduleWizardSteps";
import { Text } from "@/cli/components/Text";
import {
  embeddingWizardCalibrationLatencyLine,
  embeddingWizardCalibrationMeasured,
  embeddingWizardCalibrationSummary,
  embeddingWizardSettingsPatch,
} from "@/cli/helpers/embedding-wizard-actions";
import {
  EMBEDDING_WIZARD_COMMAND,
  EMBEDDING_WIZARD_RUNTIME_BYTES,
  embeddingWizardDownloadSourcesLine,
  embeddingWizardGpuMismatch,
  embeddingWizardGpuRoleLabel,
  embeddingWizardModelOption,
  embeddingWizardStepTitle,
  formatEmbeddingWizardBytes,
} from "@/cli/helpers/embedding-wizard-facts";
import {
  builtinInstalled,
  type EmbeddingWizardState,
} from "@/cli/helpers/embedding-wizard-state";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
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

// ── Step 2: download confirmation ──────────────────────────────────────────

/** The confirmation screen: both sizes, the licence, and the two choices. */
export function DownloadStep({
  state,
  busy,
  onSelect,
  onCancel,
  width,
}: {
  state: EmbeddingWizardState;
  busy: boolean;
  onSelect: (key: string) => void;
  onCancel: () => void;
  width: number;
}) {
  const option = embeddingWizardModelOption(state.builtin.modelId);
  const download = state.builtin.download;
  const items: SingleSelectItem[] = [
    {
      key: "download",
      label: download.phase === "failed" ? "Retry download" : "Download now",
      description:
        "Installs the runtime, then the model files; every file is verified",
    },
    {
      key: "back",
      label: "Back",
      description: "Choose a different model or backend",
    },
  ];
  return (
    <OverlayFrame
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
            {download.modelDone ? (
              <InfoLine
                text={`Model: already installed at ${download.modelDir ?? "the model cache"}; nothing to download`}
                tone="dim"
                width={width}
              />
            ) : (
              <InfoLine
                text={`Model download: ~${formatEmbeddingWizardBytes(option.totalBytes)} (one-time)`}
                width={width}
              />
            )}
            {download.runtimeDone ? (
              <InfoLine
                text={`Runtime: already installed at ${download.runtimeDir ?? "the runtime cache"}; nothing to download`}
                tone="dim"
                width={width}
              />
            ) : (
              <InfoLine
                text={`Runtime download: ~${formatEmbeddingWizardBytes(EMBEDDING_WIZARD_RUNTIME_BYTES)} (onnxruntime closure, one-time)`}
                width={width}
              />
            )}
            <InfoLine
              text={`License: ${option.licenseName} (${option.licenseId})`}
              width={width}
            />
            <InfoLine text={`Terms: ${option.licenseNotice}`} width={width} />
            <InfoLine
              text={
                option.integrityPinned
                  ? "Integrity: every required file is sha256-pinned"
                  : "Integrity: some required files are verified by size only (sha256 not recorded)"
              }
              tone={option.integrityPinned ? "normal" : "dim"}
              width={width}
            />
            <InfoLine
              text={embeddingWizardDownloadSourcesLine()}
              tone="dim"
              width={width}
            />
            <InfoLine
              text={`More: ${option.licenseUrl}`}
              tone="dim"
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
            if (busy) return;
            onSelect(key);
          }}
          onCancel={onCancel}
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

// ── Step 3: calibration ────────────────────────────────────────────────────

/** The bounded measurement, its GPU role, and "not measured" when it failed. */
export function CalibrationStep({
  state,
  footer,
  width,
}: {
  state: EmbeddingWizardState;
  footer: string;
  width: number;
}) {
  const calibration = state.calibration;
  const result = calibration.result;
  const measured = embeddingWizardCalibrationMeasured(result);
  const cached = state.backend === "builtin" && builtinInstalled(state);
  const modelDir =
    state.builtin.installCheck.modelDir ?? state.builtin.download.modelDir;
  const runtimeDir =
    state.builtin.installCheck.runtimeDir ?? state.builtin.download.runtimeDir;
  const mismatch = embeddingWizardGpuMismatch(result, state.gpu);
  return (
    <InfoFrame
      title={embeddingWizardStepTitle("calibrate")}
      footer={footer}
      width={width}
    >
      {cached ? (
        <InfoLine
          text={`Model and runtime already installed (${modelDir ?? "model cache"} / ${runtimeDir ?? "runtime cache"}); using the cached copies — no download.`}
          tone="dim"
          width={width}
        />
      ) : null}
      <InfoLine
        text={`GPU: ${embeddingWizardGpuRoleLabel(state.gpu)}`}
        width={width}
      />
      <InfoLine text={`Precision: ${state.precision}`} width={width} />
      {mismatch === null ? null : (
        <InfoLine text={mismatch} tone="dim" width={width} />
      )}
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
            text={embeddingWizardCalibrationLatencyLine(result)}
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
      {calibration.phase === "done" && !measured ? (
        <InfoLine
          text="No measurement was produced, so the documented default budget is used; the values above are not measurements."
          tone="dim"
          width={width}
        />
      ) : null}
    </InfoFrame>
  );
}

// ── Step 4: finish ─────────────────────────────────────────────────────────

/** The recap plus the selectable option rows and the build action row. */
export function FinishStep({
  state,
  items,
  cursor,
  footer,
  width,
}: {
  state: EmbeddingWizardState;
  items: readonly OverlayListItem[];
  cursor: number;
  footer: string;
  width: number;
}) {
  const option = embeddingWizardModelOption(state.builtin.modelId);
  const finish = state.finish;
  const patchPreview = embeddingWizardSettingsPatch(state);
  const backendLine =
    state.backend === "endpoint"
      ? `Backend: endpoint · ${state.endpoint.kind} · ${state.endpoint.verified?.baseUrl ?? state.endpoint.baseUrl} · ${state.endpoint.verified?.model ?? state.endpoint.model}`
      : `Backend: built-in · ${option?.displayName ?? state.builtin.modelId}`;
  const cached =
    state.backend === "builtin" &&
    state.builtin.installCheck.modelInstalled &&
    state.builtin.installCheck.runtimeInstalled;
  const mismatch = embeddingWizardGpuMismatch(
    state.calibration.result,
    state.gpu,
  );
  return (
    <InfoFrame
      title={embeddingWizardStepTitle("finish")}
      footer={footer}
      width={width}
    >
      <InfoLine text={backendLine} width={width} />
      <InfoLine
        text={embeddingWizardCalibrationSummary(state.calibration.result)}
        width={width}
      />
      <InfoLine
        text={`GPU: ${embeddingWizardGpuRoleLabel(state.gpu)}`}
        width={width}
      />
      <InfoLine text={`Precision: ${state.precision}`} width={width} />
      {mismatch === null ? null : (
        <InfoLine text={mismatch} tone="dim" width={width} />
      )}
      {cached ? (
        <InfoLine
          text="Model and runtime already installed; the build uses the cached copies."
          tone="dim"
          width={width}
        />
      ) : null}
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
      <OverlayListView items={[...items]} cursor={cursor} />
      <Box height={1} />
      <InfoLine
        text={`[x] = chosen · [ ] = off · ↑↓ move · Space/Enter toggle · Enter on "Start build" runs it`}
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
