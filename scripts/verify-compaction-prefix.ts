#!/usr/bin/env bun
/**
 * verify-compaction-prefix.ts — F-04 M0 prefix byte gate (dev-only tool).
 *
 * Answers the one question the whole F-04 route depends on: **does the
 * compaction summarizer send the same prefix bytes the conversation's own turn
 * sends?** (requirement §5.2.2, §8.1 #1; route §3 M0 exit criterion).
 *
 * What it does, end to end, in a throwaway root:
 *   1. starts a local OpenAI-compatible stub provider (no credentials, no
 *      egress) on 127.0.0.1 and points the LM Studio provider slot at it;
 *   2. runs one real headless turn with `HARUYUKI_PREFIX_PROBE_DIR` set, so the
 *      turn's provider payload is captured;
 *   3. re-invokes this script with `--summarize-only` in a second child with the
 *      same isolated root: that child reads the conversation's frozen snapshot
 *      and messages, assembles the summarizer context exactly as M1 will
 *      (snapshot system prompt + frozen skills block + frozen tools + projected
 *      messages + one appended instruction), and makes the one
 *      `completeProviderOnce()` call, capturing its payload too;
 *   4. compares the two captured payloads: `system`, `tools`, `model` + request
 *      settings byte-identical; the turn's messages a byte-identical prefix of
 *      the summarizer's; and the summarizer's context exactly one message
 *      longer than the projected context (the appended instruction).
 *
 * Usage:
 *   bun scripts/verify-compaction-prefix.ts [--keep] [--cli <path-to-src/index.ts>]
 *
 * Exit codes: 0 PASS · 1 DIFF · 2 setup/usage error.
 *
 * The summarizer's real prompt (M1) replaces the stand-in instruction below;
 * this gate only checks the wire bytes, which do not depend on its wording.
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
import type { Message } from "@earendil-works/pi-ai";
import { toPiMessages, toPiTools } from "@/backend/dev/pi-stream-adapter";
import { completeProviderOnce } from "@/backend/dev/provider-completion";
import { LocalStore } from "@/backend/local/local-store";
import {
  applyFrozenAgentOverrides,
  canonicalJson,
  frozenToolsArray,
} from "@/backend/local/prefix-freeze";
import { appendCompiledSkillsBlock } from "@/backend/local/system-prompt-compilation";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const STUB_MODEL_ID = "verify-compact-model";
const DEFAULT_MODEL = `lmstudio/${STUB_MODEL_ID}`;
const TURN_TIMEOUT_MS = 120_000;
const CHILD_TIMEOUT_MS = 180_000;

/**
 * Stand-in for M1's tail instruction. It is one user message, appended after
 * the projected context — the same shape the real summarizer prompt will have.
 */
const TAIL_INSTRUCTION = [
  "Compaction summarizer (M0 prefix-gate stub).",
  "Read the conversation above and reply with one JSON object of this shape:",
  '{"topics":[{"title":"","startMessageId":"","section":""}],"overview":{"restricted":{"open":"","errors":"","relationship":"","memoryIndex":""},"narrative":""}}',
  "The product prompt and the parser land with the summarizer milestone; this request only exists to capture the provider payload.",
].join("\n");

/**
 * Provider credentials that may be present in the operator's shell. The gate
 * must not be able to reach a real endpoint even if one is configured; the
 * explicit `--model` already fixes routing, this makes that a guarantee.
 */
const AMBIENT_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "HARUYUKI_DISABLE_LOCAL_MODEL_DISCOVERY",
] as const;

const childProcesses = new Set<ChildProcessWithoutNullStreams>();

// --- args ------------------------------------------------------------------

interface CliOptions {
  keep: boolean;
  cliEntry: string;
  summarizeOnly?: {
    storage: string;
    conversationId: string;
    agentId: string;
  };
}

function scriptPath(): string {
  return resolve(fileURLToPath(import.meta.url));
}

