/**
 * The `/recall embedding` spelling table (48-4 D-07…D-13, D-16).
 *
 * Split out of `embedding.ts` when the surface was rewritten: the parser, the
 * usage copy and the key table are one unit, and the handler/actions were over
 * the 1,000-line ceiling once `connect`, `model`, `config` and `device` landed.
 * Nothing here touches settings, a runtime or a file, so the whole vocabulary is
 * testable without a store.
 */

import type { EmbeddingSettingsPatch } from "@/cli/app/pages/settings/embedding-settings";
import type { EmbeddingBuildMode } from "@/types/embedding-protocol";

/** The usage table. Kept beside the parser so a new spelling updates both. */
export const EMBEDDING_COMMAND_USAGE = [
  "/recall embedding [command]",
  "",
  "Vector recall embeds the parts of earlier conversations and memory files",
  "that passive recall may inject, and searches them by meaning instead of",
  "words alone. It is off by default; the first enable needs a connect step.",
  "",
  "USAGE",
  "  /recall embedding                  what vector recall is doing right now",
  "  /recall embedding status           same, spelled out",
  "  /recall embedding on               enable; unconfigured opens connect",
  "  /recall embedding off              disable; stored vectors stay on disk",
  "  /recall embedding connect          connect a vector source (model/endpoint)",
  "  /recall embedding model            choose a stored model (TUI picker)",
  "  /recall embedding build [--full]   build or refresh the vector index",
  "  /recall embedding build --cancel   stop the running build",
  "  /recall embedding reset            preview deleting stored vectors",
  "  /recall embedding reset --confirm  delete the active space's vectors",
  "  /recall embedding config           list the build keys and their values",
  "  /recall embedding config <key> <value>",
  "  /recall embedding device [--test]  show (or measure) the build device",
  "",
  "CONFIG KEYS",
  "  chunk-target <tokens>   target chunk window (creates a new space)",
  "  chunk-max <tokens>      hard chunk ceiling (creates a new space)",
  "  chunk-overlap <tokens>  chunk overlap (creates a new space)",
  "  max-chunks <n>          chunks embedded per message (creates a new space)",
  "  threads <n>             encode/build threads (0 = automatic)",
  "  gpu auto|off            try the GPU for index builds (Windows only)",
  "",
  "WITHOUT A TUI",
  "  haruyuki recall embedding status",
  "  haruyuki recall embedding model --json",
  "  haruyuki recall embedding model --select <n>",
  "  haruyuki recall embedding model --delete <n> --confirm",
  "  haruyuki recall embedding reset --confirm",
  "  haruyuki --recall-embedding on --recall-embedding-backend builtin",
].join("\n");

/** Every key `/recall embedding config` accepts (48-4 D-16). */
export type EmbeddingConfigKey =
  | "chunk-target"
  | "chunk-max"
  | "chunk-overlap"
  | "max-chunks"
  | "threads"
  | "gpu";

/**
 * Every key `/recall embedding config` accepts (48-4 D-16).
 *
 * Exported because completion renders these keys as the `config` row's
 * children, and the status table iterates them: one list, so the popup cannot
 * offer a key the parser refuses (or the reverse).
 */
export const EMBEDDING_CONFIG_KEYS: readonly EmbeddingConfigKey[] = [
  "chunk-target",
  "chunk-max",
  "chunk-overlap",
  "max-chunks",
  "threads",
  "gpu",
];

function isEmbeddingConfigKey(
  value: string | undefined,
): value is EmbeddingConfigKey {
  return (
    value !== undefined &&
    (EMBEDDING_CONFIG_KEYS as readonly string[]).includes(value)
  );
}

/** Every setting changes a stored key; the writer validates before any write. */
const EMBEDDING_KNOB_LABEL: Readonly<Record<string, string>> = {
  "chunk-target": "chunk target",
  "chunk-max": "chunk ceiling",
  "chunk-overlap": "chunk overlap",
  "max-chunks": "chunks per message cap",
  threads: "threads",
  gpu: "GPU role",
};

