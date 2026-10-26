import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

type JsonObject = Record<string, unknown>;

interface ReflectionTranscriptState {
  /** v4: user-message counting replaced completed-step counting (F-03 §5.5.2). */
  version?: number;
  total_user_messages?: number;
  reflected_user_messages?: number;
  messages_since_last_successful_reflection?: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

interface BidirectionalReflectionSummary {
  code: number | null;
  signal: NodeJS.Signals | null;
  tmpRoot: string;
  agentId: string | null;
  conversationId: string | null;
  resultCount: number;
  reflectionLaunchCount: number;
  events: Array<{
    type?: unknown;
    subtype?: unknown;
    result?: unknown;
    conversationId?: unknown;
  }>;
  transcriptDir: string | null;
  transcriptLines: string[];
  payloadFiles: string[];
  state: ReflectionTranscriptState | null;
  stdoutTail: string;
  stderrTail: string;
}

const cliProcesses = new Set<ChildProcessWithoutNullStreams>();
const tempRoots: string[] = [];
const reflectionWaitTimeoutMs = 10_000;
// Keep the original startup/turn budget in addition to all three sequential
// reflection waits. A whole-scenario deadline must not cut a valid wait short.
const scenarioTimeoutMs = 25_000 + 3 * reflectionWaitTimeoutMs;

afterAll(async () => {
  for (const child of cliProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  if (process.env.KEEP_REFLECTION_E2E_ROOT === "1") {
    console.error("kept temp roots:", tempRoots.join(", "));
    return;
  }
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("headless bidirectional auto-reflection", () => {
  test("records completed turns and launches step-count reflection from transcript state", async () => {
    const summary = await runBidirectionalReflectionScenario();

    expect(summary.code, formatSummary(summary)).toBe(0);
    expect(summary.signal, formatSummary(summary)).toBeNull();
    // A completed reflection enqueues one notification turn, so `result`
    // envelopes are no longer a turn counter: three user turns plus their
    // notifications. The transcript line count below is the stable check.
    expect(summary.resultCount, formatSummary(summary)).toBeGreaterThanOrEqual(
      3,
    );
    expect(summary.agentId, formatSummary(summary)).toBeTruthy();
    expect(summary.conversationId, formatSummary(summary)).toBeTruthy();
    expect(summary.transcriptDir, formatSummary(summary)).toBeTruthy();

    // Three user turns plus three notification turns: assert the user turns by
    // content instead of a total line count, which the notification channel
    // legitimately grows.
    expect(
      summary.transcriptLines.length,
      formatSummary(summary),
    ).toBeGreaterThanOrEqual(6);
    expect(summary.transcriptLines[0]).toContain('"kind":"user"');
    expect(summary.transcriptLines[0]).toContain("hello one");
    expect(summary.transcriptLines[1]).toContain('"kind":"assistant"');
    expect(summary.transcriptLines[1]).toContain(
      '"source_message_id":"ui-msg-2"',
    );
    for (const prompt of ["hello one", "hello two", "hello three"]) {
      expect(
        summary.transcriptLines.some(
          (line) => line.includes('"kind":"user"') && line.includes(prompt),
        ),
        `missing user turn ${prompt}\n${formatSummary(summary)}`,
      ).toBe(true);
    }

    // Post-turn reflections, one per user message. A silent break in the
    // trigger, the launcher or the settlement fails these assertions.
    expect(summary.reflectionLaunchCount, formatSummary(summary)).toBe(3);
    // The payload path is retired (F-03 §5.13.1): the fork carries the context.
    expect(summary.payloadFiles, formatSummary(summary)).toHaveLength(0);
    expect(summary.state?.total_user_messages, formatSummary(summary)).toBe(3);
    expect(summary.state?.reflected_user_messages, formatSummary(summary)).toBe(
      3,
    );
    expect(
      summary.state?.messages_since_last_successful_reflection,
      formatSummary(summary),
    ).toBe(0);
    expect(
      summary.state?.last_reflection_started_at,
      formatSummary(summary),
    ).toBeTruthy();
    expect(
      summary.state?.last_reflection_succeeded_at,
      formatSummary(summary),
    ).toBeTruthy();
  }, 60_000);
});

async function runBidirectionalReflectionScenario(): Promise<BidirectionalReflectionSummary> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "letta-bidir-reflection-test-"));
  tempRoots.push(tmpRoot);
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const localBackendDir = join(tmpRoot, "local-backend");
  const transcriptRoot = join(tmpRoot, "transcripts");
  mkdirSync(join(homeDir, ".haruyuki"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(localBackendDir, { recursive: true });
  mkdirSync(transcriptRoot, { recursive: true });

  writeFileSync(
    join(homeDir, ".haruyuki", "settings.json"),
    JSON.stringify(
      {
        tokenStreaming: false,
        sessionContextEnabled: true,
        // F-03 trigger surface: every user message starts one reflection. The
        // fork is kept only by the run itself; success deletes it again, which
        // is why the assertions below read the transcript state, not the fork.
        reflectionOnCompaction: false,
        reflectionEveryUserMessages: 1,
        reflectionTimeoutMinutes: 3,
        reflectionDeleteSessionOnSuccess: true,
        agents: [],
      },
      null,
      2,
    ),
  );

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliEntry = join(repoRoot, "src", "index.ts");
  const child = spawn(
    process.execPath,
    [
      "--loader=.md:text",
      "--loader=.mdx:text",
      "--loader=.txt:text",
      "run",
      cliEntry,
      "--backend",
      "local",
      // A bare local environment has no discoverable catalog and startup fails
      // closed with "Model catalog is unavailable." (the Cloud fallback that used
      // to supply one is gone), so the fixture names the deterministic model.
      "--model",
      "local/default",
      "--new-agent",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--no-system-info-reminder",
    ],
    {
      cwd: projectDir,
      env: createIsolatedCliTestEnv({
        HOME: homeDir,
        LETTA_LOCAL_BACKEND_DIR: localBackendDir,
        // Ordinary turns still return pong, while reflection turns execute a
        // real Bash read of TRANSCRIPT_PATH before returning success.
        HARUYUKI_LOCAL_BACKEND_EXECUTOR: "deterministic-reflection",
        LETTA_TRANSCRIPT_ROOT: transcriptRoot,
        // This test exercises transcript-driven reflection, not kernel sandbox
        // behavior. Keep it independent of host bwrap/seatbelt availability.
        HARUYUKI_FS_SANDBOX: "0",
        USER_CWD: projectDir,
        HARUYUKI_DEBUG: "1",
        NO_COLOR: "1",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  cliProcesses.add(child);

  let stdout = "";
  let stderr = "";
  let pendingStdout = "";
  let sentFirstMessage = false;
  let resultCount = 0;
  let agentId: string | null = null;
  let conversationId: string | null = null;
  const events: BidirectionalReflectionSummary["events"] = [];

  const sendUser = (content: string) => {
    child.stdin.write(
      `${JSON.stringify({ type: "user", message: { content } })}\n`,
    );
  };

  const transcriptDir = () =>
    agentId && conversationId
      ? join(transcriptRoot, agentId, conversationId)
      : null;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    pendingStdout += text;

    while (true) {
      const newlineIndex = pendingStdout.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = pendingStdout.slice(0, newlineIndex).trim();
      pendingStdout = pendingStdout.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: JsonObject;
      try {
        parsed = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }

      agentId = typeof parsed.agent_id === "string" ? parsed.agent_id : agentId;
      conversationId =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : conversationId;
      events.push({
        type: parsed.type,
        subtype: parsed.subtype,
        result: parsed.result,
        conversationId: parsed.conversation_id,
      });

      if (
        parsed.type === "system" &&
        parsed.subtype === "init" &&
        !sentFirstMessage
      ) {
        sentFirstMessage = true;
        // Drive the scenario by state, not by result events: a completed
        // reflection can itself enqueue a notification turn, so the number of
        // `result` envelopes is not a stable turn counter any more.
        void driveTurns();
      }

      if (parsed.type === "result") {
        resultCount += 1;
      }
    }
  });

  /** Send each user line only after the previous reflection has settled. */
  const driveTurns = async (): Promise<void> => {
    const prompts = ["hello one", "hello two", "hello three"];
    for (let index = 0; index < prompts.length; index += 1) {
      sendUser(prompts[index] ?? "");
      await waitForReflectionProgress(transcriptDir, {
        reflectedUserMessages: index + 1,
        timeoutMs: reflectionWaitTimeoutMs,
      });
    }
    child.stdin.end();
  };

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, scenarioTimeoutMs);

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise) => {
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      cliProcesses.delete(child);
      resolvePromise({ code, signal });
    });
  });

