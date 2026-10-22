import { HelpDialog } from "@/cli/components/HelpDialog";
import { HooksManager } from "@/cli/components/HooksManager";
import { MessageHistoryOverlay } from "@/cli/components/MessageHistoryOverlay";
import { SkillsDialog } from "@/cli/components/SkillsDialog";
import { TabsOverlay } from "@/cli/components/TabsOverlay";
import type { ActiveOverlay, TabStripProjection } from "./types";

/**
 * The faces that need nothing but "close me" and an agent id.
 *
 * `AppView` mounts a dozen overlays, and most of them take their data from state
 * that lives there. These five do not: `/help` and `/hooks` are self-contained
 * readers, `/skills` needs the agent, `/tabs` needs the strip's actions, and the
 * message history reads its own store. Grouping them keeps that fact visible —
 * "these are the ones with no wiring" — and keeps the view's render body about the
 * overlays that *do* have wiring.
 *
 * `/message-history` is reachable only from the full-screen shell (the shell
 * registers both its leader chord and its command), so being mounted here does not
 * give the append shell a face it cannot open.
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
    </>
  );
}
