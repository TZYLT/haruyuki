import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { Box } from "ink";
import Link from "ink-link";
import { useEffect, useState } from "react";
import { getBackend } from "@/backend";
import { buildChatUrl, isLocalAgentId } from "@/cli/helpers/app-urls";
import type { KeyBinding } from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import { debugLog } from "@/utils/debug";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

const TITLE = "View your agent's memory";

const VISIBLE_LINES = 12; // Visible lines for value content

interface MemoryTabViewerProps {
  blocks: Block[];
  agentId: string;
  onClose: () => void;
  conversationId?: string;
}

/**
 * Format character count as "current / limit"
 */
function formatCharCount(current: number, limit: number | null): string {
  if (limit === null || limit === undefined) {
    return `${current.toLocaleString()} chars`;
  }
  return `${current.toLocaleString()} / ${limit.toLocaleString()} chars`;
}

/**
 * The tab-strip view of an agent's memory blocks (no memory filesystem).
 *
 * On the toolkit: the chrome is `OverlayFrame`'s, the strip is `TabBar`'s, and
 * the keys are a table the router owns rather than an Ink `useInput` — the same
 * three moves every overlay in this tree is making.
 *
 * Two details are deliberately kept from the hand-written version:
 *
 * - **The strip wraps.** An agent's block labels overflow 80 columns routinely,
 *   and this strip sits in a column of the overlay; `TabBar`'s default row runs
 *   past the frame instead.
 * - **The keys are the keys it had.** Tab/→/← switch tabs and ↑/↓ scroll — the
 *   arrows are *not* list navigation here (the cursor is a tab, not a row), so
 *   this face declares its own table instead of using `useOverlayList`.
 */
