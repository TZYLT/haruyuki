#!/usr/bin/env bun
/**
 * verify-prefix-fork.ts — F-03 M0 prefix byte gate (dev-only, not shipped).
 *
 * Answers the one question the whole F-03 route depends on: **does a child turn
 * that runs on a forked conversation send the same prefix bytes as the parent
 * conversation did?** (requirement §8.1 #1, route §4 M0).
 *
 * What it does, end to end, in a throwaway root:
 *   1. starts a local OpenAI-compatible stub provider (no credentials, no
 *      egress) on 127.0.0.1 and points the LM Studio provider slot at it;
 *   2. runs one real headless turn for a new agent/conversation with
 *      `HARUYUKI_PREFIX_PROBE_DIR` set, so the provider payload is captured;
 *   3. forks that conversation through the local backend and runs one more real
 *      headless turn on the fork with `--conv <fork>`;
 *   4. compares the two captured payloads on the four frozen-prefix items:
 *      `system`, `tools`, `model` + model settings, and the message prefix.
 *
 * Usage:
 *   bun scripts/verify-prefix-fork.ts [--mode inherited-history|inherited-context|both]
 *                                    [--keep] [--cli <path-to-src/index.ts>]
 *
 * Exit codes: 0 PASS · 1 DIFF · 2 setup/usage error · 3 PENDING (the mode is
 * not implemented yet — expected for `inherited-context` until the context-mode
 * work item lands).
 *
 * The reference run for the M0 gate is `--mode inherited-history`: the existing
 * full fork is the control that proves the snapshot inheritance path already
 * carries the prefix to the child. `--mode inherited-context` is the F-03 route
 * itself and is expected to report PENDING until then.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalBackend } from "@/backend/local/local-backend";
import { canonicalJson } from "@/backend/local/prefix-freeze";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

type ForkContextMode = "inherited-history" | "inherited-context";

const DEFAULT_MODEL = "lmstudio/verify-fork-model";
const TURN_TIMEOUT_MS = 120_000;

const cliProcesses = new Set<ChildProcessWithoutNullStreams>();

interface CliOptions {
  modes: ForkContextMode[];
  keep: boolean;
  cliEntry: string;
}

function parseArgs(argv: string[]): CliOptions {
  let mode: ForkContextMode | "both" = "inherited-history";
  let keep = false;
  let cliEntry = join(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    "src",
    "index.ts",
  );
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--mode") {
      const value = argv[i + 1];
      if (
        value !== "inherited-history" &&
        value !== "inherited-context" &&
        value !== "both"
      ) {
        throw new Error(`unknown --mode value: ${String(value)}`);
      }
      mode = value;
      i += 1;
    } else if (arg === "--cli") {
      const value = argv[i + 1];
      if (!value) throw new Error("--cli needs a path");
      cliEntry = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return {
    modes:
      mode === "both" ? ["inherited-history", "inherited-context"] : [mode],
    keep,
    cliEntry,
  };
}

// --- stub provider ---------------------------------------------------------

interface StubProvider {
  port: number;
  stop: () => void;
}

/**
 * Minimal OpenAI-compatible endpoint the local backend can complete one turn
 * against. `/api/v0/models` is the LM Studio discovery surface, `/v1/models` is
 * the OpenAI-compatible fallback, and `/v1/chat/completions` returns one plain
 * assistant reply as SSE — no tool calls, so a turn finishes in one request.
 */
function startStubProvider(): StubProvider {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/api/v0/models")) {
        return Response.json({
          data: [
            {
              id: "verify-fork-model",
              type: "llm",
              state: "loaded",
              loaded_context_length: 128000,
              max_context_length: 128000,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "verify-fork-model", object: "model" }],
        });
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      await req.json().catch(() => undefined);
      const base = {
        id: "chatcmpl-verify",
        object: "chat.completion.chunk",
        created: 1,
        model: "verify-fork-model",
      };
      const frames = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "ok" },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      ];
      const body = frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}

// --- one headless turn -----------------------------------------------------

interface TurnResult {
  code: number | null;
  agentId?: string;
  conversationId?: string;
  stdoutTail: string;
  stderrTail: string;
}

function tail(text: string, length = 4_000): string {
  return text.length <= length ? text : text.slice(text.length - length);
}

