import { Box } from "ink";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { ConfirmOptions } from "@/cli/overlay/confirm";
import { OverlayFrame } from "@/cli/overlay/frame";
import { listBindings } from "@/cli/overlay/list-bindings";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import type { McpServerConfig } from "@/mcp-client";
import { clearMcpOAuthCredentials } from "@/mcp-oauth";
import {
  type ClientMcpServerState,
  getClientMcpServerStates,
  replaceClientMcpServers,
} from "@/mcp-runtime";
import { settingsManager } from "@/settings-manager";
import { colors } from "./colors";
import { Text } from "./Text";

/**
 * How many servers the list shows at once, and what PageUp/PageDown step over.
 * Kept at the seven the hand-rolled pager used, so the same number of servers is
 * on screen; what changed is how the list moves between them.
 */
const WINDOW_ROWS = 7;

/** The copy of this face's delete confirmation; the rows themselves are shared. */
const MCP_DELETE_OPTIONS = [
  { key: "remove", label: "Yes, remove" },
  { key: "cancel", label: "No, cancel" },
];

type McpStep = "browsing" | "confirming-delete" | "viewing-tools";

export type McpRow = { kind: "local"; state: ClientMcpServerState };

export function buildMcpRows(localStates: ClientMcpServerState[]): McpRow[] {
  return localStates.map((state): McpRow => ({ kind: "local", state }));
}

interface McpSelectorProps {
  agentId: string;
  onAdd: () => void;
  onCancel: () => void;
}

/**
 * `/config mcp`'s three views, on the toolkit.
 *
 * The face used to page its own list: a page size, a page index, a cursor
 * clamped inside the page, and a `Page 2/5` line — a second window
 * implementation, aligned to page boundaries and jumping a whole page at the end
 * of one. It is the toolkit's continuous window now (edge anchored, seven rows,
 * the toolkit's own `↑/↓ N more`), which is the change this face was signed off
 * for: the same seven rows on screen, and scrolling steps by one instead of by a
 * page. The keys that came with the window (PageUp/PageDown/Home/End) are the
 * gain; the ones it already had (`A`/`D`/`R`, Enter, Escape) are unchanged.
 */