export function MemoryTabViewer({
  blocks,
  agentId,
  onClose,
  conversationId,
}: MemoryTabViewerProps) {
  const terminalWidth = useTerminalWidth();
  const isTmux = Boolean(process.env.TMUX);
  const isLocalAgent = isLocalAgentId(agentId);
  const adeUrl = isLocalAgent
    ? null
    : buildChatUrl(agentId, { view: "memory", conversationId });

  const [selectedTabIndex, setSelectedTabIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [freshBlocks, setFreshBlocks] = useState<Block[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch fresh memory blocks from the API when component mounts
  useEffect(() => {
    const fetchBlocks = async () => {
      try {
        const agent = await getBackend().retrieveAgent(agentId, {
          include: ["agent.blocks"],
        });
        setFreshBlocks(agent.memory?.blocks || []);
      } catch (error) {
        debugLog("memory-tab", "Failed to fetch memory blocks: %O", error);
        // Fall back to passed-in blocks if fetch fails
        setFreshBlocks(blocks);
      } finally {
        setIsLoading(false);
      }
    };

    fetchBlocks();
  }, [agentId, blocks]);

  // Use fresh blocks if available, otherwise fall back to passed-in blocks
  const displayBlocks = freshBlocks ?? blocks;

  // Get current block
  const currentBlock = displayBlocks[selectedTabIndex];
  const tabKeys = displayBlocks.map(blockTabKey);
  const tabLabels = new Map(
    displayBlocks.map((block) => [blockTabKey(block), block.label ?? ""]),
  );
  const activeTabKey = currentBlock ? blockTabKey(currentBlock) : "";
  const valueLines = currentBlock?.value?.split("\n") || [];
  const maxScrollOffset = Math.max(0, valueLines.length - VISIBLE_LINES);

  // Reset scroll when switching tabs
  const switchTab = (newIndex: number) => {
    setSelectedTabIndex(newIndex);
    setScrollOffset(0);
  };

  const switchTabBy = (delta: 1 | -1) => {
    const count = displayBlocks.length;
    // The two directions wrapped differently, and the arithmetic is kept as it
    // was: forward is a modulo, backward turns the first tab into `count - 1`.
    switchTab(
      delta === 1
        ? (selectedTabIndex + 1) % count
        : selectedTabIndex === 0
          ? count - 1
          : selectedTabIndex - 1,
    );
  };

  const bindings: KeyBinding[] = [
    {
      id: "memory-tab-viewer.next",
      chords: [{ key: "tab" }, { key: "rightArrow" }],
      run: () => {
        switchTabBy(1);
        return "consumed";
      },
    },
    {
      id: "memory-tab-viewer.previous",
      chords: [{ key: "leftArrow" }],
      run: () => {
        switchTabBy(-1);
        return "consumed";
      },
    },
    {
      id: "memory-tab-viewer.scroll-up",
      chords: [{ key: "upArrow" }],
      run: () => {
        setScrollOffset((prev) => Math.max(prev - 1, 0));
        return "consumed";
      },
    },
    {
      id: "memory-tab-viewer.scroll-down",
      chords: [{ key: "downArrow" }],
      run: () => {
        setScrollOffset((prev) => Math.min(prev + 1, maxScrollOffset));
        return "consumed";
      },
    },
    {
      id: "memory-tab-viewer.close",
      chords: [{ key: "escape" }, { key: "c", ctrl: true }],
      run: () => {
        onClose();
        return "consumed";
      },
    },
  ];

  useKeyBindings("memory-tab-viewer", [{ scope: "overlay", bindings }]);

  // Loading state
  if (isLoading) {
    return (
      <OverlayFrame
        command="/memory"
        title={TITLE}
        footer={<Text dimColor>{"  "}Esc cancel</Text>}
      >
        <Text dimColor>{"  "}Loading memory...</Text>
      </OverlayFrame>
    );
  }

  // Empty state
  if (displayBlocks.length === 0) {
    return (
      <OverlayFrame
        command="/memory"
        title={TITLE}
        footer={<Text dimColor>{"  "}Esc cancel</Text>}
      >
        <Text dimColor>{"  "}No memory attached to this agent.</Text>
      </OverlayFrame>
    );
  }

  const charCount = (currentBlock?.value || "").length;
  const visibleValueLines = valueLines.slice(
    scrollOffset,
    scrollOffset + VISIBLE_LINES,
  );
  const canScrollDown = scrollOffset < maxScrollOffset;
  const barColor = colors.selector.itemHighlighted;

  return (
    <OverlayFrame
      command="/memory"
      title={TITLE}
      footer={
        <Box flexDirection="column">
          <Text dimColor>
            {"  "}
            {formatCharCount(charCount, currentBlock?.limit ?? null)}
            {currentBlock?.read_only ? " · read-only" : " · read/write"}
          </Text>
          <Box>
            <Text dimColor>{"  "}←→/Tab switch · ↑↓ scroll · </Text>
            {adeUrl && !isTmux && (
              <Link url={adeUrl}>
                <Text dimColor>Edit in ADE</Text>
              </Link>
            )}
            {adeUrl && isTmux && <Text dimColor>Edit in ADE: {adeUrl}</Text>}
            {!adeUrl && <Text dimColor>Local agent: {agentId}</Text>}
            <Text dimColor> · Esc cancel</Text>
          </Box>
        </Box>
      }
    >
      {/* Tab bar. The strip's own padding is why the gaps are zero: the labels
          carry a space on each side already. */}
      <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
        <TabBar
          tabs={tabKeys}
          activeTab={activeTabKey}
          getLabel={(key) => tabLabels.get(key) ?? key}
          wrap
          gap={0}
        />
        {currentBlock?.description && (
          <Box width={terminalWidth - 2}>
            <Text dimColor> </Text>
            <MarkdownDisplay text={currentBlock.description} dimColor />
          </Box>
        )}
      </Box>

      {/* Content area */}
      <Box flexDirection="column">
        {/* Value content with left border */}
        <Box
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeftColor={barColor}
          paddingLeft={1}
        >
          <Text>{visibleValueLines.join("\n") || "(empty)"}</Text>
        </Box>

        {/* Scroll down indicator or phantom row */}
        {canScrollDown ? (
          <Text dimColor>
            {"  "}↓ {maxScrollOffset - scrollOffset} more line
            {maxScrollOffset - scrollOffset !== 1 ? "s" : ""} below
          </Text>
        ) : maxScrollOffset > 0 ? (
          <Text> </Text>
        ) : null}
      </Box>
    </OverlayFrame>
  );
}

/**
 * The tab key for a block: its id, or the label when it has none — the identity
 * `TabBar` maps tabs by, and the one the hand-written strip keyed its rows with.
 * `Block.id` and `Block.label` are both optional, so the empty key is the last
 * resort; a block with neither cannot be told apart from another such block.
 */
function blockTabKey(block: Block): string {
  return block.id || block.label || "";
}
