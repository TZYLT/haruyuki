/**
 * The setup wizard's pure facts (48-2 §4.9 D5): the step table, the built-in
 * model facts, the GPU-role options and platform gate, and the endpoint
 * URL/key-variable validation. Pure values only — no state machine, no I/O —
 * so the reducer can depend on it without a cycle.
 */

import { normalizeEndpointBaseUrl } from "@/backend/local/embedding/endpoint-client";
import {
  BUILTIN_EMBEDDING_MODELS,
  type EmbeddingModelManifest,
} from "@/backend/local/embedding/model-manifest";
import type { EmbeddingGpuRole } from "@/types/embedding-protocol";
import { getErrorMessage } from "@/utils/error";

// ── Steps and titles ───────────────────────────────────────────────────────

/** One screen of the wizard; sub-steps share their numbered step's slot. */
export type EmbeddingWizardStep =
  | "backend"
  | "gpu-role"
  | "precision"
  | "builtin-model"
  | "builtin-check"
  | "builtin-download"
  | "endpoint-kind"
  | "endpoint-url"
  | "endpoint-model"
  | "endpoint-key-env"
  | "endpoint-key"
  | "endpoint-test"
  | "calibrate"
  | "finish";

/** The requirement's four numbered steps (48-1 §7.2). */
export const EMBEDDING_WIZARD_STEP_COUNT = 4;

/** The command whose overlay frame names the wizard; the TUI seam reuses it. */
export const EMBEDDING_WIZARD_COMMAND = "/recall embedding connect";

/** Every screen with the slot it is numbered by (labels differ per sub-step). */
export const EMBEDDING_WIZARD_STEPS: readonly {
  readonly id: EmbeddingWizardStep;
  readonly slot: number;
  readonly label: string;
}[] = [
  { id: "backend", slot: 1, label: "Backend" },
  { id: "gpu-role", slot: 2, label: "GPU" },
  { id: "precision", slot: 2, label: "Precision" },
  { id: "builtin-model", slot: 2, label: "Built-in model" },
  { id: "builtin-check", slot: 2, label: "Model check" },
  { id: "builtin-download", slot: 2, label: "Download" },
  { id: "endpoint-kind", slot: 2, label: "Endpoint" },
  { id: "endpoint-url", slot: 2, label: "Endpoint URL" },
  { id: "endpoint-model", slot: 2, label: "Endpoint model" },
  { id: "endpoint-key-env", slot: 2, label: "Endpoint key" },
  { id: "endpoint-key", slot: 2, label: "Endpoint key" },
  { id: "endpoint-test", slot: 2, label: "Endpoint test" },
  { id: "calibrate", slot: 3, label: "Calibration" },
  { id: "finish", slot: 4, label: "Finish" },
];

/** `3/4 Calibration` — the title line for a screen. */
export function embeddingWizardStepTitle(step: EmbeddingWizardStep): string {
  const entry = EMBEDDING_WIZARD_STEPS.find(
    (candidate) => candidate.id === step,
  );
  if (entry === undefined) return "";
  return `${entry.slot}/${EMBEDDING_WIZARD_STEP_COUNT} ${entry.label}`;
}

// ── Built-in model facts ───────────────────────────────────────────────────

/** What the download confirmation paints for one built-in model. */
export interface EmbeddingWizardModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly dimensions: number;
  /** Sum of the required files' pinned sizes, or `0` when none are pinned. */
  readonly totalBytes: number;
  readonly licenseId: string;
  readonly licenseName: string;
  readonly licenseNotice: string;
  readonly licenseUrl: string;
  /** False means "some required files are verified by size only". */
  readonly integrityPinned: boolean;
}

function modelOption(
  manifest: EmbeddingModelManifest,
): EmbeddingWizardModelOption {
  const totalBytes = manifest.files.reduce(
    (sum, file) => sum + (file.bytes ?? 0),
    0,
  );
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    dimensions: manifest.dimensions,
    totalBytes,
    licenseId: manifest.license.id,
    licenseName: manifest.license.name,
    licenseNotice: manifest.license.notice,
    licenseUrl: manifest.license.url,
    integrityPinned: manifest.integrityPinned,
  };
}

/** The built-in models this build can download (C4's append-only table). */
export function embeddingWizardModelOptions(): EmbeddingWizardModelOption[] {
  return BUILTIN_EMBEDDING_MODELS.map(modelOption);
}

/** One model's facts, or `undefined` when the id is not a built-in. */
export function embeddingWizardModelOption(
  modelId: string,
): EmbeddingWizardModelOption | undefined {
  return embeddingWizardModelOptions().find((option) => option.id === modelId);
}

/** `24.5 MB` — decimal units, the way weight sizes are quoted. */
export function formatEmbeddingWizardBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  const rounded =
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Rough download size of the pinned onnxruntime-node closure (48-2 §4.4). */
export const EMBEDDING_WIZARD_RUNTIME_BYTES = 115_000_000;

/** Where the two downloads come from, for the confirmation screen. */
export function embeddingWizardDownloadSourcesLine(): string {
  return "Sources: model via hf-mirror → Hugging Face → ModelScope; runtime via npmmirror → npmjs.";
}

