/**
 * SubagentGroupStatic - Frozen snapshot of completed subagents
 *
 * Used in Ink's <Static> area for historical/committed items that have
 * scrolled up and should no longer re-render. Pure props-based component
 * with NO hooks of its own (no store subscriptions, no keyboard handlers).
 *
 * This separation from SubagentGroupDisplay is necessary because:
 * - Static area components shouldn't have active subscriptions (memory leaks)
 * - Keyboard handlers would stack up across frozen components
 * - We only need a simple snapshot, not live updates
 *
 * The two components render the same rows, so the row itself lives in
 * `SubagentRow.tsx`; what stays here is the frozen snapshot's own policy — which
 * cells a committed agent shows, and which status words apply to one.
 *
 * Shows: "Ran N subagents" with final stats (tool count, tokens).
 */

import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { formatStats } from "@/cli/helpers/subagent-display.js";
import { colors } from "./colors.js";
import { SubagentRow, type SubagentRowStatus } from "./SubagentRow";
import { Text } from "./Text";

// ============================================================================
// Types
// ============================================================================

export interface StaticSubagent {
  id: string;
  type: string;
  description: string;
  status: "completed" | "error" | "running";
  toolCount: number;
  totalTokens: number;
  agentURL: string | null;
  error?: string;
  model?: string;
  isBackground?: boolean;
}

interface SubagentGroupStaticProps {
  agents: StaticSubagent[];
}

// ============================================================================
// Subcomponents
// ============================================================================

interface AgentRowProps {
  agent: StaticSubagent;
  isLast: boolean;
}

const AgentRow = memo(({ agent, isLast }: AgentRowProps) => {
  const isRunning = agent.status === "running";
  const shouldDim = isRunning && !agent.isBackground;
  const showStats = !(agent.isBackground && isRunning);
  const hideBackgroundStatusLine =
    agent.isBackground && isRunning && !agent.agentURL;

  // A frozen agent is never "launching": it was committed in this state. A
  // foreground one that reached the static area says "Done"; a background one
  // still working says so.
  let status: SubagentRowStatus | null = null;
  if (!hideBackgroundStatusLine) {
    status =
      agent.status === "error"
        ? { kind: "error", message: agent.error }
        : {
            kind: "text",
            text:
              agent.status === "completed" && !agent.isBackground
                ? "Done"
                : "Running in the background",
          };
  }

  return (
    <SubagentRow
      isLast={isLast}
      description={agent.description}
      type={agent.type}
      model={agent.model}
      showStats={showStats}
      stats={formatStats(agent.toolCount, agent.totalTokens)}
      dimDescription={shouldDim}
      agentURL={agent.agentURL}
      status={status}
    />
  );
});

AgentRow.displayName = "AgentRow";

// ============================================================================
// Main Component
// ============================================================================

export const SubagentGroupStatic = memo(
  ({ agents }: SubagentGroupStaticProps) => {
    if (agents.length === 0) {
      return null;
    }

    const hasErrors = agents.some((a) => a.status === "error");
    const hasRunning = agents.some((a) => a.status === "running");
    const label = hasRunning ? "Running" : "Ran";
    const suffix = agents.length !== 1 ? "agents" : "agent";

    // Use error color for dot if any subagent errored
    const dotColor = hasErrors
      ? colors.subagent.error
      : hasRunning
        ? colors.tool.pending
        : colors.subagent.completed;

    return (
      <Box flexDirection="column">
        {/* Header */}
        <Box flexDirection="row">
          <Text color={dotColor}>{CLI_GLYPHS.bullet}</Text>
          <Text>
            {" "}
            {label} <Text bold>{agents.length}</Text> {suffix}
          </Text>
        </Box>

        {/* Agent rows */}
        {agents.map((agent, index) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            isLast={index === agents.length - 1}
          />
        ))}
      </Box>
    );
  },
);

SubagentGroupStatic.displayName = "SubagentGroupStatic";
