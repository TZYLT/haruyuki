import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { getClient } from "./api/client";
import type {
  ForkConversationOptions,
  forkConversation as forkConversationRequest,
} from "./api/conversations";
import { type BackendMode, setConfiguredBackendMode } from "./backend-mode";
import { LocalBackend } from "./local/local-backend";
import {
  getLocalBackendStorageDir as getLocalBackendStorageDirFromPaths,
  LOCAL_BACKEND_EXPERIMENTAL_ENV,
} from "./local/paths";

export type { BackendMode };

export type APIClient = Awaited<ReturnType<typeof getClient>>;

export type ConversationMessageCreateParams = Parameters<
  APIClient["conversations"]["messages"]["create"]
>;
export type ConversationMessageCreateBody = ConversationMessageCreateParams[1];
export type ConversationMessageCreateOptions =
  ConversationMessageCreateParams[2];

export type ConversationMessageStreamParams = Parameters<
  APIClient["conversations"]["messages"]["stream"]
>;
export type ConversationMessageStreamBody = ConversationMessageStreamParams[1];
export type ConversationMessageStreamOptions =
  ConversationMessageStreamParams[2];

export type RunMessageStreamParams = Parameters<
  APIClient["runs"]["messages"]["stream"]
>;
export type RunMessageStreamBody = RunMessageStreamParams[1];
export type RunMessageStreamOptions = RunMessageStreamParams[2];

export type RunRetrieveParams = Parameters<APIClient["runs"]["retrieve"]>;
export type RunRetrieveOptions = RunRetrieveParams[1];

export type AgentRetrieveParams = Parameters<APIClient["agents"]["retrieve"]>;
export type AgentRetrieveOptions = AgentRetrieveParams[1];

export type AgentListParams = Parameters<APIClient["agents"]["list"]>;
export type AgentListBody = AgentListParams[0];

export type AgentDeleteParams = Parameters<APIClient["agents"]["delete"]>;
export type AgentDeleteOptions = AgentDeleteParams[1];

export type AgentUpdateParams = Parameters<APIClient["agents"]["update"]>;
export type AgentUpdateBody = AgentUpdateParams[1];
export type AgentUpdateOptions = AgentUpdateParams[2];

export type AgentCreateParams = Parameters<APIClient["agents"]["create"]>;
export type AgentCreateBody = AgentCreateParams[0];
export type AgentCreateOptions = AgentCreateParams[1];

export type ConversationRetrieveParams = Parameters<
  APIClient["conversations"]["retrieve"]
>;
export type ConversationRetrieveOptions = ConversationRetrieveParams[1];

export type ConversationListParams = Parameters<
  APIClient["conversations"]["list"]
>;
export type ConversationListBody = ConversationListParams[0];

export type ConversationCreateParams = Parameters<
  APIClient["conversations"]["create"]
>;
export type ConversationCreateBody = ConversationCreateParams[0];
export type ConversationCreateOptions = ConversationCreateParams[1];

export type ConversationUpdateParams = Parameters<
  APIClient["conversations"]["update"]
>;
export type ConversationUpdateBody = ConversationUpdateParams[1];
export type ConversationUpdateOptions = ConversationUpdateParams[2];

export type ConversationRecompileParams = Parameters<
  APIClient["conversations"]["recompile"]
>;
export type ConversationRecompileBody = ConversationRecompileParams[1];
export type ConversationRecompileOptions = ConversationRecompileParams[2];

export type ConversationMessageListParams = Parameters<
  APIClient["conversations"]["messages"]["list"]
>;
export type ConversationMessageListBody = ConversationMessageListParams[1];
export type ConversationMessageListOptions = ConversationMessageListParams[2];
export const DEFAULT_CONVERSATION_MESSAGE_ORDER = "desc";

/**
 * The order a transcript read came back in.
 *
 * `"log"` is the transcript **log**'s order: the file's append order, so a
 * compaction's summary sits where the compaction was appended — after the rows it
 * replaced, which is also the order the user watched them arrive in. `"logical"` is
 * the in-context list's order: every summary takes the place of the rows it
 * replaced, so a reader meets it *before* them.
 *
 * The two disagree exactly at a compaction, which is what makes the difference
 * load-bearing rather than cosmetic. Walked backwards, a log-ordered read reaches
 * the conversation's first message; the same walk over the logical order stops at
 * the oldest summary. A caller that cannot tell the two apart reports that stop as
 * the start of the conversation (`已到这次会话的开头`) while the messages the
 * compaction sent away are still unread — measured from the machine as "the
 * transcript will not scroll back past the compaction".
 */
