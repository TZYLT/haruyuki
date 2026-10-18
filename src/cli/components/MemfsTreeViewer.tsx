import { existsSync } from "node:fs";
import { join } from "node:path";
import { Box } from "ink";
import Link from "ink-link";
import { useEffect, useMemo, useRef, useState } from "react";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  getFileNodes,
  readFileContent,
  scanMemoryFilesystem,
  type TreeNode,
} from "@/agent/memory-scanner";
import { buildChatUrl, isLocalAgentId } from "@/cli/helpers/app-urls";
import {
  type KeyBinding,
  type KeyOutcome,
  namedKeyChords,
} from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { ContextUsageSnapshot } from "@/web/context-usage";
import { generateAndOpenMemoryViewer } from "@/web/generate-memory-viewer";
import { colors } from "./colors";
import { Text } from "./Text";

// Line characters
const DOTTED_LINE = "╌";

const TITLE = "View your agent's memory";

// Tree view constants
const TREE_VISIBLE_LINES = 15;
const FULL_VIEW_VISIBLE_LINES = 16;

interface MemfsTreeViewerProps {
  agentId: string;
  agentName?: string;
  onClose: () => void;
  conversationId?: string;
  contextUsage?: ContextUsageSnapshot;
}

/**
 * Render tree line prefix based on depth and parent status
 */
function renderTreePrefix(node: TreeNode): string {
  let prefix = "";
  for (let i = 0; i < node.depth; i++) {
    prefix += node.parentIsLast[i] ? "    " : "│   ";
  }
  prefix += node.isLast ? "└── " : "├── ";
  return prefix;
}

