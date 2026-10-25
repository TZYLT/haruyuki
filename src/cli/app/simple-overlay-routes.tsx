import { HelpDialog } from "@/cli/components/HelpDialog";
import { HiddenSessionsOverlay } from "@/cli/components/HiddenSessionsOverlay";
import { HooksManager } from "@/cli/components/HooksManager";
import { MessageHistoryOverlay } from "@/cli/components/MessageHistoryOverlay";
import { SkillsDialog } from "@/cli/components/SkillsDialog";
import { TabsOverlay } from "@/cli/components/TabsOverlay";
import type { ActiveOverlay, TabStripProjection } from "./types";

/**
 * The faces that need nothing but "close me" and an agent id.
 *
 * `AppView` mounts a dozen overlays, and most of them take their data from state
 * that lives there. These six do not: `/help` and `/config hooks` are self-contained
 * readers, `/skills` needs the agent, `/tabs` needs the strip's actions, the
 * message history reads its own store, and `/maintenance sessions` pages the
 * hidden-conversation list straight off the backend. Grouping them keeps that
 * fact visible — "these are the ones with no wiring" — and keeps the view's
 * render body about the overlays that *do* have wiring.
 *
 * `/messages history` and `/maintenance sessions` are reachable only from the
 * full-screen shell (the shell registers their commands), so being mounted here
 * does not give the append shell a face it cannot open.
 */
export function SimpleOverlayRoutes({
  activeOverlay,
  onClose,
  agentId,
  tabStrip,
}: {
  activeOverlay: ActiveOverlay;
  /** Dismiss the face (the shared cancel path, which finishes its command row). */
  onClose: () => void;
  agentId: string;
  tabStrip: TabStripProjection;
}) {
  return (
    <>
      {activeOverlay === "help" && <HelpDialog onClose={onClose} />}
      {activeOverlay === "skills" && (
        <SkillsDialog onClose={onClose} agentId={agentId} />
      )}
      {activeOverlay === "hooks" && <HooksManager onClose={onClose} />}
      {/* The keyboard's door to the tab strip (《38》§3.2): `↑↓`, Enter, `D`. */}
      {activeOverlay === "tabs" && (
        <TabsOverlay actions={tabStrip} onDismiss={onClose} />
      )}
      {/* What the toast band announced, kept (`docs/38` §15.4): read-only. */}
      {activeOverlay === "message-history" && (
        <MessageHistoryOverlay onClose={onClose} />
      )}
      {/* Background sessions, read-only (`docs/44-1` §5.2): never a switch. */}
      {activeOverlay === "hidden-sessions" && (
        <HiddenSessionsOverlay agentId={agentId} onClose={onClose} />
      )}
    </>
  );
}
