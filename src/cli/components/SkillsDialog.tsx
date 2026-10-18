import { Box } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Skill, SkillSource } from "@/agent/skills";
import { estimateTokens } from "@/cli/helpers/format";
import { type KeyBinding, namedKeyChords } from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { appHomeDirName } from "@/utils/app-paths";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

const VISIBLE_ITEMS = 5;

type SkillTab = SkillSource;

const TAB_ORDER: SkillTab[] = ["project", "agent", "global", "bundled"];

const TAB_LABELS: Record<SkillTab, string> = {
  project: "Project",
  agent: "Agent",
  global: "Global",
  bundled: "Bundled",
};

/** Display form of the global skills dir, e.g. `~/.haruyuki/skills/`. */
const GLOBAL_SKILLS_DISPLAY = `~/${appHomeDirName()}/skills/`;

const EMPTY_HINT = `Create skills in .skills/ or ${GLOBAL_SKILLS_DISPLAY}`;

function getTabDescription(tab: SkillTab, agentId: string): string {
  const shortId = agentId.length > 20 ? `${agentId.slice(0, 20)}...` : agentId;
  switch (tab) {
    case "project":
      return ".skills/";
    case "agent":
      return `~/${appHomeDirName()}/agents/${shortId}/memory/skills/`;
    case "global":
      return GLOBAL_SKILLS_DISPLAY;
    case "bundled":
      return "Built-in skills shipped with Haruyuki";
  }
}

interface SkillsDialogProps {
  onClose: () => void;
  agentId: string;
}

/**
 * `/skills`: a read-only scroller with a tab strip.
 *
 * On the toolkit: the chrome is `OverlayFrame`'s and the strip is `TabBar`'s —
 * this face was the last hand-written tab strip in the tree. The keys are a table
 * the router owns rather than an Ink `useInput`, the same move every overlay in
 * this tree is making.
 *
 * One detail is deliberately kept: **the arrows scroll, they do not navigate.**
 * There is no cursor here — the list is a column of names the user reads, with no
 * selection and no Enter — so this face declares its own table instead of using
 * `useOverlayList`, which is exactly what `MemoryTabViewer` does for the same
 * shape. Enter stays unbound, as it was.
 */