function repoRoot(): string {
  return resolve(dirname(scriptPath()), "..");
}

function parseArgs(argv: string[]): CliOptions {
  let keep = false;
  let cliEntry = join(repoRoot(), "src", "index.ts");
  let summarizeOnly: CliOptions["summarizeOnly"];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    if (arg === "--summarize-only") {
      summarizeOnly = { storage: "", conversationId: "", agentId: "" };
      continue;
    }
    if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      values.set(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  const cli = values.get("--cli");
  if (cli) cliEntry = resolve(cli);
  if (summarizeOnly) {
    summarizeOnly = {
      storage: required(values, "--storage"),
      conversationId: required(values, "--conv"),
      agentId: required(values, "--agent"),
    };
  }
  return { keep, cliEntry, ...(summarizeOnly ? { summarizeOnly } : {}) };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
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
 * assistant reply as SSE — no tool calls, so a request finishes in one shot.
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
              id: STUB_MODEL_ID,
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
          data: [{ id: STUB_MODEL_ID, object: "model" }],
        });
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      await req.json().catch(() => undefined);
      const base = {
        id: "chatcmpl-verify-compact",
        object: "chat.completion.chunk",
        created: 1,
        model: STUB_MODEL_ID,
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
    "--model",
    DEFAULT_MODEL,
    "-p",
    options.prompt,
  ];

  const child = spawn(process.execPath, args, {
    cwd: options.projectDir,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  childProcesses.add(child);
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
      childProcesses.delete(child);
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

// --- summarizer leg (child process) ---------------------------------------

const META_MARKER = "##SUMMARY_META##";

interface SummarizerMeta {
  projectedMessageCount: number;
  requestMessageCount: number;
  stopReason: string;
  promptTokens: number;
  cachedInputTokens: number;
}

/**
 * The summarizer leg, run in its own process so the isolated environment holds
 * for the provider discovery and so nothing here can disturb the orchestrator.
 * The assembly is a stand-in for M1's `compaction-summarizer.ts`: same four
 * frozen pieces (snapshot system prompt + frozen skills block + frozen tools +
 * frozen agent), same projection helpers, same one-appended-instruction shape.
 */
async function runSummarizerOnly(input: {
  storage: string;
  conversationId: string;
  agentId: string;
}): Promise<number> {
  const store = new LocalStore(input.agentId, {
    storageDir: input.storage,
    seedDefaultAgent: false,
  });
  const liveAgent = store.retrieveAgentRecord(input.agentId);
  const snapshot = store.getCompiledSystemPrompt(
    input.conversationId,
    input.agentId,
  );
  if (!snapshot) {
    console.error(
      `no compiled system prompt for ${input.conversationId}; run the turn first`,
    );
    return 2;
  }
  const storedMessages = store.listLocalMessages(
    input.conversationId,
    input.agentId,
  );
  const projected = toPiMessages(storedMessages);
  const tools = toPiTools(frozenToolsArray(snapshot) ?? []);
  const instruction: Message = {
    role: "user",
    content: TAIL_INSTRUCTION,
    timestamp: Date.now(),
  };
  const messages: Message[] = [...projected, instruction];
  const context = {
    systemPrompt: appendCompiledSkillsBlock(
      snapshot.content,
      snapshot.frozenSkillsBlock,
    ),
    messages,
    ...(tools ? { tools } : {}),
  };
  const result = await completeProviderOnce({
    agent: applyFrozenAgentOverrides(liveAgent, snapshot),
    context,
    conversationId: input.conversationId,
    storageDir: input.storage,
  });
  const meta: SummarizerMeta = {
    projectedMessageCount: projected.length,
    requestMessageCount: messages.length,
    stopReason: result.message.stopReason,
    promptTokens: result.usage.promptTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
  };
  console.log(`${META_MARKER} ${JSON.stringify(meta)}`);
  return 0;
}

function readSummarizerMeta(stdout: string): SummarizerMeta | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(META_MARKER)) continue;
    try {
      return JSON.parse(
        trimmed.slice(META_MARKER.length).trim(),
      ) as SummarizerMeta;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function spawnSummarizer(options: {
  env: NodeJS.ProcessEnv;
  storage: string;
  conversationId: string;
  agentId: string;
}): Promise<{
  code: number | null;
  meta?: SummarizerMeta;
  stderrTail: string;
}> {
  const args = [
    scriptPath(),
    "--summarize-only",
    "--storage",
    options.storage,
    "--conv",
    options.conversationId,
    "--agent",
    options.agentId,
  ];
  const child = spawn(process.execPath, args, {
    cwd: repoRoot(),
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  childProcesses.add(child);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => child.kill("SIGTERM"), CHILD_TIMEOUT_MS);
  return new Promise((resolvePromise) => {
    child.on("exit", (code) => {
      clearTimeout(timeout);
      childProcesses.delete(child);
      resolvePromise({
        code,
        ...(readSummarizerMeta(stdout)
          ? { meta: readSummarizerMeta(stdout) }
          : {}),
        stderrTail: tail(stderr),
      });
    });
  });
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
 * Where the system prompt lives in this provider's request: a top-level
 * `system`/`instructions` field, or the leading system message (the
 * OpenAI-compatible shape used here). A request with neither cannot prove the
 * gate and is reported as such instead of passing vacuously.
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

function roleOf(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
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

function bytes(text: string): string {
  return `${Buffer.byteLength(text, "utf8")} bytes`;
}

interface ComparisonReport {
  pass: boolean;
  lines: string[];
  diffs: string[];
}

function comparePayloads(input: {
  turn: CapturedPayload;
  summarizer: CapturedPayload;
  meta: SummarizerMeta;
}): ComparisonReport {
  const lines: string[] = [];
  const diffs: string[] = [];

  const turnSystem = systemPromptOf(input.turn.payload);
  const summarizerSystem = systemPromptOf(input.summarizer.payload);
  if (!turnSystem || !summarizerSystem) {
    lines.push(
      `  system prompt      MISSING    (turn: ${turnSystem ? "found" : "not in request"} / summarizer: ${summarizerSystem ? "found" : "not in request"})`,
    );
    diffs.push("system prompt not carried in the captured request");
  } else if (turnSystem.text === summarizerSystem.text) {
    const where =
      turnSystem.location === "field"
        ? "top-level field"
        : `leading message (${turnSystem.count ?? 1})`;
    lines.push(
      `  system prompt      IDENTICAL  (${where}, ${bytes(turnSystem.text)})`,
    );
  } else {
    lines.push(
      `  system prompt      DIFF       (turn ${bytes(turnSystem.text)} / summarizer ${bytes(summarizerSystem.text)})`,
    );
    diffs.push("system prompt bytes differ");
  }

  const turnTools = toolsSegment(input.turn.payload);
  const summarizerTools = toolsSegment(input.summarizer.payload);
  if (turnTools === summarizerTools) {
    lines.push(`  tools block        IDENTICAL  (${bytes(turnTools)})`);
  } else {
    lines.push(
      `  tools block        DIFF       (turn ${bytes(turnTools)} / summarizer ${bytes(summarizerTools)})`,
    );
    diffs.push("tool declarations differ");
  }

  const turnSettings = requestSettingsOf(input.turn.payload);
  const summarizerSettings = requestSettingsOf(input.summarizer.payload);
  if (canonicalJson(turnSettings) === canonicalJson(summarizerSettings)) {
    const model =
      typeof input.turn.payload.model === "string"
        ? input.turn.payload.model
        : "?";
    lines.push(`  model + settings   IDENTICAL  (model=${model})`);
  } else {
    const changed = [
      ...new Set([
        ...Object.keys(turnSettings),
        ...Object.keys(summarizerSettings),
      ]),
    ]
      .filter(
        (key) =>
          canonicalJson(turnSettings[key]) !==
          canonicalJson(summarizerSettings[key]),
      )
      .sort();
    lines.push(`  model + settings   DIFF       (keys: ${changed.join(", ")})`);
    diffs.push("model request settings differ");
  }

  const turnMessages = messagesOf(input.turn.payload);
  const summarizerMessages = messagesOf(input.summarizer.payload);
  const shared = commonPrefixLength(turnMessages, summarizerMessages);
  if (shared < turnMessages.length) {
    lines.push(
      `  message prefix     DIFF       (diverges at index ${shared}, turn ${turnMessages.length} / summarizer ${summarizerMessages.length})`,
    );
    diffs.push("message prefix diverges");
  } else {
    lines.push(
      `  message prefix     APPENDED   (${shared}/${turnMessages.length} turn messages byte-identical, summarizer has ${summarizerMessages.length})`,
    );
  }

  // The turn prompt is the conversation's own last request, so its message list
  // ends with the user turn. The summarizer's context is the *projected* current
  // context plus one instruction; the persisted assistant reply is stripped as
  // a trailing assistant (C-11), which is why the delta is exactly +1.
  const appended = summarizerMessages.length - turnMessages.length;
  const instruction = summarizerMessages.at(-1);
  if (appended !== 1) {
    lines.push(
      `  append shape       DIFF       (expected exactly one appended instruction, got +${appended})`,
    );
    diffs.push("the summarizer appended something other than one instruction");
  } else if (roleOf(instruction) !== "user") {
    lines.push(
      `  append shape       DIFF       (appended role: ${roleOf(instruction) ?? "?"})`,
    );
    diffs.push("the appended message is not a user instruction");
  } else {
    lines.push(
      "  append shape       APPENDED   (+1 user instruction after the turn's message list)",
    );
  }

  // The provider payload carries the system prompt as a leading message in this
  // shape, so the wire count is the assembled context plus that lead.
  const systemLead =
    turnSystem?.location === "leading-message" ? (turnSystem.count ?? 1) : 0;
  const carried = summarizerMessages.length - systemLead;
  if (input.meta.requestMessageCount !== input.meta.projectedMessageCount + 1) {
    lines.push(
      `  instruction only   DIFF       (projected ${input.meta.projectedMessageCount} messages, request carried ${input.meta.requestMessageCount})`,
    );
    diffs.push(
      "the summarizer request is not the projected context + one instruction",
    );
  } else if (carried !== input.meta.requestMessageCount) {
    lines.push(
      `  instruction only   DIFF       (child assembled ${input.meta.requestMessageCount}, provider carried ${carried} after the system lead)`,
    );
    diffs.push(
      "the sent payload does not match the assembled summarizer context",
    );
  } else {
    lines.push(
      `  instruction only   APPENDED   (${input.meta.projectedMessageCount} projected + 1 instruction = ${input.meta.requestMessageCount}, provider carries ${summarizerMessages.length} incl. system)`,
    );
  }

  return { pass: diffs.length === 0, lines, diffs };
}

// --- scenario --------------------------------------------------------------

type ScenarioOutcome =
  | { kind: "pass"; report: string }
  | { kind: "diff"; report: string }
  | { kind: "error"; report: string };

async function runScenario(options: {
  cliEntry: string;
  keep: boolean;
}): Promise<ScenarioOutcome> {
  const tmpRoot = realpathSync(
    await mkdtemp(join(tmpdir(), "hryk-verify-compaction-prefix-")),
  );
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const localBackendDir = join(tmpRoot, "local-backend");
  const turnProbeDir = join(tmpRoot, "payloads-turn");
  const summarizerProbeDir = join(tmpRoot, "payloads-summarizer");
  for (const dir of [
    homeDir,
    projectDir,
    localBackendDir,
    turnProbeDir,
    summarizerProbeDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const provider = startStubProvider();
  const baseEnv = createIsolatedCliTestEnv({
    HOME: homeDir,
    USERPROFILE: homeDir,
    HARUYUKI_HOME: homeDir,
    LETTA_LOCAL_BACKEND_DIR: localBackendDir,
    LMSTUDIO_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    HARUYUKI_FS_SANDBOX: "0",
    USER_CWD: projectDir,
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  });
  // The conversation must persist so the summarizer leg can read it; the shared
  // test helper disables persistence for isolation.
  delete baseEnv.HARUYUKI_DISABLE_SESSION_PERSIST;
  // "No credentials" must hold by construction, not by luck: the helper only
  // strips LETTA_*/HARUYUKI_* names, so ambient provider keys from the
  // operator's shell would otherwise ride along into the children.
  for (const key of AMBIENT_PROVIDER_KEYS) delete baseEnv[key];

  const header = [
    "F-04 M0 · compaction prefix byte gate",
    `  temp root: ${tmpRoot}${options.keep ? "" : " (removed on exit)"}`,
    "",
  ];

  const cleanup = async (): Promise<void> => {
    provider.stop();
    for (const child of childProcesses) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
    if (!options.keep) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  };

  try {
    const turn = await runTurn({
      cliEntry: options.cliEntry,
      projectDir,
      env: { ...baseEnv, HARUYUKI_PREFIX_PROBE_DIR: turnProbeDir },
      prompt: "Remember that the compaction verification sentinel is birch-77.",
    });
    if (turn.code !== 0 || !turn.conversationId || !turn.agentId) {
      return {
        kind: "error",
        report: [
          ...header,
          `turn failed (exit ${String(turn.code)})`,
          turn.stderrTail,
        ].join("\n"),
      };
    }

    const summarizer = await spawnSummarizer({
      env: {
        ...baseEnv,
        HARUYUKI_PREFIX_PROBE_DIR: summarizerProbeDir,
      },
      storage: localBackendDir,
      conversationId: turn.conversationId,
      agentId: turn.agentId,
    });
    if (summarizer.code !== 0 || !summarizer.meta) {
      return {
        kind: "error",
        report: [
          ...header,
          `summarizer leg failed (exit ${String(summarizer.code)})`,
          summarizer.stderrTail,
        ].join("\n"),
      };
    }

    const turnPayload = loadPayload(turnProbeDir, turn.conversationId);
    const summarizerPayload = loadPayload(
      summarizerProbeDir,
      turn.conversationId,
    );
    if (!turnPayload || !summarizerPayload) {
      return {
        kind: "error",
        report: [
          ...header,
          `missing captured payload (turn: ${turnPayload?.file ?? "none"}, summarizer: ${summarizerPayload?.file ?? "none"})`,
          `probe dirs: ${turnProbeDir} / ${summarizerProbeDir}`,
        ].join("\n"),
      };
    }

    const comparison = comparePayloads({
      turn: turnPayload,
      summarizer: summarizerPayload,
      meta: summarizer.meta,
    });
    const report = [
      ...header,
      `  conversation: ${turn.conversationId} (${turn.agentId})`,
      `  turn payload:       ${turnPayload.file} (${messagesOf(turnPayload.payload).length} message(s))`,
      `  summarizer payload: ${summarizerPayload.file} (${messagesOf(summarizerPayload.payload).length} message(s), stop=${summarizer.meta.stopReason})`,
      "",
      "frozen-prefix items (requirement §8.1 #1, route §3 M0):",
      ...comparison.lines,
      "",
      comparison.pass
        ? "RESULT: PASS — the summarizer sends the turn's prefix bytes plus one instruction."
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
  }
}

// --- main ------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.summarizeOnly) {
    return runSummarizerOnly(options.summarizeOnly);
  }
  const outcome = await runScenario({
    cliEntry: options.cliEntry,
    keep: options.keep,
  });
  console.log(outcome.report);
  return outcome.kind === "pass" ? 0 : outcome.kind === "diff" ? 1 : 2;
}

const exitCode = await main();
process.exit(exitCode);