export function MemfsTreeViewer({
  agentId,
  agentName,
  onClose,
  conversationId,
  contextUsage,
}: MemfsTreeViewerProps) {
  const terminalWidth = useTerminalWidth();
  const isTmux = Boolean(process.env.TMUX);
  const isLocalAgent = isLocalAgentId(agentId);
  const adeUrl = isLocalAgent
    ? null
    : buildChatUrl(agentId, { view: "memory", conversationId });

  // State
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [treeScrollOffset, setTreeScrollOffset] = useState(0);
  const [viewMode, setViewMode] = useState<"split" | "full">("split");
  const [fullViewScrollOffset, setFullViewScrollOffset] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get memory filesystem root
  const memoryRoot = getScopedMemoryFilesystemRoot(agentId);
  const memoryExists = existsSync(memoryRoot);
  const hasGitRepo = useMemo(
    () => existsSync(join(memoryRoot, ".git")),
    [memoryRoot],
  );

  function showStatus(msg: string, durationMs: number) {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatus(msg);
    statusTimerRef.current = setTimeout(() => setStatus(null), durationMs);
  }

  // Cleanup status timer on unmount
  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  // Scan filesystem and build tree
  const treeNodes = useMemo(
    () => (memoryExists ? scanMemoryFilesystem(memoryRoot) : []),
    [memoryRoot, memoryExists],
  );
  const fileNodes = useMemo(() => getFileNodes(treeNodes), [treeNodes]);

  // Get currently selected file and its content
  const selectedFile = fileNodes[selectedIndex];
  const selectedContent = useMemo(
    () => (selectedFile ? readFileContent(selectedFile.fullPath) : ""),
    [selectedFile],
  );

  // Calculate scroll bounds
  const contentLines = selectedContent.split("\n");
  const maxFullViewScroll = Math.max(
    0,
    contentLines.length - FULL_VIEW_VISIBLE_LINES,
  );

  // Escape leaves the full view and closes from the split view; Ctrl+C closes
  // from either. They are two bindings for that reason — the hand-written handler
  // checked Ctrl+C *before* it looked at the mode, so a user in the full view who
  // pressed it closed the overlay rather than stepping back one level.
  const leaveOrClose = () => {
    if (viewMode === "full") {
      setViewMode("split");
      setFullViewScrollOffset(0);
    } else {
      onClose();
    }
  };

  const openInBrowser = () => {
    showStatus("Opening in browser...", 10000);
    generateAndOpenMemoryViewer(agentId, {
      agentName,
      conversationId: conversationId !== "default" ? conversationId : undefined,
      contextUsage,
    })
      .then((result) => {
        if (result.opened) {
          showStatus("Opened in browser", 3000);
        } else {
          showStatus(`Run: open ${result.filePath}`, 15000);
        }
      })
      .catch((err: unknown) =>
        showStatus(
          err instanceof Error ? err.message : "Failed to open viewer",
          5000,
        ),
      );
  };

  /**
   * Move the file cursor one row, dragging the tree window with it.
   *
   * The cursor walks `fileNodes` while the window is over `treeNodes` — files and
   * directories both — so a file's position in the tree is looked up rather than
   * assumed. Declining at either end is what the hand-written handler did by
   * falling through: nothing moved, and nothing else in this tree wants the key.
   */
  const navigateFile = (direction: -1 | 1): KeyOutcome => {
    if (direction === -1 && selectedIndex === 0) {
      // Already at the first file, but the tree can still scroll to show context.
      if (treeScrollOffset === 0) return "declined";
      setTreeScrollOffset(treeScrollOffset - 1);
      return "consumed";
    }

    if (direction === 1 && selectedIndex >= fileNodes.length - 1) {
      return "declined";
    }

    const newIndex = selectedIndex + direction;
    setSelectedIndex(newIndex);
    const newFile = fileNodes[newIndex];
    if (!newFile) return "consumed";

    const nodeIndex = treeNodes.findIndex(
      (node) => node.relativePath === newFile.relativePath,
    );
    if (nodeIndex < 0) return "consumed";

    if (direction === -1) {
      // Scroll up to show the selected node with context.
      const desiredOffset = Math.max(0, nodeIndex - 1);
      if (desiredOffset < treeScrollOffset) {
        setTreeScrollOffset(desiredOffset);
      }
    } else if (nodeIndex >= treeScrollOffset + TREE_VISIBLE_LINES) {
      setTreeScrollOffset(nodeIndex - TREE_VISIBLE_LINES + 1);
    }

    return "consumed";
  };

  // The face's keys, as data. They are not list navigation — the cursor walks
  // files while the window is over the tree, which `useOverlayList` cannot
  // express — so the table is the face's own, and the router owns the keys.
  const bindings: KeyBinding[] = [
    {
      id: "memfs-tree-viewer.close",
      chords: [{ key: "c", ctrl: true }],
      run: () => {
        onClose();
        return "consumed";
      },
    },
    {
      id: "memfs-tree-viewer.leave-full-view",
      chords: namedKeyChords("escape"),
      run: () => {
        leaveOrClose();
        return "consumed";
      },
    },
    {
      id: "memfs-tree-viewer.open-browser",
      chords: [{ key: "o" }, { key: "o", shift: true }],
      run: () => {
        // No git repo means no memory viewer to build: the key is not ours.
        if (!hasGitRepo) return "declined";
        openInBrowser();
        return "consumed";
      },
    },
    {
      id: "memfs-tree-viewer.up",
      chords: namedKeyChords("upArrow"),
      run: () => {
        if (viewMode === "full") {
          setFullViewScrollOffset((prev) => Math.max(0, prev - 1));
          return "consumed";
        }
        return navigateFile(-1);
      },
    },
    {
      id: "memfs-tree-viewer.down",
      chords: namedKeyChords("downArrow"),
      run: () => {
        if (viewMode === "full") {
          setFullViewScrollOffset((prev) =>
            Math.min(maxFullViewScroll, prev + 1),
          );
          return "consumed";
        }
        return navigateFile(1);
      },
    },
    {
      id: "memfs-tree-viewer.open-file",
      chords: namedKeyChords("return"),
      run: () => {
        if (viewMode !== "split" || !selectedFile) return "declined";
        setViewMode("full");
        setFullViewScrollOffset(0);
        return "consumed";
      },
    },
  ];

  useKeyBindings("memfs-tree-viewer", [{ scope: "overlay", bindings }]);

  // No memfs directory
  if (!memoryExists) {
    return (
      <OverlayFrame
        command="/memory"
        title={TITLE}
        footer={<Text dimColor>{"  "}Esc cancel</Text>}
      >
        <Text dimColor>
          {"  "}Memory filesystem not found at {memoryRoot}
        </Text>
        <Text dimColor>{"  "}Run /memfs enable to set up.</Text>
      </OverlayFrame>
    );
  }

  // Empty state
  if (treeNodes.length === 0) {
    return (
      <OverlayFrame
        command="/memory"
        title={TITLE}
        footer={<Text dimColor>{"  "}Esc cancel</Text>}
      >
        <Text dimColor>{"  "}No files in memory filesystem.</Text>
      </OverlayFrame>
    );
  }

  // Full view mode
  if (viewMode === "full" && selectedFile) {
    const visibleLines = contentLines.slice(
      fullViewScrollOffset,
      fullViewScrollOffset + FULL_VIEW_VISIBLE_LINES,
    );
    const canScrollDown = fullViewScrollOffset < maxFullViewScroll;
    const charCount = selectedContent.length;
    const barColor = colors.selector.itemHighlighted;

    return (
      <OverlayFrame
        command="/memory"
        title={selectedFile.relativePath}
        footer={
          <Box flexDirection="column">
            <Text dimColor>
              {"  "}
              {charCount.toLocaleString()} chars
            </Text>
            {status ? (
              <Text dimColor>
                {"  "}
                {status}
              </Text>
            ) : (
              <Text dimColor>
                {"  "}↑↓ scroll{hasGitRepo ? " · O open in browser" : ""} · Esc
                back
              </Text>
            )}
          </Box>
        }
      >
        {/* Content with left border */}
        <Box
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeftColor={barColor}
          paddingLeft={1}
        >
          <Text>{visibleLines.join("\n") || "(empty)"}</Text>
        </Box>

        {/* Scroll indicator */}
        {canScrollDown ? (
          <Text dimColor>
            {"  "}↓ {maxFullViewScroll - fullViewScrollOffset} more line
            {maxFullViewScroll - fullViewScrollOffset !== 1 ? "s" : ""} below
          </Text>
        ) : maxFullViewScroll > 0 ? (
          <Text> </Text>
        ) : null}
      </OverlayFrame>
    );
  }

  // Split view mode
  const leftWidth = Math.floor((terminalWidth - 4) * 0.45);
  const rightWidth = terminalWidth - leftWidth - 4;

  // Visible tree nodes
  const visibleTreeNodes = treeNodes.slice(
    treeScrollOffset,
    treeScrollOffset + TREE_VISIBLE_LINES,
  );

  // Preview content - fills the space
  // Layout: title (1) + content (TREE_VISIBLE_LINES - 1) + more indicator (1) = TREE_VISIBLE_LINES + 1
  // This matches the left panel: tree (TREE_VISIBLE_LINES) + more indicator (1)
  const previewContentLines = TREE_VISIBLE_LINES - 1;
  const previewLines = contentLines.slice(0, previewContentLines);
  const hasMorePreviewLines = contentLines.length > previewContentLines;

  return (
    <OverlayFrame
      command="/memory"
      title={TITLE}
      footer={
        <Box flexDirection="column">
          {status ? (
            <Text dimColor>
              {"  "}
              {status}
            </Text>
          ) : (
            <Box>
              <Text dimColor>{"  "}↑↓ navigate · Enter view · </Text>
              {adeUrl && !isTmux && (
                <Link url={adeUrl}>
                  <Text dimColor>Edit in ADE</Text>
                </Link>
              )}
              {adeUrl && isTmux && <Text dimColor>Edit in ADE: {adeUrl}</Text>}
              {!adeUrl && <Text dimColor>Local agent: {agentId}</Text>}
              {hasGitRepo && <Text dimColor> · O open in browser</Text>}
              <Text dimColor> · Esc close</Text>
            </Box>
          )}
        </Box>
      }
    >
      {/* Top dotted border - full width */}
      <Text dimColor>{DOTTED_LINE.repeat(terminalWidth)}</Text>

      {/* Split view */}
      <Box flexDirection="row">
        {/* Left panel - Tree */}
        <Box flexDirection="column" width={leftWidth}>
          {visibleTreeNodes.map((node) => {
            const isSelected =
              !node.isDirectory &&
              node.relativePath === selectedFile?.relativePath;
            const prefix = renderTreePrefix(node);
            // "system/" directory gets special green color
            const isSystemDir = node.isDirectory && node.name === "system/";

            return (
              <Box key={node.relativePath} flexDirection="row">
                <Text
                  backgroundColor={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                  color={isSelected ? "white" : undefined}
                >
                  {prefix}
                </Text>
                <Text
                  backgroundColor={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                  color={
                    isSelected
                      ? "black"
                      : isSystemDir
                        ? colors.status.success
                        : undefined
                  }
                  dimColor={node.isDirectory && !isSystemDir}
                >
                  {node.name}
                </Text>
              </Box>
            );
          })}
          {/* Pad to fixed height */}
          {visibleTreeNodes.length < TREE_VISIBLE_LINES &&
            Array.from({
              length: TREE_VISIBLE_LINES - visibleTreeNodes.length,
            }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
              <Text key={`pad-${i}`}> </Text>
            ))}
          {/* More indicator - always on last row */}
          {treeScrollOffset + TREE_VISIBLE_LINES < treeNodes.length ? (
            <Text dimColor>
              ...{treeNodes.length - treeScrollOffset - TREE_VISIBLE_LINES} more
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>

        {/* Separator */}
        <Box flexDirection="column" marginLeft={1} marginRight={1}>
          {Array.from({ length: TREE_VISIBLE_LINES + 1 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static separator elements
            <Text key={i} dimColor>
              │
            </Text>
          ))}
        </Box>

        {/* Right panel - Preview */}
        <Box flexDirection="column" width={rightWidth}>
          {selectedFile ? (
            <>
              {/* Content lines */}
              {previewLines.map((line, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: content lines by position
                <Text key={idx}>
                  {line.length > rightWidth - 2
                    ? `${line.slice(0, rightWidth - 5)}...`
                    : line || " "}
                </Text>
              ))}
              {/* Padding to fill remaining content space */}
              {Array.from({
                length: Math.max(
                  0,
                  previewContentLines - previewLines.length + 1,
                ),
              }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
                <Text key={`pad-${i}`}> </Text>
              ))}
              {/* More indicator */}
              {hasMorePreviewLines ? (
                <Text dimColor>
                  ...{contentLines.length - previewContentLines} more (enter to
                  view)
                </Text>
              ) : (
                <Text> </Text>
              )}
            </>
          ) : (
            <>
              <Text dimColor>No file selected</Text>
              {/* Pad to match height */}
              {Array.from({ length: TREE_VISIBLE_LINES }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static padding elements
                <Text key={`pad-${i}`}> </Text>
              ))}
            </>
          )}
        </Box>
      </Box>

      {/* Bottom dotted border - full width */}
      <Text dimColor>{DOTTED_LINE.repeat(terminalWidth)}</Text>
    </OverlayFrame>
  );
}
