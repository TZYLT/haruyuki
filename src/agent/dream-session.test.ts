/**
 * The dream run's hidden conversation (F-06 Q-37 / Q-53).
 *
 * The helper is small but its contract is what the whole feature's visibility
 * rests on: the conversation must be hidden, standalone and marked
 * `origin: "dream"`, so the viewer can group it and no other surface (resume,
 * search, recall) picks it up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDreamRunMetadata } from "@/agent/dream-run-metadata";
import {
  buildDreamSessionCreateBody,
  createDreamSession,
} from "@/agent/dream-session";
import { __testSetBackend } from "@/backend";
import { DeterministicPongExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { readConversationProvenance } from "@/types/conversation-provenance";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

let root: string | undefined;

afterEach(async () => {
  __testSetBackend(null);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("buildDreamSessionCreateBody", () => {
  test("hidden, standalone, origin=dream, owned by the main agent", () => {
    const body = buildDreamSessionCreateBody({
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(body).toMatchObject({
      agent_id: "agent-1",
      summary: "Dream run run-1",
      hidden: true,
      origin: "dream",
      context_mode: "standalone",
    });
  });
});

describe("createDreamSession", () => {
  test("creates a hidden standalone conversation that keeps its provenance", async () => {
    root = await mkdtemp(join(tmpdir(), "haruyuki-dream-session-"));
    const backend = new LocalBackend({
      storageDir: join(root, "store"),
      executor: new DeterministicPongExecutor(),
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({ name: "Dream session test" });

    const session = await createDreamSession({
      agentId: agent.id,
      runId: "run-1",
    });
    const conversation = await backend.retrieveConversation(
      session.conversationId,
    );
    const provenance = readConversationProvenance(conversation);

    expect(provenance).toMatchObject({
      origin: "dream",
      context_mode: "standalone",
    });
    expect((conversation as unknown as { hidden?: boolean }).hidden).toBe(true);

    const metadata: DreamRunMetadata = {
      runId: "run-1",
      triggerSource: "manual",
      agentId: agent.id,
      conversationId: session.conversationId,
      tierPlan: ["tidy"],
      tierReached: null,
      startedAt: 1_700_000_000_000,
      endedAt: null,
      baselineSha: "0123456789abcdef0123456789abcdef01234567",
      budgetTokens: 10_000,
      spentTokens: 0,
      timeLimitMinutes: null,
      status: "running",
      reportPath: null,
      handoff: null,
    };
    await writeDreamRunMetadata({
      conversationId: session.conversationId,
      metadata,
    });
    const updated = await backend.retrieveConversation(session.conversationId);
    expect(readConversationProvenance(updated).dream).toEqual(metadata);
  });
});
