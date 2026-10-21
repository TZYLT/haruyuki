import { HelpDialog } from "@/cli/components/HelpDialog";
import { HooksManager } from "@/cli/components/HooksManager";
import { SkillsDialog } from "@/cli/components/SkillsDialog";
import { TabsOverlay } from "@/cli/components/TabsOverlay";
import type { ActiveOverlay, TabStripProjection } from "./types";

/**
 * The faces that need nothing but "close me" and an agent id.
 *
 * `AppView` mounts a dozen overlays, and most of them take their data from state
 * that lives there. These four do not: `/help` and `/hooks` are self-contained
 * readers, `/skills` needs the agent, and `/tabs` needs the strip's actions. Grouping
 * them keeps that fact visible — "these are the ones with no wiring" — and keeps the
 * view's render body about the overlays that *do* have wiring.
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
    </>
  );
}
