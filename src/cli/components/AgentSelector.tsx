import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AgentBackendMode, isLocalAgentId } from "@/agent/agent-id";
import { unpinAgentForCurrentUser } from "@/agent/favorites";
import { getBackendForMode } from "@/backend/backend";
import { type KeyBinding, namedKeyChords } from "@/cli/helpers/input-keys";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import {
  listPinnedAgentsForCurrentUser,
  type PinnedAgentData,
} from "@/cli/helpers/pinned-agent-listing";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { AgentSelectorFooter } from "./AgentSelectorFooter";
import { AgentDeleteConfirmOverlay } from "./AgentSelectorViews";
import {
  AGENT_SELECTOR_TAB_DESCRIPTIONS,
  AGENT_SELECTOR_TAB_EMPTY_STATES,
  type AgentSelectorListAgent,
  type AgentSelectorTabId,
  formatAgentMemoryBlockCount,
  formatAgentModel,
  formatRelativeTime,
  getVisibleAgentSelectorTabs,
  truncateAgentId,
} from "./agent-selector-utils";
import { colors } from "./colors";
import { validateAgentName } from "./PinDialog";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

interface AgentSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string, backendMode: AgentBackendMode) => void;
  onCancel: () => void;
  onLogin?: () => void;
  /** Called when user creates a new agent (from New tab or N shortcut) */
  onCreateNewAgent?: (name: string, backendMode: AgentBackendMode) => void;
  /** The command that triggered this selector (e.g., "/agents" or "/resume") */
  command?: string;
  /** Override the overlay title. */
  title?: string;
  /** Whether to show the New tab and N shortcut. */
  showNewTab?: boolean;
  /** Whether Shift+D can delete agents from the selector. */
  allowDelete?: boolean;
  /** Whether Shift+P can unpin agents from the selector. */
  allowPinActions?: boolean;
}

/**
 * `/agent list`'s two screens. The trail is the wizard's, so Escape backs out of the
 * typed-name confirmation and cancels at the list — the two answers the face
 * used to write itself (`setViewState({ type: "list" })` versus `onCancel`).
 */
type AgentSelectorStep = "list" | "deleteConfirm";

/** The agent a confirmation was opened on, kept out of the trail. */
interface PendingDelete {
  agent: AgentState;
  agentId: string;
  isLocal: boolean;
}

const DISPLAY_PAGE_SIZE = 5;

/**
 * The agent browser, on the overlay toolkit.
 *
 * The face keeps its **page** shape: five rows per page, `Page n/m` in the
 * footer, ←/→ to turn the page and a cursor that stays inside the page. The
 * toolkit's window is opt-in (`overlay/README.md` rule 4) and this face asks for
 * none — what it takes from the toolkit is the key table (`useOverlayList` over
 * the page's rows, the wizard for the two screens) instead of the one
 * `if (key.upArrow) … else if` ladder that used to hold both screens' keys.
 *
 * Two lists rather than one, because Pinned and Local each keep their own cursor
 * across a tab switch — the shape `/config hooks` has, for the same reason.
 *
 * What changed visibly, and both were ruled on:
 *
 * - the **search row is gone**. It was dead: `activeQuery` was only ever
 *   compared and painted, never used to filter a pinned or a local page (it
 *   outlived the Cloud/Shared tabs, which were the lists that had something to
 *   search). Typing on the Local tab showed `Search: foo` and filtered nothing.
 * - the two hand-rolled appenders (the delete confirmation's typed name and the
 *   New tab's name field) are the toolkit's editor now. The delete row keeps its
 *   `> ` marker and its wording; what it gains is a caret and the paste channel
 *   — a paste into it used to be dropped silently. The caret is inverse video,
 *   which a test process cannot see (no colour): `docs/36` M8 carries it for the
 *   real machine.
 */