export function SkillsDialog({ onClose, agentId }: SkillsDialogProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const { discoverSkills, SKILLS_DIR } = await import("@/agent/skills");
        const { getSkillsDirectory, getSkillSources } = await import(
          "@/agent/context"
        );
        const { join } = await import("node:path");
        const skillsDir =
          getSkillsDirectory() || join(process.cwd(), SKILLS_DIR);
        const result = await discoverSkills(skillsDir, agentId, {
          sources: getSkillSources(),
        });
        setSkills(result.skills);
      } catch {
        setSkills([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [agentId]);

  // Group skills by source
  const skillsBySource = useMemo(() => {
    const grouped = new Map<SkillSource, Skill[]>();
    for (const skill of skills) {
      const list = grouped.get(skill.source) ?? [];
      list.push(skill);
      grouped.set(skill.source, list);
    }
    return grouped;
  }, [skills]);

  // Always show all tabs so users can discover empty sources
  const availableTabs = useMemo(() => [...TAB_ORDER], []);

  const [activeTab, setActiveTab] = useState<SkillTab | null>(null);

  // Set initial tab once skills load
  useEffect(() => {
    if (!loading && availableTabs.length > 0 && activeTab === null) {
      setActiveTab(availableTabs[0] ?? null);
    }
  }, [loading, availableTabs, activeTab]);

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (availableTabs.length === 0) return;
      setActiveTab((current) => {
        const idx = current ? availableTabs.indexOf(current) : 0;
        const next =
          (idx + direction + availableTabs.length) % availableTabs.length;
        return availableTabs[next] ?? current;
      });
      setScrollOffset(0);
    },
    [availableTabs],
  );

  // The strip is drawn from this rather than from `activeTab` directly: the state
  // catches up in an effect one render later, and a strip with no highlighted tab
  // in that frame is a frame the user can see. It resolves to `activeTab` as soon
  // as the effect has run.
  const displayedTab = activeTab ?? availableTabs[0] ?? null;

  const currentSkills = useMemo(
    () => (displayedTab ? (skillsBySource.get(displayedTab) ?? []) : []),
    [displayedTab, skillsBySource],
  );

  const visibleSkills = useMemo(
    () => currentSkills.slice(scrollOffset, scrollOffset + VISIBLE_ITEMS),
    [currentSkills, scrollOffset],
  );

  const maxScrollOffset = Math.max(0, currentSkills.length - VISIBLE_ITEMS);
  const showScrollDown = scrollOffset + VISIBLE_ITEMS < currentSkills.length;
  const itemsBelow = currentSkills.length - scrollOffset - VISIBLE_ITEMS;

  const bindings: KeyBinding[] = [
    {
      id: "skills-dialog.next-tab",
      chords: namedKeyChords("tab", "rightArrow"),
      run: () => {
        cycleTab(1);
        return "consumed";
      },
    },
    {
      id: "skills-dialog.previous-tab",
      chords: namedKeyChords("leftArrow"),
      run: () => {
        cycleTab(-1);
        return "consumed";
      },
    },
    {
      id: "skills-dialog.scroll-down",
      chords: namedKeyChords("downArrow"),
      run: () => {
        setScrollOffset((prev) => Math.min(prev + 1, maxScrollOffset));
        return "consumed";
      },
    },
    {
      id: "skills-dialog.scroll-up",
      chords: namedKeyChords("upArrow"),
      run: () => {
        setScrollOffset((prev) => Math.max(0, prev - 1));
        return "consumed";
      },
    },
    {
      id: "skills-dialog.close",
      chords: [...namedKeyChords("escape"), { key: "c", ctrl: true }],
      run: () => {
        onClose();
        return "consumed";
      },
    },
  ];

  useKeyBindings("skills-dialog", [{ scope: "overlay", bindings }]);

  const getTabLabel = (tab: SkillTab) => {
    const count = skillsBySource.get(tab)?.length ?? 0;
    return `${TAB_LABELS[tab]} [${count}]`;
  };

  // Count currently loaded skills (skills in the loaded_skills memory block)
  // For now, use total count since we don't track loaded state here
  const loadedCount = skills.length;

  return (
    <OverlayFrame
      command="/skills"
      title={`Skills (${loadedCount} currently available)`}
      footer={
        <Text dimColor>{"  "}↑↓ scroll · ←→/Tab switch · Esc to close</Text>
      }
    >
      <Box flexDirection="column" gap={1} marginBottom={1}>
        {loading && (
          <Box paddingLeft={2}>
            <Text dimColor>Loading skills...</Text>
          </Box>
        )}

        {!loading && skills.length === 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor>No skills found</Text>
            <Text dimColor>{EMPTY_HINT}</Text>
          </Box>
        )}

        {!loading && skills.length > 0 && (
          <Box flexDirection="column" paddingLeft={1}>
            {displayedTab && (
              <TabBar
                tabs={availableTabs}
                activeTab={displayedTab}
                getLabel={getTabLabel}
              />
            )}
            {displayedTab && (
              <Text dimColor> {getTabDescription(displayedTab, agentId)}</Text>
            )}
          </Box>
        )}
      </Box>

      {/* Skill list for active tab */}
      {!loading && currentSkills.length > 0 && (
        <Box flexDirection="column">
          {visibleSkills.map((skill) => {
            const tokens = estimateTokens(skill.description);
            return (
              <Text key={skill.id}>
                {"  "}
                {skill.id}
                <Text dimColor> · ~{tokens} description tokens</Text>
              </Text>
            );
          })}
          {showScrollDown ? (
            <Text dimColor>
              {"  "}↓ {itemsBelow} more below
            </Text>
          ) : currentSkills.length > VISIBLE_ITEMS ? (
            <Text> </Text>
          ) : null}
        </Box>
      )}

      {/* Empty state for active tab */}
      {!loading && displayedTab && currentSkills.length === 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>No skills in this location</Text>
        </Box>
      )}
    </OverlayFrame>
  );
}
