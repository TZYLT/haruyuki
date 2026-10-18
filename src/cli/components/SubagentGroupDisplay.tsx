/**
 * SubagentGroupDisplay - Live/interactive subagent status display
 *
 * Used in the ACTIVE render area for subagents that may still be running.
 * Subscribes to external store and handles keyboard input - these hooks
 * require the component to stay "alive" and re-rendering.
 *
 * Features:
 * - Real-time updates via useSyncExternalStore
 * - Single blinking dot in header while running
 * - Expand/collapse tool calls (ctrl+g)
 * - Shows "Running N subagents..." while active
 *
 * When agents complete, they get committed to Ink's <Static> area using
 * SubagentGroupStatic instead (a pure props-based snapshot with no hooks). The
 * two share their row markup through `SubagentRow.tsx`; what lives here is the
 * live group's own policy, which is what actually differs between them.
 */

import { Box } from "ink";
import { memo, useSyncExternalStore } from "react";
import {
  getSnapshot,
  getSubagentToolCount,
  type SubagentState,
  subscribe,
  toggleExpanded,
} from "@/agent/subagent-state.js";
import { useAnimation } from "@/cli/contexts/AnimationContext.js";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { APP_KEY_CHORDS } from "@/cli/helpers/keymap";
import { formatStats } from "@/cli/helpers/subagent-display.js";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";
import type { SubagentRowStatus } from "./SubagentRow";
import { SubagentRow, SubagentToolCallRow } from "./SubagentRow";
import { Text } from "./Text";

/**
 * What the live group says about one agent.
 *
 * The full view names the tool that is running; the condensed one (animation
 * disabled because live content would overflow) only says "Running...", and
 * reports an error as the word rather than the message. Nothing here reaches
 * the frozen group: a committed agent is never "launching".
 */
function liveAgentStatus(
  agent: SubagentState,
  condensed: boolean,
): SubagentRowStatus {
  const isComplete = agent.status === "completed" || agent.status === "error";
  const lastTool = agent.toolCalls[agent.toolCalls.length - 1];

  if (!agent.agentURL && !lastTool && !isComplete && !agent.isBackground) {
    return { kind: "launching" };
  }
  if (agent.status === "error") {
    return { kind: "error", message: condensed ? "Error" : agent.error };
  }
  if (condensed) {
    return {
      kind: "text",
      text: isComplete
        ? "Done"
        : agent.isBackground
          ? "Running in the background"
          : lastTool
            ? "Running..."
            : "Thinking",
    };
  }
  return {
    kind: "text",
    text: isComplete
      ? "Done"
      : agent.isBackground
        ? "Running in the background"
        : lastTool
          ? lastTool.name
          : "Thinking",
  };
}

// ============================================================================
// Subcomponents
// ============================================================================

interface AgentRowProps {
  agent: SubagentState;
  isLast: boolean;
  expanded: boolean;
  condensed?: boolean;
}

const AgentRow = memo(
  ({ agent, isLast, expanded, condensed = false }: AgentRowProps) => {
    const isRunning = agent.status === "pending" || agent.status === "running";
    const toolCount = getSubagentToolCount(agent);
    const shouldDim = isRunning && !agent.isBackground;
    const showStats =
      !condensed &&
      !(agent.isBackground && isRunning) &&
      !(isRunning && toolCount === 0);
    const hideBackgroundStatusLine =
      agent.isBackground && isRunning && !agent.agentURL;

    // Condensed mode: simplified view to reduce re-renders when overflowing.
    // Shows: "Description · type · model" + "Running..." or "Done", with no URL
    // line, no stats and no expanded tool calls. The full details are shown in
    // SubagentGroupStatic once the group is flushed to the static area.
    return (
      <SubagentRow
        isLast={isLast}
        description={agent.description}
        type={agent.type}
        model={agent.model}
        showStats={showStats}
        stats={formatStats(toolCount, agent.totalTokens)}
        dimDescription={shouldDim}
        agentURL={condensed ? undefined : agent.agentURL}
        status={
          hideBackgroundStatusLine ? null : liveAgentStatus(agent, condensed)
        }
      >
        {!condensed &&
          expanded &&
          agent.toolCalls.map((tc) => (
            <SubagentToolCallRow
              key={tc.id}
              isLast={isLast}
              name={tc.name}
              args={tc.args}
            />
          ))}
      </SubagentRow>
    );
  },
);
AgentRow.displayName = "AgentRow";

interface GroupHeaderProps {
  count: number;
  allCompleted: boolean;
  hasErrors: boolean;
  expanded: boolean;
}

const GroupHeader = memo(
  ({ count, allCompleted, hasErrors, expanded }: GroupHeaderProps) => {
    const hint = expanded ? "(ctrl+g to collapse)" : "(ctrl+g to expand)";

    const dotColor = hasErrors
      ? colors.subagent.error
      : colors.subagent.completed;
    const runningDotColor = hasErrors
      ? colors.subagent.error
      : colors.tool.pending;
    const label = allCompleted ? "Ran" : "Running";
    const suffix = count !== 1 ? "agents" : "agent";

    return (
      <Box flexDirection="row">
        {allCompleted ? (
          <Text color={dotColor}>{CLI_GLYPHS.bullet}</Text>
        ) : (
          // BlinkDot now gets shouldAnimate from AnimationContext
          <BlinkDot color={runningDotColor} />
        )}
        <Text>
          {" "}
          {label} <Text bold>{count}</Text> {suffix}
        </Text>
        <Text color={colors.subagent.hint}> {hint}</Text>
      </Box>
    );
  },
);

GroupHeader.displayName = "GroupHeader";

// ============================================================================
// Main Component
// ============================================================================

export const SubagentGroupDisplay = memo(() => {
  const { agents, expanded } = useSyncExternalStore(subscribe, getSnapshot);
  const { shouldAnimate } = useAnimation();

  // Expand/collapse the group. Ctrl+O used to reach both this component and the
  // last shell tool call, so one press changed two things; the shell output kept
  // Ctrl+O and the group answers to Ctrl+G.
  useKeyBindings("subagent-group", [
    {
      scope: "app",
      bindings: [
        {
          id: "transcript.toggleSubagents",
          chords: APP_KEY_CHORDS.toggleSubagents,
          run: () => {
            toggleExpanded();
            return "consumed";
          },
        },
      ],
    },
  ]);

  // Hide silent subagents (e.g. init) — they handle user notifications
  // via their own mechanisms (e.g. EventMessage).
  const visible = agents.filter((a) => !a.silent);

  // Don't render if no agents
  if (visible.length === 0) {
    return null;
  }

  // Use condensed mode when animation is disabled (overflow detected by AnimationContext)
  // This ensures consistent behavior - when we disable animation, we also simplify the view
  const condensed = !shouldAnimate;

  const allCompleted = visible.every(
    (a) => a.status === "completed" || a.status === "error",
  );
  const hasErrors = visible.some((a) => a.status === "error");

  return (
    <Box flexDirection="column" marginTop={1}>
      <GroupHeader
        count={visible.length}
        allCompleted={allCompleted}
        hasErrors={hasErrors}
        expanded={expanded}
      />
      {visible.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          isLast={index === visible.length - 1}
          expanded={expanded}
          condensed={condensed}
        />
      ))}
    </Box>
  );
});

SubagentGroupDisplay.displayName = "SubagentGroupDisplay";