function runTurn(options: {
  cliEntry: string;
  projectDir: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  conversationId?: string;
  model?: string;
}): Promise<TurnResult> {
  const args = [
    "--loader=.md:text",
    "--loader=.mdx:text",
    "--loader=.txt:text",
    "run",
    options.cliEntry,
    "--backend",
    "local",
    "--yolo",
    "--memfs-startup",
    "skip",
    "--output-format",
    "stream-json",
  ];
  if (options.conversationId) {
    args.push("--conv", options.conversationId);
  } else if (options.model) {
    args.push("--model", options.model);
  }
  args.push("-p", options.prompt);

  const child = spawn(process.execPath, args, {
    cwd: options.projectDir,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  cliProcesses.add(child);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
  return new Promise((resolvePromise) => {
    child.on("exit", (code) => {
      clearTimeout(timeout);
      cliProcesses.delete(child);
      const init = readInitEvent(stdout);
      resolvePromise({
        code,
        ...(init?.agentId ? { agentId: init.agentId } : {}),
        ...(init?.conversationId
          ? { conversationId: init.conversationId }
          : {}),
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
      });
    });
  });
}

function readInitEvent(
  stdout: string,
): { agentId?: string; conversationId?: string } | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: unknown;
        subtype?: unknown;
        agent_id?: unknown;
        conversation_id?: unknown;
      };
      if (parsed.type === "system" && parsed.subtype === "init") {
        return {
          agentId:
            typeof parsed.agent_id === "string" ? parsed.agent_id : undefined,
          conversationId:
            typeof parsed.conversation_id === "string"
              ? parsed.conversation_id
              : undefined,
        };
      }
    } catch {
      // Not a wire message; keep scanning.
    }
  }
  return undefined;
}

// --- payload capture and comparison ---------------------------------------

interface CapturedPayload {
  file: string;
  payload: Record<string, unknown>;
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "conversation";
}

function loadPayload(
  probeDir: string,
  conversationId: string,
): CapturedPayload | undefined {
  if (!existsSync(probeDir)) return undefined;
  const prefix = `payload-${sanitizeSegment(conversationId)}-`;
  const files = readdirSync(probeDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  const file = files[0];
  if (!file) return undefined;
  const parsed = JSON.parse(readFileSync(join(probeDir, file), "utf8")) as {
    payload?: unknown;
  };
  if (!parsed.payload || typeof parsed.payload !== "object") return undefined;
  return {
    file,
    payload: parsed.payload as Record<string, unknown>,
  };
}

const SYSTEM_MESSAGE_ROLES = new Set(["system", "developer"]);

/**
 * Where the system prompt lives in this provider's request.
 *
 * Anthropic-shaped payloads carry it in a top-level `system`/`instructions`
 * field; the OpenAI-compatible shape used here carries it as the leading
 * message. Both are compared; a request with neither cannot prove the gate and
 * is reported as such instead of passing vacuously.
 */
function systemPromptOf(
  payload: Record<string, unknown>,
):
  | { text: string; location: "field" | "leading-message"; count?: number }
  | undefined {
  if (payload.system !== undefined) {
    return { text: canonicalJson(payload.system), location: "field" };
  }
  if (payload.instructions !== undefined) {
    return { text: canonicalJson(payload.instructions), location: "field" };
  }
  const leading: unknown[] = [];
  for (const message of messagesOf(payload)) {
    const role =
      message && typeof message === "object"
        ? (message as { role?: unknown }).role
        : undefined;
    if (typeof role !== "string" || !SYSTEM_MESSAGE_ROLES.has(role)) break;
    leading.push(message);
  }
  if (leading.length === 0) return undefined;
  return {
    text: canonicalJson(leading),
    location: "leading-message",
    count: leading.length,
  };
}

function toolsSegment(payload: Record<string, unknown>): string {
  return canonicalJson(payload.tools ?? null);
}

function messagesOf(payload: Record<string, unknown>): unknown[] {
  const value = payload.messages ?? payload.input;
  return Array.isArray(value) ? value : [];
}

/** Everything in the request except the conversation, i.e. model + settings. */
const CONVERSATION_KEYS = new Set([
  "messages",
  "input",
  "system",
  "instructions",
  "tools",
]);

function requestSettingsOf(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (CONVERSATION_KEYS.has(key)) continue;
    settings[key] = value;
  }
  return settings;
}

function commonPrefixLength(a: unknown[], b: unknown[]): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && canonicalJson(a[index]) === canonicalJson(b[index])) {
    index += 1;
  }
  return index;
}

