#!/usr/bin/env bun
/**
 * verify-compaction-apply.ts — F-04 P1.5 apply seam (dev-only tool).
 *
 * The M0 gate (`verify-compaction-prefix.ts`) proves the summarizer sends the
 * conversation's own frozen prefix bytes. This gate answers the next question
 * the route depends on: **can the real summarizer's product be written back by
 * the real backend?** Not "is the payload equal" — that a preview reaches
 * `applyCompaction` at all, and that every trace it is supposed to leave is
 * really there.
 *
 * What it does, in one throwaway root and one process:
 *   1. builds a real `LocalBackend` over a temp `storageDir` with the
 *      deterministic turn executor, writes six turns, and marks one topic — a
 *      conversation the compression rate can cut;
 *   2. starts the shared OpenAI-compatible stub (no credentials, no egress) and
 *      points the LM Studio slot at it, then takes a preview through
 *      **`backend.prepareCompaction`**. That is the production path: the agent
 *      the summarizer runs as is filled by `frozenAgentForConversation`, not by
 *      this script. The stub's reply is a valid product (two topics, four
 *      non-empty restricted fields, a narrative), so the real validator accepts
 *      it and there is exactly one provider call;
 *   3. calls `backend.applyCompaction({ pick: { kind: "ratio_suggestion" } })`
 *      — the default pick the listener/headless paths use;
 *   4. repeats 2–3 once, so the second write-back folds the first summary. That
 *      is what makes "the historical section is not carried" observable: the
 *      first compaction's section exists in the context, and the second
 *      write-back must not re-emit it.
 *
 * Assertions (all executed, none skipped):
 *   - after the second write-back the context holds exactly one `system_alert`
 *     user message; it carries overview 2 and the section the second cut folded,
 *     and carries neither the section that cut kept nor the historical section;
 *   - the summarizer's topics landed in the transcript with
 *     `createdBy: "summarizer"`, a real `anchorMessageId`, and a `summary`;
 *   - both compaction rows carry non-empty `details.stats.folded_topic_ids`
 *     equal to what the backend reported;
 *   - the provider request count is unchanged across each apply (write-back
 *     never calls a model);
 *   - `queryTopicIndex({ agentId, storageDir, conversationId })` returns the
 *     entries with their `section`;
 *   - `listTopics(conversationId, agentId).blocks` projects the section back.
 *
 * Usage:
 *   bun scripts/verify-compaction-apply.ts [--keep]
 *
 * Exit codes: 0 PASS · 1 DIFF · 2 setup/usage error.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import type { CompactionPreview } from "@/backend/local/compaction-preview";
import { LocalBackend } from "@/backend/local/local-backend";
import type { LocalMessage } from "@/backend/local/local-message";
import { queryTopicIndex } from "@/backend/local/topic-index";
import { stripAmbientHaruyukiTestEnv } from "@/test-utils/test-process-env";
import {
  AMBIENT_PROVIDER_KEYS,
  DEFAULT_STUB_MODEL,
  startStubProvider,
  summarizerReply,
} from "./verify-compaction-lib";

const TURN_COUNT = 6;
/** Enough body per turn that the compression rate has something to cut. */
const TURN_PADDING_CHARS = 400;
const MARKER_TITLE = "Pre-compaction boundary";
const MARKER_SUMMARY =
  "user marker section: the write-back must not carry a user marker's summary";

/** The sections/titles each stub reply names, so a pass is told from a cut. */
function titleOf(pass: number): string {
  return `T${pass}-`;
}
function sectionOf(pass: number, topic: number): string {
  return `SECTION-${pass}-topic-${topic}`;
}
function overviewOf(pass: number): string {
  return `[overview-${pass}]`;
}

// --- args ------------------------------------------------------------------