export function AgentSelector({
  currentAgentId,
  onSelect,
  onCancel,
  onCreateNewAgent,
  command = "/agents",
  title = "Swap to a different agent",
  showNewTab = true,
  allowDelete = true,
  allowPinActions = true,
}: AgentSelectorProps) {
  const terminalWidth = useTerminalWidth();

  // Tab state
  // Eagerly check for local agents (synchronous disk read) to determine tab visibility
  const [hasLocalAgents, setHasLocalAgents] = useState(() => {
    try {
      return listLocalAgentsFromDisk().length > 0;
    } catch {
      return false;
    }
  });

  // Compute visible tabs — Local tab only shown when there are local agents
  const visibleTabs = useMemo(
    () => getVisibleAgentSelectorTabs({ showNewTab, hasLocalAgents }),
    [hasLocalAgents, showNewTab],
  );

  const [activeTab, setActiveTab] = useState<AgentSelectorTabId>("pinned");

  // If active tab is no longer visible (e.g. local tab hidden after deleting all
  // local agents), fall back to Pinned.
  useEffect(() => {
    if (activeTab === "local" && !hasLocalAgents) {
      setActiveTab("pinned");
    } else if (activeTab === "new" && !showNewTab) {
      setActiveTab("pinned");
    }
  }, [activeTab, hasLocalAgents, showNewTab]);

  // Pinned tab state
  const [pinnedAgents, setPinnedAgents] = useState<PinnedAgentData[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(true);
  const [pinnedPage, setPinnedPage] = useState(0);

  // Local tab state (reads from disk, no API calls)
  const [localAgents, setLocalAgents] = useState<AgentState[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localPage, setLocalPage] = useState(0);
  const [localLoaded, setLocalLoaded] = useState(false);

  // Delete confirmation state
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  // New agent tab state
  const [newAgentNameInput, setNewAgentNameInput] = useState("");
  const [newAgentNameError, setNewAgentNameError] = useState("");

  const wizard = useWizard<AgentSelectorStep>({ initial: "list" });
  const { canGoBack, back, goTo, popTo, step } = wizard;

  // Load pinned agents
  const loadPinnedAgents = useCallback(async () => {
    setPinnedLoading(true);
    try {
      const pinnedData = await listPinnedAgentsForCurrentUser();
      const validPinnedData = pinnedData.filter((p) => p.agent !== null);

      if (validPinnedData.length === 0) {
        setPinnedAgents([]);
        setPinnedLoading(false);
        return;
      }

      setPinnedAgents(pinnedData);
    } catch {
      setPinnedAgents([]);
    } finally {
      setPinnedLoading(false);
    }
  }, []);

  // Load local agents from disk
  const loadLocalAgents = useCallback(() => {
    setLocalLoading(true);
    try {
      const agents = listLocalAgentsFromDisk();
      setLocalAgents(agents);
      setHasLocalAgents(agents.length > 0);
      setLocalPage(0);
      setLocalLoaded(true);
    } catch {
      setLocalAgents([]);
      setHasLocalAgents(false);
    } finally {
      setLocalLoading(false);
    }
  }, []);

  // Load pinned agents on mount
  useEffect(() => {
    loadPinnedAgents();
  }, [loadPinnedAgents]);

  // Load tab data when switching tabs (only if not already loaded)
  useEffect(() => {
    if (activeTab === "local" && !localLoaded && !localLoading) {
      loadLocalAgents();
    }
  }, [activeTab, localLoaded, localLoading, loadLocalAgents]);

  // Pagination calculations - Pinned (filter out 404 agents)
  const validPinnedAgents = pinnedAgents.filter((p) => p.agent !== null);
  const pinnedTotalPages = Math.ceil(
    validPinnedAgents.length / DISPLAY_PAGE_SIZE,
  );
  const pinnedStartIndex = pinnedPage * DISPLAY_PAGE_SIZE;
  const pinnedPageAgents = validPinnedAgents.slice(
    pinnedStartIndex,
    pinnedStartIndex + DISPLAY_PAGE_SIZE,
  );

  // Pagination calculations - Local (current agent pinned to top)
  const sortedLocalAgents = useMemo(
    () =>
      localAgents.toSorted((a, b) => {
        if (a.id === currentAgentId) return -1;
        if (b.id === currentAgentId) return 1;
        return 0;
      }),
    [localAgents, currentAgentId],
  );
  const localTotalPages = Math.ceil(
    sortedLocalAgents.length / DISPLAY_PAGE_SIZE,
  );
  const localStartIndex = localPage * DISPLAY_PAGE_SIZE;
  const localPageAgents = sortedLocalAgents.slice(
    localStartIndex,
    localStartIndex + DISPLAY_PAGE_SIZE,
  );

  // Current tab's state (computed)
  let currentLoading = false;
  let currentAgents: AgentSelectorListAgent[] = [];
  if (activeTab === "pinned") {
    currentLoading = pinnedLoading;
    currentAgents = pinnedPageAgents
      .map((p) => p.agent)
      .filter((agent): agent is AgentState => agent !== null);
  } else if (activeTab === "local") {
    currentLoading = localLoading;
    currentAgents = localPageAgents;
  }

  // A page is "listed" when the trail is on the list step and the tab has rows
  // to put a cursor on. The New tab is neither: its editor owns the keys.
  const listActive = step === "list" && activeTab !== "new";

  const pinnedItems: OverlayListItem[] = pinnedPageAgents.map((data) => ({
    key: data.agentId,
    label: data.agent?.name ?? data.agentId.slice(0, 12),
  }));

  const localItems: OverlayListItem[] = localPageAgents.map((agent) => ({
    key: agent.id,
    label: agent.name ?? "Unnamed",
  }));

  // The Pinned tab's cursor. Omitted `onCancel`: Escape and Ctrl+C are the
  // wizard's here (`wizard.tsx`), because this face has two screens.
  const pinnedList = useOverlayList({
    owner: "agent-selector-pinned",
    items: pinnedItems,
    navigationEnabled: listActive && activeTab === "pinned",
    onConfirm: (_key, index) => {
      const selected = pinnedPageAgents[index];
      if (selected?.agent) {
        onSelect(selected.agentId, selected.backendMode);
      }
    },
    onCancel: undefined,
  });

  const localList = useOverlayList({
    owner: "agent-selector-local",
    items: localItems,
    navigationEnabled: listActive && activeTab === "local",
    onConfirm: (_key, index) => {
      const selected = localPageAgents[index];
      if (selected?.id) {
        onSelect(selected.id, "local");
      }
    },
    onCancel: undefined,
  });

  /** Turn one page, or decline at either end (which is what the face did). */
  const turnPage = useCallback(
    (delta: 1 | -1) => {
      if (activeTab === "pinned") {
        const next = pinnedPage + delta;
        if (next < 0 || next > pinnedTotalPages - 1) return "declined";
        setPinnedPage(next);
        pinnedList.setCursor(0);
        return "consumed";
      }
      if (activeTab === "local") {
        const next = localPage + delta;
        if (next < 0 || next > localTotalPages - 1) return "declined";
        setLocalPage(next);
        localList.setCursor(0);
        return "consumed";
      }
      return "declined";
    },
    [
      activeTab,
      localList,
      localPage,
      localTotalPages,
      pinnedList,
      pinnedPage,
      pinnedTotalPages,
    ],
  );

  // Every key that is not the list's own: the tabs, the page turn, the three
  // shortcuts, and the New tab's Escape. All of them decline when they do not
  // apply, so the list's table (or the wizard's rule) still receives the key.
  //
  // `D` and `P` carry a chord for each encoding of the shift and then check the
  // letter itself: the chord matcher is case-insensitive, so without that check a
  // bare `d` would open the delete confirmation and a bare `p` would unpin the row
  // under the cursor. Both sit behind Shift, which is what the footer has always
  // advertised (`Shift+D delete`, `Shift+P unpin`).
  const selectorExtras: KeyBinding[] = [
    {
      id: "agent-selector.new-tab-escape",
      chords: namedKeyChords("escape"),
      run: () => {
        if (activeTab !== "new" || !newAgentNameInput) return "declined";
        setNewAgentNameInput("");
        setNewAgentNameError("");
        return "consumed";
      },
    },
    {
      id: "agent-selector.cycle-tab",
      chords: namedKeyChords("tab"),
      run: () => {
        if (!listActive) return "declined";
        const currentIndex = visibleTabs.findIndex((t) => t.id === activeTab);
        const nextIndex = (currentIndex + 1) % visibleTabs.length;
        setActiveTab(visibleTabs[nextIndex]?.id ?? "pinned");
        return "consumed";
      },
    },
    {
      id: "agent-selector.turn-page",
      chords: [...namedKeyChords("leftArrow"), ...namedKeyChords("rightArrow")],
      run: ({ key }) => {
        if (!listActive) return "declined";
        return turnPage(key.leftArrow ? -1 : 1);
      },
    },
    {
      id: "agent-selector.unpin",
      chords: [{ key: "p" }, { key: "p", shift: true }],
      run: ({ input }) => {
        if (input !== "P") return "declined";
        if (!listActive || !allowPinActions || activeTab !== "pinned") {
          return "declined";
        }
        const selected = pinnedPageAgents[pinnedList.cursor];
        if (!selected) return "declined";
        const backend = getBackendForMode(selected.backendMode);
        void unpinAgentForCurrentUser(selected.agentId, backend).finally(() => {
          loadPinnedAgents();
        });
        return "consumed";
      },
    },
    {
      id: "agent-selector.delete",
      chords: [{ key: "d" }, { key: "d", shift: true }],
      run: ({ input }) => {
        if (input !== "D") return "declined";
        if (!listActive || !allowDelete) return "declined";
        if (activeTab === "pinned") {
          const selected = pinnedPageAgents[pinnedList.cursor];
          if (!selected?.agent) return "declined";
          setPendingDelete({
            agent: selected.agent,
            agentId: selected.agentId,
            isLocal: selected.backendMode === "local",
          });
        } else if (activeTab === "local") {
          const selected = localPageAgents[localList.cursor];
          if (!selected?.id) return "declined";
          setPendingDelete({
            agent: selected,
            agentId: selected.id,
            isLocal: true,
          });
        } else {
          return "declined";
        }
        setDeleteConfirmInput("");
        goTo("deleteConfirm");
        return "consumed";
      },
    },
    {
      id: "agent-selector.new-tab",
      chords: [{ key: "n" }, { key: "n", shift: true }],
      run: () => {
        if (!listActive || !showNewTab) return "declined";
        setActiveTab("new");
        return "consumed";
      },
    },
  ];

  useKeyBindings("agent-selector-keys", [
    {
      scope: "overlay",
      bindings: [
        ...selectorExtras,
        ...wizardBindings({
          canGoBack,
          onBack: () => {
            setPendingDelete(null);
            setDeleteConfirmInput("");
            back();
          },
          onCancel,
        }),
      ],
    },
  ]);

  // Handle agent deletion
  const handleDeleteAgent = useCallback(async () => {
    if (!pendingDelete) return;
    const { agent, agentId, isLocal } = pendingDelete;
    const expectedName = agent.name || agentId.slice(0, 12);

    if (deleteConfirmInput !== expectedName) return;

    setDeleteLoading(true);
    try {
      // One backend serves every mode; the mode only names the pin namespace.
      const backend = getBackendForMode(isLocal ? "local" : "api");
      await backend.deleteAgent(agentId);

      // Reset state and refresh tabs
      setPendingDelete(null);
      setDeleteConfirmInput("");
      popTo("list");
      // Reload pinned and invalidate cached tabs
      loadPinnedAgents();
      setLocalLoaded(false);
    } catch {
      // Stay on confirmation screen on error
    } finally {
      setDeleteLoading(false);
    }
  }, [pendingDelete, deleteConfirmInput, loadPinnedAgents, popTo]);

  // Render agent item (shared between tabs)
  const renderAgentItem = (
    agent: AgentSelectorListAgent,
    _index: number,
    isSelected: boolean,
    extra?: { backend?: "local" | "cloud" | "shared" },
  ) => {
    const isCurrent = agent.id === currentAgentId;
    const isLocalAgent = isLocalAgentId(agent.id);
    const relativeTime = formatRelativeTime(agent.last_run_completion);
    const blockCountText = formatAgentMemoryBlockCount(agent.blocks?.length);
    const modelStr = formatAgentModel(agent);
    const metadataParts = [relativeTime];
    if (!isLocalAgent && extra?.backend !== "shared") {
      if (blockCountText) {
        metadataParts.push(blockCountText);
      }
      metadataParts.push(modelStr);
    }
    if (extra?.backend === "shared" && agent.creator?.name) {
      metadataParts.push(`Shared by ${agent.creator.name}`);
    }

    const nameLen = (agent.name || "Unnamed").length;
    const fixedChars = 2 + 3 + (isCurrent ? 10 : 0);
    const availableForId = Math.max(15, terminalWidth - nameLen - fixedChars);
    const displayId = truncateAgentId(agent.id, availableForId);

    let backendLabel = "";
    if (extra?.backend === "local") {
      backendLabel = "Local · ";
    } else if (extra?.backend === "cloud") {
      backendLabel = "Cloud · ";
    } else if (extra?.backend === "shared") {
      backendLabel = "Shared · ";
    }

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {isSelected ? ">" : " "}
          </Text>
          <Text> </Text>
          <Text
            bold={isSelected}
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {agent.name || "Unnamed"}
          </Text>
          <Text dimColor>
            {" · "}
            {backendLabel}
            {displayId}
          </Text>
          {isCurrent && (
            <Text color={colors.selector.itemCurrent}> (current)</Text>
          )}
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor italic>
            {agent.description || "No description"}
          </Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>{metadataParts.join(" · ")}</Text>
        </Box>
      </Box>
    );
  };

  // Render pinned agent item (may have error)
  const renderPinnedItem = (
    data: PinnedAgentData,
    index: number,
    isSelected: boolean,
  ) => {
    if (data.agent) {
      return renderAgentItem(data.agent, index, isSelected, {});
    }

    // Error state for missing agent
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {isSelected ? ">" : " "}
          </Text>
          <Text> </Text>
          <Text
            bold={isSelected}
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {data.agentId.slice(0, 12)}
          </Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text color="red" italic>
            {data.error}
          </Text>
        </Box>
      </Box>
    );
  };

  // If in delete confirmation view, render that instead of the list
  if (step === "deleteConfirm" && pendingDelete) {
    const displayName =
      pendingDelete.agent.name || pendingDelete.agentId.slice(0, 12);
    return (
      <AgentDeleteConfirmOverlay
        command={command}
        displayName={displayName}
        input={deleteConfirmInput}
        loading={deleteLoading}
        onInputChange={setDeleteConfirmInput}
        onInputSubmit={handleDeleteAgent}
      />
    );
  }

  return (
    <OverlayFrame
      command={command}
      title={title}
      footer={
        activeTab !== "new" &&
        !currentLoading &&
        (activeTab === "pinned" || currentAgents.length > 0) ? (
          <AgentSelectorFooter
            terminalWidth={terminalWidth}
            activeTab={activeTab}
            pinnedPage={pinnedPage}
            pinnedTotalPages={pinnedTotalPages}
            pinnedAgentsCount={validPinnedAgents.length}
            localPage={localPage}
            localTotalPages={localTotalPages}
            allowDelete={allowDelete}
            allowPinActions={allowPinActions}
            hasSelectedPinnedAgent={
              pinnedPageAgents[pinnedList.cursor] !== undefined
            }
          />
        ) : undefined
      }
    >
      <Box flexDirection="column" paddingLeft={1}>
        <TabBar
          tabs={visibleTabs.map((t) => t.id)}
          activeTab={activeTab}
          getLabel={(tabId) =>
            visibleTabs.find((t) => t.id === tabId)?.label ?? tabId
          }
        />
        <Text dimColor> {AGENT_SELECTOR_TAB_DESCRIPTIONS[activeTab]}</Text>
        <Box height={1} />
      </Box>

      {/* Loading state */}
      {currentLoading && (
        <Box>
          <Text dimColor>{"  "}Loading agents...</Text>
        </Box>
      )}

      {/* Empty state */}
      {!currentLoading &&
        ((activeTab === "pinned" && validPinnedAgents.length === 0) ||
          (activeTab === "local" && currentAgents.length === 0)) && (
          <Box
            flexDirection="column"
            paddingLeft={activeTab === "pinned" ? 2 : 0}
          >
            <Text dimColor>{AGENT_SELECTOR_TAB_EMPTY_STATES[activeTab]}</Text>
            {activeTab !== "pinned" && (
              <Text dimColor>Press ESC to cancel</Text>
            )}
          </Box>
        )}

      {/* Pinned tab content */}
      {activeTab === "pinned" &&
        !pinnedLoading &&
        validPinnedAgents.length > 0 && (
          <OverlayListView
            items={pinnedItems}
            cursor={pinnedList.cursor}
            renderRow={(_item, index, isCursor) => {
              const data = pinnedPageAgents[index];
              if (!data) return null;
              return renderPinnedItem(data, index, isCursor);
            }}
          />
        )}

      {/* Local tab content */}
      {activeTab === "local" && !localLoading && localAgents.length > 0 && (
        <OverlayListView
          items={localItems}
          cursor={localList.cursor}
          renderRow={(_item, index, isCursor) => {
            const agent = localPageAgents[index];
            if (!agent) return null;
            return renderAgentItem(agent, index, isCursor, {
              backend: "local",
            });
          }}
        />
      )}

      {/* New tab content */}
      {activeTab === "new" && (
        <Box flexDirection="column">
          <Box paddingLeft={2}>
            <Text>
              Enter a name for your new agent, or press Enter for default.
            </Text>
          </Box>
          <Box height={1} />
          <Box flexDirection="column">
            <Box paddingLeft={2}>
              <Text>Agent name:</Text>
            </Box>
            <OverlayTextField
              value={newAgentNameInput}
              onChange={(val) => {
                setNewAgentNameInput(val);
                setNewAgentNameError("");
              }}
              onSubmit={(text) => {
                const trimmed = text.trim();
                if (!trimmed) {
                  onCreateNewAgent?.(DEFAULT_AGENT_NAME, "local");
                  return;
                }
                const validationError = validateAgentName(trimmed);
                if (validationError) {
                  setNewAgentNameError(validationError);
                  return;
                }
                onCreateNewAgent?.(trimmed, "local");
              }}
              placeholder={DEFAULT_AGENT_NAME}
              marker={
                <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
              }
            />
          </Box>
          {newAgentNameError && (
            <Box paddingLeft={2} marginTop={1}>
              <Text color="red">{newAgentNameError}</Text>
            </Box>
          )}
          <Box height={1} />
          <Box paddingLeft={2}>
            <Text dimColor>{"Enter create · Esc cancel"}</Text>
          </Box>
        </Box>
      )}
    </OverlayFrame>
  );
}