interface ComparisonReport {
  pass: boolean;
  lines: string[];
  diffs: string[];
}

function bytes(text: string): string {
  return `${Buffer.byteLength(text, "utf8")} bytes`;
}

function comparePayloads(
  parent: CapturedPayload,
  fork: CapturedPayload,
): ComparisonReport {
  const lines: string[] = [];
  const diffs: string[] = [];

  const parentSystem = systemPromptOf(parent.payload);
  const forkSystem = systemPromptOf(fork.payload);
  if (!parentSystem || !forkSystem) {
    lines.push(
      `  system prompt      MISSING    (parent: ${parentSystem ? "found" : "not in request"} / fork: ${forkSystem ? "found" : "not in request"})`,
    );
    diffs.push("system prompt not carried in the captured request");
  } else {
    const where =
      parentSystem.location === "field"
        ? "top-level field"
        : `leading message (${parentSystem.count ?? 1})`;
    if (parentSystem.text === forkSystem.text) {
      lines.push(
        `  system prompt      IDENTICAL  (${where}, ${bytes(parentSystem.text)})`,
      );
    } else {
      lines.push(
        `  system prompt      DIFF       (${where}, parent ${bytes(parentSystem.text)} / fork ${bytes(forkSystem.text)})`,
      );
      diffs.push("system prompt bytes differ");
    }
  }

  const parentTools = toolsSegment(parent.payload);
  const forkTools = toolsSegment(fork.payload);
  if (parentTools === forkTools) {
    lines.push(`  tools block        IDENTICAL  (${bytes(parentTools)})`);
  } else {
    lines.push(
      `  tools block        DIFF       (parent ${bytes(parentTools)} / fork ${bytes(forkTools)})`,
    );
    diffs.push("client_tools JSON differs");
  }

  const parentSettings = requestSettingsOf(parent.payload);
  const forkSettings = requestSettingsOf(fork.payload);
  const parentSettingsJson = canonicalJson(parentSettings);
  const forkSettingsJson = canonicalJson(forkSettings);
  if (parentSettingsJson === forkSettingsJson) {
    const model =
      typeof parent.payload.model === "string" ? parent.payload.model : "?";
    lines.push(`  model + settings   IDENTICAL  (model=${model})`);
  } else {
    const changed = [
      ...new Set([
        ...Object.keys(parentSettings),
        ...Object.keys(forkSettings),
      ]),
    ]
      .filter(
        (key) =>
          canonicalJson(parentSettings[key]) !==
          canonicalJson(forkSettings[key]),
      )
      .sort();
    lines.push(`  model + settings   DIFF       (keys: ${changed.join(", ")})`);
    diffs.push("model request settings differ");
  }

  const parentMessages = messagesOf(parent.payload);
  const forkMessages = messagesOf(fork.payload);
  const shared = commonPrefixLength(parentMessages, forkMessages);
  const appended = shared >= parentMessages.length;
  if (appended) {
    lines.push(
      `  message prefix     APPENDED   (${shared}/${parentMessages.length} parent messages byte-identical, fork has ${forkMessages.length})`,
    );
  } else {
    lines.push(
      `  message prefix     DIFF       (diverges at index ${shared}, parent ${parentMessages.length} / fork ${forkMessages.length})`,
    );
    diffs.push("message prefix diverges");
  }

  return { pass: diffs.length === 0, lines, diffs };
}

// --- scenario --------------------------------------------------------------

type ScenarioOutcome =
  | { kind: "pass"; report: string }
  | { kind: "diff"; report: string }
  | { kind: "pending"; report: string }
  | { kind: "error"; report: string };