/** One parsed `/recall embedding` invocation. */
export type EmbeddingCommand =
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" }
  /** Add/connect a vector source (the old `setup`, 48-4 D-07). */
  | { kind: "connect" }
  /** Model picker / non-interactive model operations (48-4 D-09). */
  | {
      kind: "model";
      action: "list" | "select" | "delete" | "pin" | "unpin";
      index?: number;
      json: boolean;
      confirmed: boolean;
    }
  /** Device facts, or a read-only measurement with `test`. */
  | { kind: "device"; test: boolean }
  /**
   * Delete stored vectors (`current`/`all`/one model). A bare reset is a
   * preview; the delete itself always needs `--confirm`.
   */
  | {
      kind: "reset";
      scope: "current" | "all" | "model";
      model?: string;
      confirmed: boolean;
    }
  | {
      kind: "build";
      mode: EmbeddingBuildMode;
      keepAfterExit: boolean;
      cancel: boolean;
    }
  /** `/recall embedding config` with no key, or one key to print. */
  | { kind: "config"; key?: EmbeddingConfigKey }
  | { kind: "set"; label: string; updates: EmbeddingSettingsPatch }
  | { kind: "usage" }
  | { kind: "error"; message: string };

export function parseEmbeddingCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** A ratio in `[0, 1]`; above 1 is refused rather than clamped. */
export function parseEmbeddingRatio(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function error(message: string): EmbeddingCommand {
  return { kind: "error", message };
}

/**
 * Parse `build`'s flags: `--full` rebuilds every chunk, `--keep-after-exit`
 * opts into a detached child (48-1 R-34's only exception to "the build dies with
 * its host"), `--cancel` stops the running build (48-4 D-13). An unknown word is
 * refused rather than ignored.
 */
function parseBuild(rest: string[]): EmbeddingCommand {
  let full = false;
  let keepAfterExit = false;
  let cancel = false;
  for (const word of rest) {
    if (word === "--full") {
      full = true;
      continue;
    }
    if (word === "--keep-after-exit") {
      keepAfterExit = true;
      continue;
    }
    if (word === "--cancel") {
      cancel = true;
      continue;
    }
    return error(
      "`/recall embedding build` takes --full, --keep-after-exit or --cancel.",
    );
  }
  if (cancel && (full || keepAfterExit)) {
    return error(
      "`/recall embedding build --cancel` cannot be combined with --full or --keep-after-exit.",
    );
  }
  return {
    kind: "build",
    mode: full ? "full" : "incremental",
    keepAfterExit,
    cancel,
  };
}

type ModelAction = "list" | "select" | "delete" | "pin" | "unpin";
const MODEL_ACTIONS: readonly ModelAction[] = [
  "select",
  "delete",
  "pin",
  "unpin",
];

/**
 * Parse `model` (48-4 D-09): the TUI turns a bare invocation into a picker; the
 * CLI uses the flags. `--delete` still needs `--confirm`, matching every other
 * destructive command in this repo.
 */
function parseModel(rest: string[]): EmbeddingCommand {
  let action: ModelAction = "list";
  let index: number | undefined;
  let json = false;
  let confirmed = false;
  for (let cursor = 0; cursor < rest.length; cursor += 1) {
    const word = rest[cursor];
    if (word === "--json") {
      json = true;
      continue;
    }
    if (word === "--confirm") {
      confirmed = true;
      continue;
    }
    const name = word?.startsWith("--") ? word.slice(2) : undefined;
    if (
      name !== undefined &&
      (MODEL_ACTIONS as readonly string[]).includes(name)
    ) {
      if (action !== "list") {
        return error(
          "`/recall embedding model` takes one of --select, --delete, --pin or --unpin.",
        );
      }
      const value = parseEmbeddingCount(rest[cursor + 1]);
      if (value === null || value < 1) {
        return error(
          `\`/recall embedding model ${word}\` needs a model number: ${word} 1.`,
        );
      }
      action = name as ModelAction;
      index = value;
      cursor += 1;
      continue;
    }
    return error(`\`/recall embedding model\` does not take "${word}".`);
  }
  return {
    kind: "model",
    action,
    ...(index === undefined ? {} : { index }),
    json,
    confirmed,
  };
}

/** `/recall embedding config …`: no key lists, one key prints, two set. */
function parseEmbeddingConfig(rest: string[]): EmbeddingCommand {
  const [key, ...values] = rest;
  if (key === undefined) return { kind: "config" };
  if (!isEmbeddingConfigKey(key)) {
    return error(
      `Unknown embedding config key: ${key}. Keys: ${EMBEDDING_CONFIG_KEYS.join(", ")}.`,
    );
  }
  if (values.length === 0) return { kind: "config", key };
  if (values.length > 1) {
    return error(`\`/recall embedding config ${key}\` takes one value.`);
  }
  const value = values[0] ?? "";
  if (key === "gpu") {
    if (value !== "auto" && value !== "off") {
      return error("`/recall embedding config gpu` needs one of: auto, off.");
    }
    return {
      kind: "set",
      label: EMBEDDING_KNOB_LABEL.gpu ?? "GPU role",
      updates: { gpu: value },
    };
  }
  const count = parseEmbeddingCount(value);
  if (count === null) {
    return error(
      `\`/recall embedding config ${key}\` needs a whole number: /recall embedding config ${key} <n>.`,
    );
  }
  const label = EMBEDDING_KNOB_LABEL[key] ?? key;
  switch (key) {
    case "chunk-target":
      return { kind: "set", label, updates: { chunkTarget: count } };
    case "chunk-max":
      return { kind: "set", label, updates: { chunkMax: count } };
    case "chunk-overlap":
      return { kind: "set", label, updates: { chunkOverlap: count } };
    case "max-chunks":
      return { kind: "set", label, updates: { maxChunksPerMessage: count } };
    case "threads":
      return { kind: "set", label, updates: { threads: count } };
  }
}

/**
 * Parse `reset` (48-4 D-07, restored as an explicit lifecycle entry): the bare
 * form previews, `--confirm` deletes. `--all` and `--model <id>` choose the
 * target; they are mutually exclusive with each other and with the default.
 */
function parseReset(rest: string[]): EmbeddingCommand {
  let scope: "current" | "all" | "model" = "current";
  let model: string | undefined;
  let confirmed = false;
  for (let cursor = 0; cursor < rest.length; cursor += 1) {
    const word = rest[cursor];
    if (word === "--confirm") {
      confirmed = true;
      continue;
    }
    if (word === "--all") {
      if (scope !== "current") {
        return error(
          "`/recall embedding reset` takes one of --all or --model.",
        );
      }
      scope = "all";
      continue;
    }
    if (word === "--model") {
      if (scope !== "current") {
        return error(
          "`/recall embedding reset` takes one of --all or --model.",
        );
      }
      const value = rest[cursor + 1];
      if (value === undefined || value.startsWith("--")) {
        return error(
          "`/recall embedding reset --model` needs a model id: --model bge-m3.",
        );
      }
      scope = "model";
      model = value;
      cursor += 1;
      continue;
    }
    return error(`\`/recall embedding reset\` does not take "${word}".`);
  }
  return {
    kind: "reset",
    scope,
    ...(model === undefined ? {} : { model }),
    confirmed,
  };
}

/**
 * Parse the words after `/recall embedding`.
 *
 * A bare invocation answers the status, because opening an overlay is the TUI
 * submit layer's job (D5/D6) and every other channel can only print. Every
 * spelling the completion table offers has a branch here; the drift test in
 * `embedding.test.ts` walks the table and feeds each row through this function.
 */
export function parseEmbeddingCommand(args: string[]): EmbeddingCommand {
  const [head, ...rest] = args;
  if (head === undefined) return { kind: "status" };
  if (head === "help" || head === "--help" || head === "-h") {
    if (rest.length > 0)
      return error("`/recall embedding help` takes no arguments.");
    return { kind: "usage" };
  }

  switch (head) {
    case "status":
      return rest.length === 0
        ? { kind: "status" }
        : error("`/recall embedding status` takes no arguments.");
    case "on":
      return rest.length === 0
        ? { kind: "on" }
        : error("`/recall embedding on` takes no arguments.");
    case "off":
      return rest.length === 0
        ? { kind: "off" }
        : error("`/recall embedding off` takes no arguments.");
    case "connect":
      return rest.length === 0
        ? { kind: "connect" }
        : error("`/recall embedding connect` takes no arguments.");
    case "model":
      return parseModel(rest);
    case "device": {
      if (rest.length === 0) return { kind: "device", test: false };
      if (rest.length === 1 && rest[0] === "--test") {
        return { kind: "device", test: true };
      }
      return error("`/recall embedding device` takes at most --test.");
    }
    case "build":
      return parseBuild(rest);
    case "reset":
      return parseReset(rest);
    case "config":
      return parseEmbeddingConfig(rest);
    default:
      return error(`Unknown embedding command: ${head}.`);
  }
}
