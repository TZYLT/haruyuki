/**
 * Conversation-scoped settings cleanup for a deleted local conversation
 * (F-01 M2, requirement §5.4.4).
 *
 * Deleting the directory is not enough: a conversation also owns a manual
 * toolset override, client preferences, and possibly the "last session" pointer
 * both settings layers keep. Left behind, the pointer would resume an id that no
 * longer exists and the override would sit in the settings file forever.
 *
 * Cleanup runs **after** the record is gone and is idempotent, so a failure here
 * is a log line, never a rollback: the conversation is already deleted and the
 * next delete of the same id is the caller's error, not a retry.
 */
import {
  type LocalProjectSettings,
  type SessionRef,
  type Settings,
  settingsManager,
} from "@/settings-manager";
import { debugWarn } from "@/utils/debug";

export interface DeletedConversationSettings {
  agentId: string;
  /** Agent-free conversations have a synthetic agent id and no settings row. */
  agentFree: boolean;
  conversationId: string;
  /** Defaults to the process working directory, where sessions are recorded. */
  workingDirectory?: string;
}

/**
 * Drop every settings key that only meant something while the conversation
 * existed. Never throws.
 */
export async function deleteLocalConversationSettings(
  input: DeletedConversationSettings,
): Promise<void> {
  if (input.agentFree) return;
  const workingDirectory = input.workingDirectory ?? process.cwd();
  try {
    // Both writers are no-ops when the key is already absent, which is what
    // makes this safe to run for a conversation that never had an override.
    settingsManager.setToolsetPreference(
      input.agentId,
      "auto",
      input.conversationId,
    );
    settingsManager.setClientPreferences(
      input.agentId,
      input.conversationId,
      {},
    );
    clearGlobalSessionPointers(input.agentId, input.conversationId);
    clearLocalSessionPointers(
      input.agentId,
      input.conversationId,
      workingDirectory,
    );
    await settingsManager.flush();
  } catch (error) {
    debugWarn(
      "local-backend",
      "conversation settings cleanup failed for %s: %o",
      input.conversationId,
      error,
    );
  }
}

function clearGlobalSessionPointers(
  agentId: string,
  conversationId: string,
): void {
  const settings = settingsManager.getSettings();
  const updates: Partial<Settings> = {};
  const sessionsByServer = withoutDeletedSession(
    settings.sessionsByServer,
    agentId,
    conversationId,
  );
  if (sessionsByServer) updates.sessionsByServer = sessionsByServer;
  if (pointsAtSession(settings.lastSession, agentId, conversationId)) {
    updates.lastSession = undefined;
  }
  if (Object.keys(updates).length > 0) settingsManager.updateSettings(updates);
}

function clearLocalSessionPointers(
  agentId: string,
  conversationId: string,
  workingDirectory: string,
): void {
  let settings: LocalProjectSettings;
  try {
    settings = settingsManager.getLocalProjectSettings(workingDirectory);
  } catch {
    // No local project settings are loaded for this directory (headless runs,
    // tests, a working directory without a `.haruyuki` layer). Nothing to clear.
    return;
  }
  const updates: Partial<LocalProjectSettings> = {};
  const sessionsByServer = withoutDeletedSession(
    settings.sessionsByServer,
    agentId,
    conversationId,
  );
  if (sessionsByServer) updates.sessionsByServer = sessionsByServer;
  if (pointsAtSession(settings.lastSession, agentId, conversationId)) {
    updates.lastSession = undefined;
  }
  if (Object.keys(updates).length === 0) return;
  settingsManager.updateLocalProjectSettings(updates, workingDirectory);
}

/** The server-keyed map without the deleted session, or `undefined` if intact. */
function withoutDeletedSession(
  sessionsByServer: Record<string, SessionRef> | undefined,
  agentId: string,
  conversationId: string,
): Record<string, SessionRef> | undefined {
  if (!sessionsByServer) return undefined;
  const kept = Object.entries(sessionsByServer).filter(
    ([, session]) => !pointsAtSession(session, agentId, conversationId),
  );
  if (kept.length === Object.keys(sessionsByServer).length) return undefined;
  return Object.fromEntries(kept);
}

/**
 * A pointer only matters when it names both this agent and this conversation: a
 * session for another agent that happens to reuse the id (agent ids are
 * server-scoped) must survive.
 */
function pointsAtSession(
  session: SessionRef | null | undefined,
  agentId: string,
  conversationId: string,
): boolean {
  return (
    session != null &&
    session.agentId === agentId &&
    session.conversationId === conversationId
  );
}