async function runScenario(options: {
  mode: ForkContextMode;
  cliEntry: string;
  keep: boolean;
}): Promise<ScenarioOutcome> {
  const tmpRoot = realpathSync(
    await mkdtemp(join(tmpdir(), "hryk-verify-prefix-fork-")),
  );
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const localBackendDir = join(tmpRoot, "local-backend");
  const probeDir = join(tmpRoot, "payloads");
  for (const dir of [homeDir, projectDir, localBackendDir, probeDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const provider = startStubProvider();
  const cleanup = async (): Promise<void> => {
    provider.stop();
    if (!options.keep) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  };

  const env = createIsolatedCliTestEnv({
    HOME: homeDir,
    USERPROFILE: homeDir,
    HARUYUKI_HOME: homeDir,
    LETTA_LOCAL_BACKEND_DIR: localBackendDir,
    LMSTUDIO_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    HARUYUKI_PREFIX_PROBE_DIR: probeDir,
    HARUYUKI_FS_SANDBOX: "0",
    USER_CWD: projectDir,
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  });
  // The conversation must persist so the fork can be created from it; the
  // shared test helper disables persistence for isolation.
  delete env.HARUYUKI_DISABLE_SESSION_PERSIST;

  const header = [
    `F-03 M0 · prefix fork byte gate`,
    `  mode: ${options.mode}`,
    `  temp root: ${tmpRoot}${options.keep ? "" : " (removed on exit)"}`,
    "",
  ];

  try {
    const parent = await runTurn({
      cliEntry: options.cliEntry,
      projectDir,
      env,
      prompt: "Remember that the verification sentinel is sable-42.",
      model: DEFAULT_MODEL,
    });
    if (parent.code !== 0 || !parent.conversationId || !parent.agentId) {
      return {
        kind: "error",
        report: [
          ...header,
          `parent turn failed (exit ${String(parent.code)})`,
          parent.stderrTail,
        ].join("\n"),
      };
    }

    const backend = new LocalBackend({
      storageDir: localBackendDir,
      memfsEnabled: false,
    });
    let forkConversationId: string;
    try {
      const forked = await backend.forkConversation(parent.conversationId, {
        agentId: parent.agentId,
        hidden: true,
        origin: "reflection",
        parentConversationId: parent.conversationId,
        contextMode: options.mode,
      });
      forkConversationId = forked.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("requires F-03")) {
        return {
          kind: "pending",
          report: [
            ...header,
            `parent conversation: ${parent.conversationId} (${parent.agentId})`,
            `fork(${options.mode}) rejected by the backend: ${message}`,
            "",
            "RESULT: PENDING — the context mode is not implemented yet (expected before the",
            "context-mode work item; M0's gate evidence is `--mode inherited-history`).",
          ].join("\n"),
        };
      }
      throw error;
    }

    const forkTurn = await runTurn({
      cliEntry: options.cliEntry,
      projectDir,
      env,
      prompt:
        "Update your memory with anything durable from this conversation.",
      conversationId: forkConversationId,
    });
    if (forkTurn.code !== 0) {
      return {
        kind: "error",
        report: [
          ...header,
          `fork turn failed (exit ${String(forkTurn.code)})`,
          forkTurn.stderrTail,
        ].join("\n"),
      };
    }

    const parentPayload = loadPayload(probeDir, parent.conversationId);
    const forkPayload = loadPayload(probeDir, forkConversationId);
    if (!parentPayload || !forkPayload) {
      return {
        kind: "error",
        report: [
          ...header,
          `missing captured payload (parent: ${parentPayload?.file ?? "none"}, fork: ${forkPayload?.file ?? "none"})`,
          `probe dir: ${probeDir}`,
        ].join("\n"),
      };
    }

    const comparison = comparePayloads(parentPayload, forkPayload);
    const report = [
      ...header,
      `  parent conversation: ${parent.conversationId}`,
      `  fork   conversation: ${forkConversationId}`,
      `  parent payload: ${parentPayload.file} (${messagesOf(parentPayload.payload).length} message(s))`,
      `  fork   payload: ${forkPayload.file} (${messagesOf(forkPayload.payload).length} message(s))`,
      "",
      "frozen-prefix items (requirement §8.1 #1):",
      ...comparison.lines,
      "",
      comparison.pass
        ? "RESULT: PASS — the fork turn sent the same prefix bytes as the parent turn."
        : `RESULT: DIFF — ${comparison.diffs.join("; ")}`,
    ].join("\n");
    return { kind: comparison.pass ? "pass" : "diff", report };
  } catch (error) {
    return {
      kind: "error",
      report: [
        ...header,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      ].join("\n"),
    };
  } finally {
    await cleanup();
    for (const child of cliProcesses) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
  }
}

// --- main ------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  let worst = 0;
  for (const mode of options.modes) {
    const outcome = await runScenario({
      mode,
      cliEntry: options.cliEntry,
      keep: options.keep,
    });
    console.log(outcome.report);
    console.log("");
    const code =
      outcome.kind === "pass"
        ? 0
        : outcome.kind === "diff"
          ? 1
          : outcome.kind === "pending"
            ? 3
            : 2;
    worst = Math.max(worst, code);
  }
  return worst;
}

const exitCode = await main();
process.exit(exitCode);
