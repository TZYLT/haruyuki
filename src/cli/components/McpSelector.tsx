import { Box, useInput } from "ink";
import { memo, useCallback, useEffect, useState } from "react";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { ConfirmOptions } from "@/cli/overlay/confirm";
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

const SOLID_LINE = "─";
const DISPLAY_PAGE_SIZE = 7;

/** The copy of this face's delete confirmation; the rows themselves are shared. */
const MCP_DELETE_OPTIONS = [
  { key: "remove", label: "Yes, remove" },
  { key: "cancel", label: "No, cancel" },
];

type Mode = "browsing" | "confirming-delete" | "viewing-tools";

export type McpRow = { kind: "local"; state: ClientMcpServerState };

export function buildMcpRows(localStates: ClientMcpServerState[]): McpRow[] {
  return localStates.map((state): McpRow => ({ kind: "local", state }));
}

interface McpSelectorProps {
  agentId: string;
  onAdd: () => void;
  onCancel: () => void;
}

export const McpSelector = memo(function McpSelector({
  agentId,
  onAdd,
  onCancel,
}: McpSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [states, setStates] = useState<ClientMcpServerState[]>(() =>
    getClientMcpServerStates(agentId),
  );
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<Mode>("browsing");
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(1);
  const [viewingState, setViewingState] = useState<ClientMcpServerState | null>(
    null,
  );

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
        setSelectedIndex(0);
        setPage(0);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
        setMode("browsing");
      }
    },
    [agentId],
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

  const rows = buildMcpRows(states);
  const totalPages = Math.max(1, Math.ceil(rows.length / DISPLAY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = rows.slice(
    safePage * DISPLAY_PAGE_SIZE,
    (safePage + 1) * DISPLAY_PAGE_SIZE,
  );
  const safeIndex = Math.min(selectedIndex, Math.max(0, pageRows.length - 1));
  const selected = pageRows[safeIndex];

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (loading) return;

    if (mode === "confirming-delete") {
      if (key.upArrow || key.downArrow) {
        setDeleteConfirmIndex((current) => (current === 0 ? 1 : 0));
      } else if (key.return) {
        if (deleteConfirmIndex === 0 && selected)
          void removeServer(selected.state.config);
        else setMode("browsing");
      } else if (key.escape) {
        setMode("browsing");
      }
      return;
    }

    if (mode === "viewing-tools") {
      if (key.escape) {
        setViewingState(null);
        setMode("browsing");
      } else if (input === "r" || input === "R") {
        setViewingState(null);
        setMode("browsing");
        void refresh();
      }
      return;
    }

    if (key.upArrow) {
      if (safeIndex === 0 && safePage > 0) {
        setPage(safePage - 1);
        setSelectedIndex(DISPLAY_PAGE_SIZE - 1);
      } else {
        setSelectedIndex(Math.max(0, safeIndex - 1));
      }
    } else if (key.downArrow) {
      if (safeIndex === pageRows.length - 1 && safePage < totalPages - 1) {
        setPage(safePage + 1);
        setSelectedIndex(0);
      } else {
        setSelectedIndex(
          Math.min(Math.max(0, pageRows.length - 1), safeIndex + 1),
        );
      }
    } else if (key.return && selected) {
      setViewingState(selected.state);
      setMode("viewing-tools");
    } else if (input === "a" || input === "A") {
      onAdd();
    } else if ((input === "d" || input === "D") && selected) {
      setDeleteConfirmIndex(1);
      setMode("confirming-delete");
    } else if (input === "r" || input === "R") {
      void refresh();
    } else if (key.escape) {
      onCancel();
    }
  });

  if (mode === "viewing-tools" && viewingState) {
    return (
      <Frame solidLine={solidLine}>
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
      </Frame>
    );
  }

  if (mode === "confirming-delete" && selected) {
    return (
      <Frame solidLine={solidLine}>
        <Text bold color={colors.selector.title}>
          Remove client-local MCP server?
        </Text>
        <Text>Remove "{selected.state.config.name}" and stop its process?</Text>
        <Box marginTop={1} flexDirection="column">
          <ConfirmOptions
            options={MCP_DELETE_OPTIONS}
            selectedIndex={deleteConfirmIndex}
            marker="> "
            selectedColor={colors.selector.itemHighlighted}
            boldSelected
          />
        </Box>
      </Frame>
    );
  }

  return (
    <Frame solidLine={solidLine}>
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
        pageRows.map((row, index) => {
          const isSelected = index === safeIndex;
          return (
            <Box key={rowKey(row)} flexDirection="column" marginBottom={1}>
              {index === 0 && (
                <Box marginBottom={1}>
                  <Text bold dimColor>
                    Local (this machine)
                  </Text>
                </Box>
              )}
              <LocalRow
                state={row.state}
                isSelected={isSelected}
                terminalWidth={terminalWidth}
              />
            </Box>
          );
        })
      )}
      {!loading && !error && statusMessage && (
        <Text dimColor>{statusMessage}</Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {totalPages > 1 && (
          <Text dimColor>
            Page {safePage + 1}/{totalPages}
          </Text>
        )}
        <Text dimColor>
          Enter tools · A add · D remove · R refresh · Esc close
        </Text>
      </Box>
    </Frame>
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

function Frame({
  children,
  solidLine,
}: {
  children: React.ReactNode;
  solidLine: string;
}) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{"> /mcp"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />
      {children}
    </Box>
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