export const McpSelector = memo(function McpSelector({
  agentId,
  onAdd,
  onCancel,
}: McpSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const [states, setStates] = useState<ClientMcpServerState[]>(() =>
    getClientMcpServerStates(agentId),
  );
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(1);
  const [pendingRemove, setPendingRemove] =
    useState<ClientMcpServerState | null>(null);
  const [viewingState, setViewingState] = useState<ClientMcpServerState | null>(
    null,
  );
  const wizard = useWizard<McpStep>({ initial: "browsing" });
  const { canGoBack, back, goTo, popTo } = wizard;

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatusMessage(null);
    setError(null);
    try {
      const configs = settingsManager.getMcpServers(agentId);
      setStates(
        await replaceClientMcpServers(agentId, configs, {
          interactiveOAuth: true,
          onStatus: setStatusMessage,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  /** Back to the server list, forgetting whatever view was open. */
  const returnToList = useCallback(() => {
    setViewingState(null);
    setPendingRemove(null);
    setDeleteConfirmIndex(1);
    popTo("browsing");
  }, [popTo]);

  const removeServer = useCallback(
    async (config: McpServerConfig) => {
      setLoading(true);
      setError(null);
      try {
        const configs = settingsManager
          .getMcpServers(agentId)
          .filter((server) => server.name !== config.name);
        settingsManager.setMcpServers(agentId, configs);
        await settingsManager.flush();
        if (config.transport === "http" || config.transport === "sse") {
          await clearMcpOAuthCredentials(agentId, config.name, config.url);
        }
        setStates(await replaceClientMcpServers(agentId, configs));
        returnToList();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [agentId, returnToList],
  );

  useEffect(() => {
    const currentStates = getClientMcpServerStates(agentId);
    setStates(currentStates);
    if (
      currentStates.length !== settingsManager.getMcpServers(agentId).length
    ) {
      void refresh();
    }
  }, [agentId, refresh]);

  const rows = useMemo(() => buildMcpRows(states), [states]);
  const rowItems = useMemo(
    () =>
      rows.map((row) => ({ key: rowKey(row), label: row.state.config.name })),
    [rows],
  );
  // Every key this face answers is inert while a connection pass is running,
  // which is what the old `if (loading) return` did at the top of its handler.
  const ready = !loading;
  const browsing = ready && wizard.step === "browsing";

  const list = useOverlayList({
    owner: "mcp-selector-list",
    items: rowItems,
    rows: WINDOW_ROWS,
    anchor: "edge",
    navigationEnabled: browsing,
    onConfirm: (_key, index) => {
      const row = rows[index];
      if (!row) return;
      setViewingState(row.state);
      goTo("viewing-tools");
    },
    // Escape and Ctrl+C are the wizard's, so this list declares no cancel: a
    // list that did would answer Escape for the other two steps as well.
    onCancel: undefined,
  });

  const leave = useCallback(() => {
    if (canGoBack) {
      returnToList();
      back();
    } else {
      onCancel();
    }
  }, [back, canGoBack, onCancel, returnToList]);

  useKeyBindings("mcp-selector-keys", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "mcp-selector.add",
          chords: [{ key: "a" }, { key: "a", shift: true }],
          run: () => {
            if (!browsing) return "declined";
            onAdd();
            return "consumed";
          },
        },
        {
          id: "mcp-selector.remove",
          chords: [{ key: "d" }, { key: "d", shift: true }],
          run: ({ input }) => {
            // Removing a server cannot be undone from this face, so it sits behind
            // Shift the way `/agent list`'s delete does: the chord matcher is
            // case-insensitive, so without this a bare `d` would open the
            // confirmation. `A` and `R` stay bare — they open a flow and re-read
            // state, they do not destroy anything.
            if (input !== "D") return "declined";
            if (!browsing) return "declined";
            const row = rows[list.cursor];
            if (!row) return "declined";
            setPendingRemove(row.state);
            setDeleteConfirmIndex(1);
            goTo("confirming-delete");
            return "consumed";
          },
        },
        {
          id: "mcp-selector.refresh",
          chords: [{ key: "r" }, { key: "r", shift: true }],
          run: () => {
            if (!ready) return "declined";
            if (wizard.step === "viewing-tools") {
              setViewingState(null);
              back();
            }
            void refresh();
            return "consumed";
          },
        },
        // The delete confirmation is a two-row list of its own: arrows toggle it
        // and Enter takes the row the cursor is on.
        ...listBindings({
          count: MCP_DELETE_OPTIONS.length,
          cursor: deleteConfirmIndex,
          onMoveCursor: setDeleteConfirmIndex,
          onConfirm: () => {
            const config = pendingRemove?.config;
            if (deleteConfirmIndex === 0 && config) {
              void removeServer(config);
            } else {
              returnToList();
            }
          },
          onCancel: undefined,
          navigationEnabled: ready && wizard.step === "confirming-delete",
        }),
        ...wizardBindings({ canGoBack, onBack: leave, onCancel }),
      ],
    },
  ]);

  if (wizard.step === "viewing-tools" && viewingState) {
    return (
      <OverlayFrame command="/mcp">
        <Text bold color={colors.selector.title}>
          Tools for {viewingState.config.name}
        </Text>
        <Box height={1} />
        {viewingState.status === "failed" ? (
          <Text color="red">Connection failed: {viewingState.error}</Text>
        ) : viewingState.tools.length === 0 ? (
          <Text dimColor>No tools discovered.</Text>
        ) : (
          viewingState.tools.map((tool) => (
            <Box key={tool.name} flexDirection="column">
              <Text>{tool.title ?? tool.name}</Text>
              <Text dimColor>
                {"  "}
                {truncateText(singleLine(tool.description), terminalWidth - 2)}
              </Text>
            </Box>
          ))
        )}
        <Box marginTop={1}>
          <Text dimColor>R reconnect · Esc back</Text>
        </Box>
      </OverlayFrame>
    );
  }

  if (wizard.step === "confirming-delete" && pendingRemove) {
    return (
      <OverlayFrame command="/mcp">
        <Text bold color={colors.selector.title}>
          Remove client-local MCP server?
        </Text>
        <Text>Remove "{pendingRemove.config.name}" and stop its process?</Text>
        <Box marginTop={1} flexDirection="column">
          <ConfirmOptions
            options={MCP_DELETE_OPTIONS}
            selectedIndex={deleteConfirmIndex}
          />
        </Box>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame command="/mcp">
      <Text bold color={colors.selector.title}>
        MCP servers for this agent
      </Text>
      <Box height={1} />
      {loading ? (
        <Text dimColor>{statusMessage ?? "Connecting MCP servers..."}</Text>
      ) : error ? (
        <Text color="red">Error: {error}</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>
          No MCP servers configured. Press A to add a local server.
        </Text>
      ) : (
        <OverlayListView
          items={rowItems}
          cursor={list.cursor}
          rows={WINDOW_ROWS}
          anchor="edge"
          renderRow={(_item, index, isCursor) => {
            const row = rows[index];
            if (!row) return null;
            return (
              <Box flexDirection="column" marginBottom={1}>
                {index === 0 && (
                  <Box marginBottom={1}>
                    <Text bold dimColor>
                      Local (this machine)
                    </Text>
                  </Box>
                )}
                <LocalRow
                  state={row.state}
                  isSelected={isCursor}
                  terminalWidth={terminalWidth}
                />
              </Box>
            );
          }}
        />
      )}
      {!loading && !error && statusMessage && (
        <Text dimColor>{statusMessage}</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          Enter tools · A add · Shift+D remove · R refresh · Esc close
        </Text>
      </Box>
    </OverlayFrame>
  );
});

function rowKey(row: McpRow): string {
  return `local:${row.state.config.name}`;
}

function LocalRow({
  state,
  isSelected,
  terminalWidth,
}: {
  state: ClientMcpServerState;
  isSelected: boolean;
  terminalWidth: number;
}) {
  const status = state.status === "connected" ? "connected" : "failed";
  const target = describeTarget(state.config);
  return (
    <>
      <Text
        bold={isSelected}
        color={isSelected ? colors.selector.itemHighlighted : undefined}
      >
        {isSelected ? "> " : "  "}
        {state.config.name} · {transportName(state.config)} · {status}
      </Text>
      <Text dimColor>
        {"  "}
        {truncateText(target, terminalWidth - 2)} · {state.tools.length} tools
      </Text>
    </>
  );
}

function singleLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function describeTarget(config: McpServerConfig): string {
  if (config.transport === "http" || config.transport === "sse") {
    return config.url;
  }
  return [config.command, ...(config.args ?? [])].join(" ");
}

function transportName(config: McpServerConfig): string {
  return config.transport ?? "stdio";
}