export type TranscriptRowOrder = "log" | "logical";

/**
 * One page of the transcript log, oldest first, with the backend's own statement of
 * the order it read it in.
 *
 * A minimal projection rather than a list, deliberately: a page is a *slice of the
 * log*, and a slice is not the conversation. Read on its own it draws a compaction's
 * summary after the rows it replaced — the order the user saw, and not the order the
 * in-context list draws — so a caller that renders a page directly has to know which
 * of the two orders it holds. `order` is that statement; `older-history.ts` refuses a
 * page that is not `"log"`.
 */
export interface ConversationHistoryPage {
  order: TranscriptRowOrder;
  messages: Message[];
}

export type ConversationMessageCompactParams = Parameters<
  APIClient["conversations"]["messages"]["compact"]
>;
export type ConversationMessageCompactBody =
  ConversationMessageCompactParams[1];
export type ConversationMessageCompactOptions =
  ConversationMessageCompactParams[2];

export type AgentMessageListParams = Parameters<
  APIClient["agents"]["messages"]["list"]
>;
export type AgentMessageListBody = AgentMessageListParams[1];
export type AgentMessageListOptions = AgentMessageListParams[2];

export type MessageRetrieveParams = Parameters<
  APIClient["messages"]["retrieve"]
>;
export type MessageRetrieveOptions = MessageRetrieveParams[1];

export type ModelsListParams = Parameters<APIClient["models"]["list"]>;
export type ModelsListOptions = ModelsListParams[0];

export interface ConversationResumeTailOptions {
  limit: number;
  includeReturnMessageTypes?: string[];
}

export interface ConversationResumeTail {
  conversation?: Awaited<ReturnType<APIClient["conversations"]["retrieve"]>>;
  messages: Message[];
}

/**
 * What the active backend can do.
 *
 * `remoteMemfs` used to say "memory is served by a remote host". The only
 * backend that answered true was the deleted API backend, so the flag is gone
 * rather than left as a constant `false`.
 */
export interface BackendCapabilities {
  promptRecompile: boolean;
  localModelCatalog: boolean;
  localMemfs: boolean;
}

export interface Backend {
  readonly capabilities: BackendCapabilities;