// ── GPU facts ──────────────────────────────────────────────────────────────

/** One row of the GPU-role picker, in the order step 2 lists them. */
export interface EmbeddingWizardGpuRoleOption {
  readonly role: EmbeddingGpuRole;
  readonly label: string;
  readonly description: string;
  /** True on the platform where the row exists but cannot be chosen. */
  readonly disabled: boolean;
}

/** One row of the precision picker (48-4 D-14). */
export interface EmbeddingWizardPrecisionOption {
  readonly id: "float32" | "int8";
  readonly label: string;
  readonly description: string;
}

/** Storage precision choices; int8 is the same space only after a build. */
export function embeddingWizardPrecisionOptions(): EmbeddingWizardPrecisionOption[] {
  return [
    {
      id: "float32",
      label: "float32",
      description: "full precision; about 4 bytes per dimension",
    },
    {
      id: "int8",
      label: "int8",
      description:
        "a quarter of the size with negligible recall loss; a different space, so it builds once",
    },
  ];
}

/**
 * The two roles the UI offers (48-4 D-01). `index-only` was the same behaviour
 * as `auto` in every code path, so it is no longer a choice; an old stored
 * value is read as `auto` by the settings resolver.
 */
export function embeddingWizardGpuRoleOptions(
  _platform: NodeJS.Platform = process.platform,
): EmbeddingWizardGpuRoleOption[] {
  return [
    {
      role: "auto",
      label: "Auto (default)",
      description:
        "Probe for a GPU during calibration; use the CPU when it is unavailable",
      disabled: false,
    },
    {
      role: "off",
      label: "CPU only",
      description:
        "Never use a GPU; the index build and every query run on the CPU",
      disabled: false,
    },
  ];
}

/** One-line summary of a GPU role, used by the step-4 recap. */
export function embeddingWizardGpuRoleLabel(role: EmbeddingGpuRole): string {
  if (role === "off") return "off (CPU only)";
  return "auto (probed during calibration; CPU fallback)";
}

/**
 * The honest mismatch notice when a measured calibration used a different GPU
 * role than the one the user just chose. `null` when they agree or when the
 * result was never measured (a defaults-based result says nothing about the
 * hardware at all).
 */
export function embeddingWizardGpuMismatch(
  measured: {
    readonly calibrated: boolean;
    readonly gpuRole: EmbeddingGpuRole;
  } | null,
  selected: EmbeddingGpuRole,
): string | null {
  if (measured === null || !measured.calibrated) return null;
  if (measured.gpuRole === selected) return null;
  return `Calibration measured with GPU role "${measured.gpuRole}", but the wizard is set to "${selected}"; the measurement does not reflect the new setting.`;
}

// ── Endpoint validation and key resolution ─────────────────────────────────

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate and normalise the endpoint base URL through C6's allow-list, so the
 * wizard, the settings page and the runtime cannot disagree about what a legal
 * endpoint is.
 */
export function validateEmbeddingWizardEndpointUrl(raw: string): {
  url: string | null;
  error: string | null;
} {
  try {
    return { url: normalizeEndpointBaseUrl(raw), error: null };
  } catch (error) {
    return { url: null, error: getErrorMessage(error) };
  }
}

/** How the wizard resolves the endpoint credential, and what the UI may say. */
export interface EmbeddingWizardApiKeyResolution {
  apiKey: string | null;
  source: "env" | "typed" | "none";
  /** User-facing text; never contains the key itself. */
  error: string | null;
}

/** The two endpoint fields the key resolution reads (and nothing else). */
export interface EmbeddingWizardApiKeyInput {
  readonly apiKeyEnv: string;
  readonly apiKey: string;
}

/**
 * Resolve the key from the named environment variable, else from the masked
 * field. The returned error is safe to paint: it names the variable, never the
 * value. Exported because the test-embed and finish runners — and the frame —
 * must all agree on what key the wizard is about to use.
 */
export function resolveEmbeddingWizardApiKeyFrom(
  input: EmbeddingWizardApiKeyInput,
  readEnv: (name: string) => string | undefined = (name) => process.env[name],
): EmbeddingWizardApiKeyResolution {
  const envName = input.apiKeyEnv.trim();
  const typed = input.apiKey.trim();
  if (envName.length > 0) {
    if (!ENV_NAME_PATTERN.test(envName)) {
      return {
        apiKey: null,
        source: "env",
        error: `"${envName}" is not an environment variable name.`,
      };
    }
    const value = readEnv(envName)?.trim();
    if (value === undefined || value === "") {
      return {
        apiKey: null,
        source: "env",
        error: `Environment variable ${envName} is empty or unset; set it before testing the endpoint.`,
      };
    }
    return { apiKey: value, source: "env", error: null };
  }
  if (typed.length > 0) return { apiKey: typed, source: "typed", error: null };
  return { apiKey: null, source: "none", error: null };
}

/** Whether an environment-variable name is syntactically usable. */
export function isEmbeddingWizardEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}
