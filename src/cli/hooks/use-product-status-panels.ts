/**
 * Host-owned panels around the input: the product-status row above it (the
 * spinner for silent background agents, labelled with the agent type — e.g.
 * `reflection`) and the Workflow run rows below it.
 *
 * Everything here reads external stores (subagent lifecycle, workflow
 * execution registry) and a 1 s ticker while something is active, so the
 * rows stay live without any state living in App.tsx.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  getSubagentLifecycleSnapshot,
  subscribeToSubagentLifecycle,
} from "@/agent/subagent-state";
import { BRAILLE_SPINNER_FRAMES } from "@/cli/components/BlinkingSpinner";
import {
  DEFAULT_PRODUCT_STATUS_ORDER,
  PRODUCT_STATUS_SPINNER_INTERVAL_MS,
  PRODUCT_STATUS_SPINNER_PULSE_INTERVAL_MS,
  withDefaultProductStatusPanel,
} from "@/cli/display/product-status/default";
import {
  visibleWorkflowExecutions,
  withWorkflowStatusPanel,
} from "@/cli/display/product-status/workflows";
import { useDreamRunStatus } from "@/cli/hooks/use-dream-run-status";
import type { ModContext, ModPanel } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import {
  getWorkflowExecutionsVersion,
  listWorkflowExecutions,
  subscribeToWorkflowExecutions,
} from "@/tools/workflow/execution-registry";

export function useProductStatusPanels(params: {
  modContext: ModContext;
  modAdapter: LocalModAdapter;
  shouldAnimate: boolean;
}): {
  panelsWithDefaultProductStatus: Record<string, ModPanel>;
  panelModContext: ModContext;
  subagentLifecycleSnapshot: ReturnType<typeof getSubagentLifecycleSnapshot>;
  subagentLifecycleTick: number;
} {
  const { modContext, modAdapter, shouldAnimate } = params;

  const subagentLifecycleSnapshot = useSyncExternalStore(
    subscribeToSubagentLifecycle,
    getSubagentLifecycleSnapshot,
  );
  const workflowExecutionsVersion = useSyncExternalStore(
    subscribeToWorkflowExecutions,
    getWorkflowExecutionsVersion,
  );
  const hasActiveSubagent = subagentLifecycleSnapshot.some(
    (agent) => agent.status === "pending" || agent.status === "running",
  );
  const [subagentLifecycleTick, setSubagentLifecycleTick] = useState(0);

  // Runs worth a row: running, or finished within the linger window.
  // Re-evaluated on registry changes and on the ticker (so elapsed time
  // advances and finished rows eventually drop off).
  const workflowExecutions = useMemo(() => {
    void workflowExecutionsVersion;
    void subagentLifecycleTick;
    return visibleWorkflowExecutions(listWorkflowExecutions());
  }, [workflowExecutionsVersion, subagentLifecycleTick]);
  const hasVisibleWorkflow = workflowExecutions.length > 0;

  useEffect(() => {
    if (!hasActiveSubagent && !hasVisibleWorkflow) return;
    const timer = setInterval(
      () => setSubagentLifecycleTick((value) => value + 1),
      1000,
    );
    return () => clearInterval(timer);
  }, [hasActiveSubagent, hasVisibleWorkflow]);

  const liveBackgroundAgents = useMemo<ModContext["backgroundAgents"]>(() => {
    void subagentLifecycleTick;
    const now = Date.now();
    return subagentLifecycleSnapshot
      .filter(
        (agent) =>
          !agent.visibleInTranscript &&
          (agent.status === "pending" || agent.status === "running"),
      )
      .map((agent) => ({
        type: agent.type,
        status: agent.status,
        durationMs: Math.max(0, now - agent.startedAtMs),
        agentId: agent.agentId ?? null,
      }));
  }, [subagentLifecycleSnapshot, subagentLifecycleTick]);

  const hasActiveProductStatus = liveBackgroundAgents.length > 0;
  const hasUserProductStatusPanel = useMemo(
    () =>
      Object.values(modAdapter.registry?.ui.panels ?? {}).some(
        (panel) => panel.order === DEFAULT_PRODUCT_STATUS_ORDER,
      ),
    [modAdapter.registry?.ui.panels],
  );
  // T-01: the dream half of the same row. Polling only makes sense while this
  // panel is the one drawn (a user mod at order 1 replaces it); the hook's own
  // state stays inside this subtree, and it does nothing while the TUI has no
  // agent yet. Animation (not polling) is what `shouldAnimate` gates: the row
  // itself stays visible when the transcript is too tall to animate.
  const dreamStatus = useDreamRunStatus({
    agentId: modContext.agent.id,
    active: !hasUserProductStatusPanel,
  });
  const hasActiveDream = dreamStatus?.phase === "running";
  const shouldAnimateProductStatus =
    (hasActiveProductStatus || hasActiveDream) && shouldAnimate;
  const [productStatusSpinnerFrameIndex, setProductStatusSpinnerFrameIndex] =
    useState(0);
  const [productStatusSpinnerPulseOn, setProductStatusSpinnerPulseOn] =
    useState(true);

  useEffect(() => {
    setProductStatusSpinnerFrameIndex(0);
    if (!shouldAnimateProductStatus) return;
    const timer = setInterval(() => {
      setProductStatusSpinnerFrameIndex(
        (value) => (value + 1) % BRAILLE_SPINNER_FRAMES.length,
      );
    }, PRODUCT_STATUS_SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shouldAnimateProductStatus]);

  useEffect(() => {
    setProductStatusSpinnerPulseOn(true);
    if (!shouldAnimateProductStatus) return;
    const timer = setInterval(() => {
      setProductStatusSpinnerPulseOn((value) => !value);
    }, PRODUCT_STATUS_SPINNER_PULSE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shouldAnimateProductStatus]);

  const panelModContext = useMemo<ModContext>(
    () => ({
      ...modContext,
      backgroundAgents: liveBackgroundAgents,
    }),
    [liveBackgroundAgents, modContext],
  );

  const activeBackgroundAgentUrl = useMemo(() => {
    const agent = subagentLifecycleSnapshot.find(
      (a) =>
        !a.visibleInTranscript &&
        (a.status === "pending" || a.status === "running") &&
        a.agentUrl,
    );
    return agent?.agentUrl ?? null;
  }, [subagentLifecycleSnapshot]);

  const panelsWithDefaultProductStatus = useMemo(
    () =>
      withWorkflowStatusPanel(
        withDefaultProductStatusPanel(modAdapter.registry?.ui.panels, {
          spinnerDimmed:
            shouldAnimateProductStatus && !productStatusSpinnerPulseOn,
          spinnerFrame:
            BRAILLE_SPINNER_FRAMES[productStatusSpinnerFrameIndex] ??
            BRAILLE_SPINNER_FRAMES[0],
          agentUrl: activeBackgroundAgentUrl,
          dreamStatus,
        }),
        workflowExecutions,
      ),
    [
      modAdapter.registry?.ui.panels,
      productStatusSpinnerFrameIndex,
      productStatusSpinnerPulseOn,
      shouldAnimateProductStatus,
      activeBackgroundAgentUrl,
      workflowExecutions,
      dreamStatus,
    ],
  );

  return {
    panelsWithDefaultProductStatus,
    panelModContext,
    subagentLifecycleSnapshot,
    subagentLifecycleTick,
  };
}