  retrieveAgent(
    agentId: string,
    options?: AgentRetrieveOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["retrieve"]>>>;

  listAgents(
    body?: AgentListBody,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["list"]>>>;

  deleteAgent(
    agentId: string,
    options?: AgentDeleteOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["delete"]>>>;

  updateAgent(
    agentId: string,
    body: AgentUpdateBody,
    options?: AgentUpdateOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["update"]>>>;

  createAgent(
    body: AgentCreateBody,
    options?: AgentCreateOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["create"]>>>;

  retrieveConversation(
    conversationId: string,
    options?: ConversationRetrieveOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["retrieve"]>>>;

  /**
   * Feature ②'s `N`: the message ids still in context for one conversation,
   * resolved against the agent the caller names.
   *
   * It is its own entry rather than a reuse of `retrieveConversation` for two
   * reasons. That call takes no agent scope, so a multi-agent `default`
   * conversation resolves against whichever agent the backend happens to hold as
   * default; and on the local backend it *creates* the conversation when the id
   * is unknown, which is a write. Passive recall reads this on the send path.
   */
  getInContextMessageIds(
    conversationId: string,
    agentId?: string,
  ): Promise<string[]>;

  listConversations(
    body?: ConversationListBody,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["list"]>>>;

  createConversation(
    body: ConversationCreateBody,
    options?: ConversationCreateOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["create"]>>>;

  /**
   * Optional agent-free conversation creation used by SDK query() runtimes.
   * Backends that implement this must preserve `agent_id: null` rather than
   * materializing a hidden worker agent.
   */
  createEphemeralConversation?(body: {
    model: string;
    system: string;
    model_settings?: Record<string, unknown>;
    context_window_limit?: number | null;
    parent_agent_id?: string | null;
    name?: string;
    is_subagent?: boolean;
  }): Promise<Awaited<ReturnType<APIClient["conversations"]["create"]>>>;

  /** Optional: not all backends support deleting conversations. */
  deleteConversation?(
    conversationId: string,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["delete"]>>>;

  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
    options?: ConversationUpdateOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["update"]>>>;

  recompileConversation(
    conversationId: string,
    body?: ConversationRecompileBody,
    options?: ConversationRecompileOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["recompile"]>>>;

  /**
   * `include_out_of_context: true` asks for the conversation as the user saw it:
   * the transcript log itself, which a compaction does not rewrite. Only the local
   * backend answers it; one that does not know the field returns the in-context
   * projection exactly as before, so a caller may always ask. The union keeps every
   * existing caller untouched — an intersection would have made the extra field a
   * weak type and rejected them.
   */
  listConversationMessages(
    conversationId: string,
    body?:
      | ConversationMessageListBody
      | (ConversationMessageListBody & { include_out_of_context: true }),
    options?: ConversationMessageListOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["list"]>>
  >;

  /**
   * Read a page of the transcript **log**, backwards from a stored message id.
   *
   * Optional, like `deleteConversation`: only a backend that owns the transcript can
   * answer it, and only such a backend can page past a compaction. `before` is
   * exclusive — the page holds the rows the log keeps before it — and the page is
   * **oldest first**, so an empty page is the log's own first row.
   *
   * A backend that does not implement this cannot say which order it would have
   * answered in, and the in-context list is not a substitute: its oldest row is a
   * compaction's summary, so a caller that walks it reports the conversation's start
   * where the rows the compaction sent away still are. `older-history.ts` refuses to
   * walk without this method for exactly that reason.
   */
  listConversationHistoryPage?(
    conversationId: string,
    body: { agent_id: string; before: string; limit: number },
  ): Promise<ConversationHistoryPage>;

  compactConversationMessages(
    conversationId: string,
    body?: ConversationMessageCompactBody,
    options?: ConversationMessageCompactOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["compact"]>>
  >;

  listAgentMessages(
    agentId: string,
    body?: AgentMessageListBody,
    options?: AgentMessageListOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["messages"]["list"]>>>;

  retrieveMessage(
    messageId: string,
    options?: MessageRetrieveOptions,
  ): Promise<Awaited<ReturnType<APIClient["messages"]["retrieve"]>>>;

  getConversationResumeTail(
    agentId: string,
    conversationId: string,
    options: ConversationResumeTailOptions,
  ): Promise<ConversationResumeTail>;

  listModels(
    options?: ModelsListOptions,
  ): Promise<Awaited<ReturnType<APIClient["models"]["list"]>>>;

  createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
    options?: ConversationMessageCreateOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["create"]>>
  >;

  streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
    options?: ConversationMessageStreamOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["stream"]>>
  >;

  cancelConversation(
    conversationIdOrAgentId: string,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["cancel"]>>>;

  cancelRun(
    agentId: string,
    runId: string,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["messages"]["cancel"]>>>;

  cancelConversationRun(
    conversationId: string,
    runId?: string | null,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["messages"]["cancel"]>>>;

  retrieveRun(
    runId: string,
    options?: RunRetrieveOptions,
  ): Promise<Awaited<ReturnType<APIClient["runs"]["retrieve"]>>>;

  streamRunMessages(
    runId: string,
    body: RunMessageStreamBody,
    options?: RunMessageStreamOptions,
  ): Promise<Awaited<ReturnType<APIClient["runs"]["messages"]["stream"]>>>;

  forkConversation(
    conversationId: string,
    options?: ForkConversationOptions,
  ): ReturnType<typeof forkConversationRequest>;

  getLocalStorageDir?(): string | undefined;
}

export function getLocalBackendStorageDir(homeDir = homedir()): string {
  return getLocalBackendStorageDirFromPaths(homeDir);
}

function localBackendExecutionMode():
  | "deterministic"
  | "deterministic-reflection"
  | "pi" {
  const configuredMode = process.env.HARUYUKI_LOCAL_BACKEND_EXECUTOR;
  if (configuredMode === "deterministic") return "deterministic";
  if (configuredMode === "deterministic-reflection") {
    return "deterministic-reflection";
  }
  return "pi";
}

function createExperimentalLocalBackend(): Backend {
  return new LocalBackend({
    storageDir: getLocalBackendStorageDir(),
    executionMode: localBackendExecutionMode(),
  });
}

function createInitialBackend(): Backend {
  return createExperimentalLocalBackend();
}

let backend: Backend | null = null;

export function getBackend(): Backend {
  backend ??= createInitialBackend();
  return backend;
}

/**
 * The backend if one already exists, otherwise `null`; never creates one.
 *
 * A caller that only has to *classify* the environment — the tool-declaration
 * gate, for instance — must not force the process-level backend into existence
 * merely to ask whether it is local. The local backend is the only backend, so
 * an absent instance is still classified as local by the caller.
 */
export function peekBackend(): Backend | null {
  return backend;
}

/**
 * Get a backend instance for a specific mode without switching the global
 * backend. There is only one backend, so this is now an alias for creating a
 * local one; the mode argument is kept for callers that still thread it.
 */
export function getBackendForMode(_mode: BackendMode): Backend {
  return createExperimentalLocalBackend();
}

/**
 * Select which *namespace* this process reads and writes, and point the process
 * at the matching backend instance.
 *
 * Namespace selection is not cosmetic: `HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL` is the
 * predicate behind `isLocalBackendEnvEnabled()`, which in turn picks
 *  - the settings bucket (`local:<dir>` vs `api.letta.com`) that namespaces
 *    pins, per-agent settings and last-session refs, and
 *  - the agent memory directory (`<storageDir>/memfs/<agentId>/memory` vs
 *    `~/.haruyuki/agents/<agentId>/memory`).
 *
 * A process that runs the local backend but leaves the variable unset would
 * therefore read and write the legacy Cloud namespace: its local pins and
 * per-agent settings stay invisible, and its memory files land outside the
 * local store. This function is the single writer that keeps the predicate in
 * step with the selected mode, so it must write it — `setConfiguredBackendMode`
 * stays a pure bookkeeping no-op for callers that only thread a value.
 *
 * Passing `"api"` selects the *legacy Cloud* namespace for as long as it is
 * configured. That is only reachable from legacy-Cloud agent/conversation
 * resolution; `--backend` itself can no longer produce it (see
 * `parseBackendModeFlag`).
 */
export function configureBackendMode(mode: BackendMode): void {
  setConfiguredBackendMode(mode);
  process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV] = mode === "local" ? "1" : "0";
  backend = createExperimentalLocalBackend();
}

export function configureEphemeralLocalBackend(): void {
  const stateStorageDir = mkdtempSync(
    join(tmpdir(), "letta-code-ephemeral-local-"),
  );
  backend = new LocalBackend({
    storageDir: getLocalBackendStorageDir(),
    stateStorageDir,
    memfsEnabled: false,
    executionMode: localBackendExecutionMode(),
  });
  process.once("exit", () => {
    rmSync(stateStorageDir, { recursive: true, force: true });
  });
}

export function isLocalBackendEnabled(): boolean {
  return true;
}

function devBackendStoreOptions() {
  return { storageDir: process.env.HARUYUKI_CODE_DEV_BACKEND_DIR };
}

async function createPiDevBackend(): Promise<Backend> {
  const { FakeHeadlessBackend } = await import(
    "@/backend/dev/fake-headless-backend"
  );
  const { PiStreamAdapter } = await import("@/backend/dev/pi-stream-adapter");
  const { ProviderTurnExecutor } = await import(
    "@/backend/dev/provider-turn-executor"
  );
  return new FakeHeadlessBackend(
    "agent-fake-headless",
    new ProviderTurnExecutor(new PiStreamAdapter({})),
    devBackendStoreOptions(),
  );
}

export async function configureDevBackend(name: string): Promise<void> {
  switch (name) {
    case "fake-headless": {
      const { FakeHeadlessBackend } = await import(
        "@/backend/dev/fake-headless-backend"
      );
      backend = new FakeHeadlessBackend(
        undefined,
        undefined,
        devBackendStoreOptions(),
      );
      return;
    }
    case "fake-headless-tool-call": {
      const { FakeHeadlessBackend } = await import(
        "@/backend/dev/fake-headless-backend"
      );
      const { DeterministicToolCallExecutor } = await import(
        "@/backend/dev/headless-turn-executor"
      );
      backend = new FakeHeadlessBackend(
        "agent-fake-headless",
        new DeterministicToolCallExecutor(),
        devBackendStoreOptions(),
      );
      return;
    }
    case "fake-headless-provider": {
      const { FakeHeadlessBackend } = await import(
        "@/backend/dev/fake-headless-backend"
      );
      const { ProviderTurnExecutor } = await import(
        "@/backend/dev/provider-turn-executor"
      );
      backend = new FakeHeadlessBackend(
        "agent-fake-headless",
        new ProviderTurnExecutor(),
        devBackendStoreOptions(),
      );
      return;
    }
    case "fake-headless-pi": {
      backend = await createPiDevBackend();
      return;
    }
    default:
      throw new Error(`Unknown --dev-backend value "${name}"`);
  }
}

export function __testSetBackend(nextBackend: Backend | null): void {
  backend = nextBackend ?? createInitialBackend();
}
