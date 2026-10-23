import { Box } from "ink";
import Link from "ink-link";
import { memo, useMemo } from "react";
import type { ModelReasoningEffort } from "@/agent/model";
import { isCloudServerUrl } from "@/backend/api/server-url";
import {
  buildChatUrl,
  buildChatWebUrl,
  isLocalAgentId,
} from "@/cli/helpers/app-urls";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { shouldHideReasoningForModelDisplay } from "@/cli/helpers/startup-model-display";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { settingsManager } from "@/settings-manager";
import { getVersion } from "@/version";
import { colors } from "./colors";
import { Text } from "./Text";

interface AgentInfoBarProps {
  agentId?: string;
  agentName?: string | null;
  currentModel?: string | null;
  currentReasoningEffort?: ModelReasoningEffort | null;
  serverUrl?: string;
  conversationId?: string;
}

function formatReasoningLabel(
  effort: ModelReasoningEffort | null | undefined,
): string | null {
  if (effort === "none") return null;
  if (effort === "xhigh") return "xhigh";
  if (effort === "max") return "max";
  if (effort === "minimal") return "minimal";
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high") return "high";
  return null;
}

/**
 * Wrap a token by the columns the **terminal** draws.
 *
 * `string-width` answers one column for `·`/`—`; a CJK console face draws two, and
 * the footer line this feeds would then be wider than the box it was wrapped for.
 * Ink wraps what it is given, so a pre-wrap that undercounts costs an extra physical
 * row in the footer.
 */
function splitTokenToWidth(token: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const char of Array.from(token)) {
    const candidate = `${current}${char}`;
    if (current && terminalTextWidth(candidate) > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function wrapTextToWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      if (terminalTextWidth(word) <= maxWidth) {
        current = word;
      } else {
        const chunks = splitTokenToWidth(word, maxWidth);
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1] ?? "";
      }
      continue;
    }

    const candidate = `${current} ${word}`;
    if (terminalTextWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    lines.push(current);
    if (terminalTextWidth(word) <= maxWidth) {
      current = word;
    } else {
      const chunks = splitTokenToWidth(word, maxWidth);
      lines.push(...chunks.slice(0, -1));
      current = chunks[chunks.length - 1] ?? "";
    }
  }

  if (current) lines.push(current);
  return lines;
}

/**
 * Shows agent info bar with current agent details and useful links.
 */
export const AgentInfoBar = memo(function AgentInfoBar({
  agentId,
  agentName,
  currentModel,
  currentReasoningEffort,
  serverUrl,
  conversationId,
}: AgentInfoBarProps) {
  const columns = useTerminalWidth();
  const isTmux = Boolean(process.env.TMUX);
  // Check if current agent is pinned
  const isPinned = useMemo(() => {
    if (!agentId) return false;
    return settingsManager.isAgentPinned(agentId);
  }, [agentId]);

  const isCloudUser = serverUrl ? isCloudServerUrl(serverUrl) : false;
  const isLocalAgent = agentId ? isLocalAgentId(agentId) : false;
  const showCloudLinks = Boolean(isCloudUser && agentId && !isLocalAgent);
  const adeConversationUrl =
    showCloudLinks && agentId && agentId !== "loading"
      ? buildChatUrl(agentId, { conversationId })
      : "";
  const usageUrl = buildChatWebUrl("/preferences/usage");
  const showBottomBar = agentId && agentId !== "loading";
  const reasoningLabel = shouldHideReasoningForModelDisplay(currentModel)
    ? null
    : formatReasoningLabel(currentReasoningEffort);
  const modelLine = currentModel
    ? `${currentModel}${reasoningLabel ? ` (${reasoningLabel})` : ""}`
    : null;

  if (!showBottomBar) {
    return null;
  }

  const contentWidth = Math.max(1, columns - 2);

  const agentNameLabel = agentName || "Unnamed";
  const agentHint = isPinned
    ? " (pinned)"
    : agentName === DEFAULT_AGENT_NAME || !agentName
      ? " (type /pin to give your agent a real name!)"
      : " (type /pin to pin agent)";
  const agentNameLine = `${agentNameLabel}${agentHint}`;
  const conversationLabel =
    conversationId && conversationId !== "default"
      ? conversationId
      : "default conversation";
  const identityLines = wrapTextToWidth(
    `${agentId} ·\u00A0${conversationLabel}`,
    contentWidth,
  ).map((line) => line.replaceAll("\u00A0", " "));

  return (
    <Box flexDirection="column">
      {/* Blank line after commands */}
      <Box height={1} />

      {/* Agent summary */}
      <Box flexDirection="column">
        <Box>
          <Box width={2} flexShrink={0}>
            <Text>{"  "}</Text>
          </Box>
          <Box width={contentWidth} flexShrink={1}>
            <Text wrap="wrap">
              <Text bold color={colors.footer.agentName}>
                {agentNameLine}
              </Text>
              {modelLine ? <Text dimColor> · {modelLine}</Text> : null}
            </Text>
          </Box>
        </Box>
        {identityLines.map((line, index) => (
          <Box key={`${index}:${line}`}>
            <Box width={2} flexShrink={0}>
              <Text>{"  "}</Text>
            </Box>
            <Box width={contentWidth} flexShrink={1}>
              <Text dimColor>{line}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      {showCloudLinks && adeConversationUrl && (
        <>
          <Box height={1} />
          <Box>
            <Box width={2} flexShrink={0}>
              <Text>{"  "}</Text>
            </Box>
            <Box width={contentWidth} flexShrink={1}>
              {isTmux ? (
                <Text wrap="wrap">
                  Open in ADE: {adeConversationUrl} · Usage: {usageUrl}
                </Text>
              ) : (
                <>
                  <Link url={adeConversationUrl} fallback={false}>
                    <Text>Open in ADE ↗</Text>
                  </Link>
                  <Text dimColor>· </Text>
                  <Link url={usageUrl} fallback={false}>
                    <Text>View usage ↗</Text>
                  </Link>
                </>
              )}
            </Box>
          </Box>
        </>
      )}

      {/* Version and feedback info */}
      <Box>
        <Box width={2} flexShrink={0}>
          <Text>{"  "}</Text>
        </Box>
        <Box width={contentWidth} flexShrink={1}>
          <Text dimColor wrap="wrap">
            Haruyuki v{getVersion()} · /feedback · bugs:
            github.com/TZYLT/haruyuki/issues
          </Text>
        </Box>
      </Box>
    </Box>
  );
});