  const finalTranscriptDir = transcriptDir();
  const state = finalTranscriptDir
    ? readReflectionState(finalTranscriptDir)
    : null;
  const transcriptLines = finalTranscriptDir
    ? readTranscriptLines(finalTranscriptDir)
    : [];
  const payloadFiles = finalTranscriptDir
    ? readPayloadFiles(finalTranscriptDir)
    : [];

  return {
    code,
    signal,
    tmpRoot,
    agentId,
    conversationId,
    resultCount,
    reflectionLaunchCount: countOccurrences(
      stderr,
      "launched (user-messages) on fork",
    ),
    events,
    transcriptDir: finalTranscriptDir,
    transcriptLines,
    payloadFiles,
    state,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

async function waitForReflectionProgress(
  getTranscriptDir: () => string | null,
  options: { reflectedUserMessages: number; timeoutMs: number },
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    const dir = getTranscriptDir();
    const state = dir ? readReflectionState(dir) : null;
    if (
      (state?.reflected_user_messages ?? 0) >= options.reflectedUserMessages
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function readReflectionState(dir: string): ReflectionTranscriptState | null {
  try {
    return JSON.parse(
      readFileSync(join(dir, "state.json"), "utf-8"),
    ) as ReflectionTranscriptState;
  } catch {
    return null;
  }
}

function readTranscriptLines(dir: string): string[] {
  try {
    return readFileSync(join(dir, "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readPayloadFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(
        (name) => name.startsWith("payload-auto-") && name.endsWith(".json"),
      )
      .sort();
  } catch {
    return [];
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

function tail(text: string): string {
  return text.split("\n").slice(-80).join("\n");
}

function formatSummary(summary: BidirectionalReflectionSummary): string {
  return JSON.stringify(
    {
      code: summary.code,
      signal: summary.signal,
      tmpRoot: summary.tmpRoot,
      agentId: summary.agentId,
      conversationId: summary.conversationId,
      resultCount: summary.resultCount,
      reflectionLaunchCount: summary.reflectionLaunchCount,
      transcriptDir: summary.transcriptDir,
      payloadFiles: summary.payloadFiles,
      state: summary.state,
      transcriptLines: summary.transcriptLines,
      events: summary.events,
      stdoutTail: summary.stdoutTail,
      stderrTail: summary.stderrTail,
    },
    null,
    2,
  );
}