interface CliOptions {
  keep: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let keep = false;
  for (const arg of argv) {
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg} (supported: --keep)`);
  }
  return { keep };
}

// --- checks ----------------------------------------------------------------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail };
}

function formatChecks(checks: readonly Check[]): string[] {
  return checks.map(
    (entry) =>
      `  ${entry.pass ? "PASS" : "DIFF"}  ${entry.name} — ${entry.detail}`,
  );
}

type ScenarioOutcome =
  | { kind: "pass"; report: string }
  | { kind: "diff"; report: string }
  | { kind: "error"; report: string };

// --- isolated environment --------------------------------------------------

/**
 * The backend and the summarizer resolve home, storage and the provider slot
 * from the ambient environment, so the gate rewrites it before anything reads
 * it and restores it on the way out. `createIsolatedCliTestEnv` is not used
 * because it returns a copy: this process is the one doing the work.
 */
function isolateProcessEnv(overrides: Record<string, string>): () => void {
  const previous = { ...process.env };
  stripAmbientHaruyukiTestEnv(process.env);
  // "No credentials" must hold by construction, not by luck: the shared
  // helper only strips LETTA_*/HARUYUKI_* names.
  for (const key of AMBIENT_PROVIDER_KEYS) delete process.env[key];
  // The conversation must persist for the summarizer to read it back; the test
  // helper disables persistence for isolation.
  delete process.env.HARUYUKI_DISABLE_SESSION_PERSIST;
  Object.assign(process.env, overrides);
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(previous, key)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  };
}

// --- conversation fixture --------------------------------------------------

/** One scripted assistant reply per user turn, plus a turn counter. */
function deterministicExecutor(calls: { count: number }): HeadlessTurnExecutor {
  return {
    async execute() {
      calls.count += 1;
      return streamFromChunks([
        {
          message_type: "assistant_message",
          content: [{ type: "text", text: "ok" }],
        } as LettaStreamingResponse,
        {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse,
      ]);
    },
  };
}

function streamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

async function sendTurn(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
  content: string,
): Promise<void> {
  const stream = await backend.createConversationMessageStream(conversationId, {
    agent_id: agentId,
    messages: [{ role: "user", content }],
  } as ConversationMessageCreateBody);
  for await (const _chunk of stream) {
    // Drain; the stored transcript is what this gate reads.
  }
}

/** The in-context messages, through the same store method the product uses. */
function storedMessages(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
): LocalMessage[] {
  const store = (
    backend as unknown as {
      store: {
        listLocalMessages(
          conversationId: string,
          agentId: string,
        ): LocalMessage[];
      };
    }
  ).store;
  return store.listLocalMessages(conversationId, agentId);
}

function transcriptPath(
  storageDir: string,
  conversationId: string,
  agentId: string,
): string {
  const key =
    conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  return join(
    storageDir,
    "conversations",
    Buffer.from(key).toString("base64url"),
    "messages.jsonl",
  );
}

async function transcriptRows(
  storageDir: string,
  conversationId: string,
  agentId: string,
): Promise<Record<string, unknown>[]> {
  const raw = await readFile(
    transcriptPath(storageDir, conversationId, agentId),
    "utf8",
  );
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// --- summary message -------------------------------------------------------

interface PackedSummary {
  message: string;
  stats: unknown;
}

/** The write-back's single summary message: a user message holding a JSON blob. */
function packedSummary(message: LocalMessage): PackedSummary | undefined {
  if (message.role !== "user") return undefined;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as {
      type?: unknown;
      message?: unknown;
      compaction_stats?: unknown;
    };
    if (record.type !== "system_alert") return undefined;
    if (typeof record.message !== "string") return undefined;
    return { message: record.message, stats: record.compaction_stats };
  } catch {
    return undefined;
  }
}

function foldedTopicIdsOf(row: Record<string, unknown>): string[] | undefined {
  const details = row.details;
  if (!details || typeof details !== "object") return undefined;
  const stats = (details as { stats?: unknown }).stats;
  if (!stats || typeof stats !== "object") return undefined;
  const ids = (stats as { folded_topic_ids?: unknown }).folded_topic_ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return undefined;
  }
  return ids;
}

function sameStats(
  left: { summarizerRequests: number; turnRequests: number },
  right: { summarizerRequests: number; turnRequests: number },
): boolean {
  return (
    left.summarizerRequests === right.summarizerRequests &&
    left.turnRequests === right.turnRequests
  );
}

function statsDelta(
  before: { summarizerRequests: number; turnRequests: number },
  after: { summarizerRequests: number; turnRequests: number },
): string {
  return `${after.summarizerRequests - before.summarizerRequests} summarizer / ${after.turnRequests - before.turnRequests} turn`;
}

// --- preflight -------------------------------------------------------------

function previewChecks(
  label: string,
  preview: CompactionPreview,
  inContextIds: ReadonlySet<string>,
): Check[] {
  const restricted = Object.values(preview.overview.restricted);
  return [
    check(
      `${label}: usable (no degradation)`,
      preview.degraded === null,
      `degraded=${preview.degraded ?? "none"}, topics=${preview.topics.length}`,
    ),
    check(
      `${label}: two topic drafts from the stub`,
      preview.topics.length === 2,
      preview.topics.map((topic) => topic.title).join(", ") || "none",
    ),
    check(
      `${label}: boundaries are real message ids`,
      preview.topics.every((topic) => inContextIds.has(topic.startMessageId)),
      preview.topics.map((topic) => topic.startMessageId).join(", ") || "none",
    ),
    check(
      `${label}: four restricted fields + narrative are non-empty`,
      restricted.every(
        (value) => typeof value === "string" && value.trim().length > 0,
      ) && preview.overview.narrative.trim().length > 0,
      `restricted=${restricted.length} field(s), narrative=${preview.overview.narrative.trim().length} char(s)`,
    ),
  ];
}

// --- scenario --------------------------------------------------------------

async function runScenario(options: CliOptions): Promise<ScenarioOutcome> {
  const tmpRoot = realpathSync(
    await mkdtemp(join(tmpdir(), "hryk-verify-compaction-apply-")),
  );
  const homeDir = join(tmpRoot, "home");
  const storageDir = join(tmpRoot, "local-backend");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(storageDir, { recursive: true });

  const provider = startStubProvider({
    // Pass 1 splits at 60% of the id table, pass 2 at 75%: both second topics
    // sit inside the region the rate keeps, and the two cuts anchor on
    // different message ids, so each compaction writes its own marker.
    summarizerReply: (instruction, callIndex) =>
      summarizerReply(instruction, {
        topics: "split",
        secondTopicFraction: callIndex === 0 ? 0.6 : 0.75,
        titlePrefix: titleOf(callIndex + 1),
        sectionPrefix: `SECTION-${callIndex + 1}-`,
        overviewSuffix: ` ${overviewOf(callIndex + 1)}`,
      }),
  });
  const restoreEnv = isolateProcessEnv({
    HOME: homeDir,
    USERPROFILE: homeDir,
    HARUYUKI_HOME: homeDir,
    LETTA_LOCAL_BACKEND_DIR: storageDir,
    LMSTUDIO_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  });

  const header = [
    "F-04 P1.5 · compaction apply seam",
    `  temp root: ${tmpRoot}${options.keep ? "" : " (removed on exit)"}`,
    "",
  ];

  try {
    const calls = { count: 0 };
    const backend = new LocalBackend({
      storageDir,
      executor: deterministicExecutor(calls),
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Compaction apply gate",
      model: DEFAULT_STUB_MODEL,
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    const conversationId = conversation.id;
    const agentId = agent.id;
    for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
      await sendTurn(
        backend,
        conversationId,
        agentId,
        `turn ${turn} ${"x".repeat(TURN_PADDING_CHARS)}`,
      );
    }
    const marked = backend.markTopic({
      conversationId,
      agentId,
      title: MARKER_TITLE,
      summary: MARKER_SUMMARY,
      createdBy: "user",
    });

    // --- pass 1: preview → pick → apply ------------------------------------
    const messagesBefore = storedMessages(backend, conversationId, agentId);
    const inContextBefore = new Set(
      messagesBefore.map((message) => message.id),
    );
    const statsBeforePrepareOne = provider.stats();
    const previewOne = await backend.prepareCompaction({
      conversationId,
      agentId,
    });
    const statsAfterPrepareOne = provider.stats();
    const preflightOne = [
      ...previewChecks("preview 1", previewOne, inContextBefore),
      check(
        "preview 1: exactly one provider call",
        statsAfterPrepareOne.summarizerRequests ===
          statsBeforePrepareOne.summarizerRequests + 1 &&
          statsAfterPrepareOne.turnRequests === 0,
        `${statsDelta(statsBeforePrepareOne, statsAfterPrepareOne)} request(s)`,
      ),
    ];
    if (preflightOne.some((entry) => !entry.pass)) {
      return {
        kind: "diff",
        report: [
          ...header,
          ...formatChecks(preflightOne),
          "",
          "RESULT: DIFF — the summarizer leg did not produce a usable preview.",
        ].join("\n"),
      };
    }

    const statsBeforeApplyOne = provider.stats();
    const applyOne = await backend.applyCompaction({
      preview: previewOne,
      pick: { kind: "ratio_suggestion" },
    });
    const statsAfterApplyOne = provider.stats();
    const afterOne = storedMessages(backend, conversationId, agentId);

    // --- pass 2: preview → pick → apply ------------------------------------
    const inContextAfterOne = new Set(afterOne.map((message) => message.id));
    const statsBeforePrepareTwo = provider.stats();
    const previewTwo = await backend.prepareCompaction({
      conversationId,
      agentId,
    });
    const statsAfterPrepareTwo = provider.stats();
    const preflightTwo = [
      ...previewChecks("preview 2", previewTwo, inContextAfterOne),
      check(
        "preview 2: exactly one provider call",
        statsAfterPrepareTwo.summarizerRequests ===
          statsBeforePrepareTwo.summarizerRequests + 1 &&
          statsAfterPrepareTwo.turnRequests === 0,
        `${statsDelta(statsBeforePrepareTwo, statsAfterPrepareTwo)} request(s)`,
      ),
    ];
    if (preflightTwo.some((entry) => !entry.pass)) {
      return {
        kind: "diff",
        report: [
          ...header,
          ...formatChecks(preflightOne),
          ...formatChecks(preflightTwo),
          "",
          "RESULT: DIFF — the second summarizer run did not produce a usable preview.",
        ].join("\n"),
      };
    }

    const statsBeforeApplyTwo = provider.stats();
    const applyTwo = await backend.applyCompaction({
      preview: previewTwo,
      pick: { kind: "ratio_suggestion" },
    });
    const statsAfterApplyTwo = provider.stats();
    const finalMessages = storedMessages(backend, conversationId, agentId);

    // --- the six assertions ------------------------------------------------
    const checks: Check[] = [];

    const summaries = finalMessages.flatMap((message) => {
      const packed = packedSummary(message);
      return packed ? [packed] : [];
    });
    checks.push(
      check(
        "context: exactly one `system_alert` user message",
        summaries.length === 1,
        `${summaries.length} system_alert user message(s) among ${finalMessages.length} in-context message(s)`,
      ),
    );
    const writtenText = summaries[0]?.message ?? "";
    const carriesOverview = writtenText.includes(overviewOf(2));
    const carriesJustCut = writtenText.includes(sectionOf(2, 1));
    const omitsKept = !writtenText.includes(sectionOf(2, 2));
    const omitsHistorical = !writtenText.includes(sectionOf(1, 1));
    checks.push(
      check(
        "context: overview + just-cut section only",
        carriesOverview && carriesJustCut && omitsKept && omitsHistorical,
        `overview2=${carriesOverview} just-cut=${carriesJustCut} kept-absent=${omitsKept} historical-absent=${omitsHistorical}`,
      ),
    );

    const rows = await transcriptRows(storageDir, conversationId, agentId);
    const transcriptMessageIds = new Set(
      rows
        .filter((row) => row.type === "message")
        .map((row) => (row.message as { id?: unknown } | undefined)?.id)
        .filter((id): id is string => typeof id === "string"),
    );
    const markers = backend.listTopicMarkers(conversationId, agentId);
    const summarizerMarkers = markers.filter(
      (marker) => marker.createdBy === "summarizer",
    );
    const markerShape = summarizerMarkers.every(
      (marker) =>
        typeof marker.anchorMessageId === "string" &&
        marker.anchorMessageId.length > 0 &&
        transcriptMessageIds.has(marker.anchorMessageId) &&
        typeof marker.summary === "string" &&
        marker.summary.length > 0,
    );
    checks.push(
      check(
        "store: summarizer markers have anchor + summary",
        summarizerMarkers.length === 2 && markerShape,
        summarizerMarkers.length === 0
          ? "no summarizer marker"
          : summarizerMarkers
              .map(
                (marker) =>
                  `"${marker.title}"@${marker.anchorMessageId ?? "null"} (${marker.summary ?? "no summary"})`,
              )
              .join("; "),
      ),
    );
    const markerSections = summarizerMarkers
      .map((marker) => marker.summary)
      .join("|");
    checks.push(
      check(
        "store: summarizer sections are the folded ones",
        markerSections === `${sectionOf(1, 1)}|${sectionOf(2, 1)}`,
        `${markerSections || "none"} (expected ${sectionOf(1, 1)}|${sectionOf(2, 1)})`,
      ),
    );

    const compactionRows = rows
      .filter((row) => row.type === "compaction")
      .map((row) => ({ row, ids: foldedTopicIdsOf(row) }));
    const rowsMatchBackend =
      compactionRows.length === 2 &&
      compactionRows.every(
        (entry) => entry.ids !== undefined && entry.ids.length > 0,
      ) &&
      JSON.stringify(compactionRows[0]?.ids) ===
        JSON.stringify(applyOne.foldedTopicIds) &&
      JSON.stringify(compactionRows[1]?.ids) ===
        JSON.stringify(applyTwo.foldedTopicIds);
    checks.push(
      check(
        "transcript: compaction rows carry folded_topic_ids",
        rowsMatchBackend,
        compactionRows.length === 0
          ? "no compaction row"
          : compactionRows
              .map(
                (entry) =>
                  `row=${entry.ids?.length ?? 0} id(s) [${(entry.ids ?? []).join(", ")}]`,
              )
              .join("; "),
      ),
    );

    const applyOneDelta = statsDelta(statsBeforeApplyOne, statsAfterApplyOne);
    const applyTwoDelta = statsDelta(statsBeforeApplyTwo, statsAfterApplyTwo);
    checks.push(
      check(
        "provider: apply makes no request",
        sameStats(statsBeforeApplyOne, statsAfterApplyOne) &&
          sameStats(statsBeforeApplyTwo, statsAfterApplyTwo),
        `apply 1 delta ${applyOneDelta}; apply 2 delta ${applyTwoDelta}; total ${provider.stats().summarizerRequests} summarizer / ${provider.stats().turnRequests} turn request(s)`,
      ),
    );

    const indexed = queryTopicIndex({
      agentId,
      conversationId,
      storageDir,
    });
    const indexedSummarizer = indexed.filter(
      (entry) => entry.createdBy === "summarizer",
    );
    const indexedSections = indexedSummarizer
      .map((entry) => entry.section)
      .sort()
      .join("|");
    checks.push(
      check(
        "index: queryTopicIndex returns the sections",
        indexedSummarizer.length === 2 &&
          indexedSummarizer.every(
            (entry) =>
              typeof entry.section === "string" && entry.section.length > 0,
          ) &&
          indexedSections ===
            [sectionOf(1, 1), sectionOf(2, 1)].sort().join("|"),
        indexedSummarizer.length === 0
          ? "no indexed summarizer entry"
          : indexedSections,
      ),
    );

    const topicList = backend.listTopics(conversationId, agentId);
    const projected = topicList.blocks.find(
      (block) => block.title === `${titleOf(2)}one`,
    );
    checks.push(
      check(
        "projection: listTopics block carries the section",
        projected?.createdBy === "summarizer" &&
          projected.summary === sectionOf(2, 1),
        projected
          ? `block "${projected.title}" createdBy=${projected.createdBy} summary=${projected.summary ?? "none"}`
          : `no block titled ${titleOf(2)}one (blocks: ${topicList.blocks
              .map((block) => block.title ?? "current")
              .join(", ")})`,
      ),
    );

    // Two extra lines keep the six above honest: each apply really cut one
    // topic, so the "folded vs kept" comparison above is not vacuous.
    checks.unshift(
      check(
        "apply 1: exactly one folded topic",
        applyOne.executed &&
          applyOne.foldedTitles.join("|") === `${titleOf(1)}one`,
        `executed=${applyOne.executed} source=${applyOne.source} folded=[${applyOne.foldedTitles.join(", ")}] ${applyOne.numMessagesBefore}→${applyOne.numMessagesAfter} message(s)`,
      ),
      check(
        "apply 2: exactly one folded topic",
        applyTwo.executed &&
          applyTwo.foldedTitles.join("|") === `${titleOf(2)}one`,
        `executed=${applyTwo.executed} source=${applyTwo.source} folded=[${applyTwo.foldedTitles.join(", ")}] ${applyTwo.numMessagesBefore}→${applyTwo.numMessagesAfter} message(s)`,
      ),
    );

    const failures = checks.filter((entry) => !entry.pass);
    const report = [
      ...header,
      `  conversation: ${conversationId} (${agentId})`,
      `  seeded: ${messagesBefore.length} message(s); marker "${marked.marker.title}" anchored at ${marked.marker.anchorMessageId ?? "null"}`,
      `  prepare 1: topics=${previewOne.topics.length} degraded=${previewOne.degraded ?? "none"} promptTokens=${previewOne.usage.promptTokens} (stub: ${statsAfterPrepareOne.summarizerRequests} summarizer request(s))`,
      `  apply 1:   executed=${applyOne.executed} folded=[${applyOne.foldedTitles.join(", ")}] firstKept=${applyOne.firstKeptMessageId ?? "none"}`,
      `  prepare 2: topics=${previewTwo.topics.length} degraded=${previewTwo.degraded ?? "none"} promptTokens=${previewTwo.usage.promptTokens} (stub: ${statsAfterPrepareTwo.summarizerRequests} summarizer request(s))`,
      `  apply 2:   executed=${applyTwo.executed} folded=[${applyTwo.foldedTitles.join(", ")}] firstKept=${applyTwo.firstKeptMessageId ?? "none"}`,
      `  executor turns: ${calls.count} (the deterministic executor never reaches the provider)`,
      "",
      "apply seam:",
      ...formatChecks(checks),
      "",
      failures.length === 0
        ? "RESULT: PASS — the real summarizer's preview was written back by the real backend."
        : `RESULT: DIFF — ${failures.map((entry) => entry.name).join("; ")}`,
    ].join("\n");
    return { kind: failures.length === 0 ? "pass" : "diff", report };
  } catch (error) {
    return {
      kind: "error",
      report: [
        ...header,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      ].join("\n"),
    };
  } finally {
    restoreEnv();
    provider.stop();
    if (!options.keep) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// --- main ------------------------------------------------------------------

async function main(): Promise<number> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const outcome = await runScenario(options);
    console.log(outcome.report);
    return outcome.kind === "pass" ? 0 : outcome.kind === "diff" ? 1 : 2;
  } catch (error) {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return 2;
  }
}

const exitCode = await main();
process.exit(exitCode);
