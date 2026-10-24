import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  handleMcpAdd,
  type McpCommandContext,
  mcpHelpText,
  setActiveCommandId as setActiveMcpCommandId,
} from "@/cli/commands/mcp";
import type { Buffers } from "@/cli/helpers/accumulator";
import type { ActiveOverlay, AppCommandRunner } from "./types";

type SubmitCommandResult = { submitted: boolean };

type ModelSelectorOptions = {
  filterProvider?: string;
  forceRefresh?: boolean;
};

type ConnectionCommandContext = {
  agentId: string;
  buffersRef: MutableRefObject<Buffers>;
  commandRunner: AppCommandRunner;
  markLocalModelsAvailable: () => void;
  refreshDerived: () => void;
  setCommandRunning: (value: boolean) => void;
  setModelSelectorOptions: Dispatch<SetStateAction<ModelSelectorOptions>>;
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => void;
};

export async function handleConnectionCommand(
  msg: string,
  trimmed: string,
  ctx: ConnectionCommandContext,
): Promise<SubmitCommandResult | null> {
  const {
    agentId,
    buffersRef,
    commandRunner,
    markLocalModelsAvailable,
    refreshDerived,
    setCommandRunning,
    setModelSelectorOptions,
    openOverlay,
  } = ctx;

  if (trimmed.startsWith("/mcp")) {
    const mcpCtx: McpCommandContext = {
      agentId,
      buffersRef,
      refreshDerived,
      setCommandRunning,
    };

    const afterMcp = trimmed.slice(4).trim();
    const firstWord = afterMcp.split(/\s+/)[0]?.toLowerCase();

    if (!firstWord) {
      openOverlay(
        "mcp",
        "/mcp",
        "Opening MCP server manager...",
        "MCP dialog dismissed",
      );
      return { submitted: true };
    }

    if (firstWord === "add") {
      const afterAdd = afterMcp.slice(firstWord.length).trim();
      const cmd = commandRunner.start(msg, "Adding MCP server...");
      setActiveMcpCommandId(cmd.id);
      try {
        await handleMcpAdd(mcpCtx, msg, afterAdd);
      } finally {
        setActiveMcpCommandId(null);
      }
      return { submitted: true };
    }

    if (firstWord === "connect") {
      const cmd = commandRunner.start(
        msg,
        "Checking MCP connection options...",
      );
      cmd.fail(
        "The server-side MCP OAuth flow is deprecated in Haruyuki. Use /config mcp add to configure a client-local stdio, HTTP, or SSE server.",
      );
      return { submitted: true };
    }

    if (firstWord === "help") {
      const cmd = commandRunner.start(msg, "Showing MCP help...");
      cmd.finish(mcpHelpText(), true);
      return { submitted: true };
    }

    const cmd = commandRunner.start(msg, "Checking MCP usage...");
    cmd.fail(
      `Unknown subcommand: "${firstWord}". Run /config mcp help for usage.`,
    );
    return { submitted: true };
  }

  if (trimmed === "/connect") {
    openOverlay(
      "connect",
      "/connect",
      "Opening provider selector...",
      "Connect dialog dismissed",
    );
    return { submitted: true };
  }

  if (trimmed.startsWith("/connect ")) {
    const cmd = commandRunner.start(msg, "Starting connection...");
    const { handleConnect, setActiveCommandId: setActiveConnectCommandId } =
      await import("@/cli/commands/connect");
    setActiveConnectCommandId(cmd.id);
    try {
      await handleConnect(
        {
          buffersRef,
          refreshDerived,
          setCommandRunning,
          onCodexConnected: (providerName) => {
            markLocalModelsAvailable();
            setModelSelectorOptions({
              filterProvider: providerName,
              forceRefresh: true,
            });
            openOverlay(
              "model",
              "/model",
              "Opening model selector...",
              "Models dialog dismissed",
            );
          },
        },
        msg,
      );
    } finally {
      setActiveConnectCommandId(null);
    }
    return { submitted: true };
  }

  // Special handling for /help command
  return null;
}
