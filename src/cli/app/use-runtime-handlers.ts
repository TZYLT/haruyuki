import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
} from "react";
import type { PermissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";

/**
 * The shell-owned state the settings page may change.
 *
 * Two of the settings are not stored values but **running state**: `tokenStreaming`
 * and the reasoning Tab cycle live in `AppCoordinator`'s state, and their slash
 * commands (`/config stream`, `/config reasoning-tab`) flip the state *and* persist the
 * preference in the same move. A page that only wrote the file would show a value
 * the process is not using until the next start — the exact trap 《38》§12.1e 3
 * names — and it cannot reach the setters itself, because a page is a child of the
 * shell.
 *
 * So the shell hands the page a value plus a setter, and the setter is the command's
 * own body. It lives here rather than inline in `AppCoordinator` for the reason the
 * size ratchet exists: the coordinator is pinned at its cap, and this is a hook with
 * one responsibility and its own comment.
 */
export type RuntimeFlagKey = "tokenStreaming" | "reasoningTabCycle";

export type PageRuntimeProps = {
  /** What the settings page reads in place of the stored value. */
  runtimeFlags: Record<RuntimeFlagKey, boolean>;
  /** Flip a runtime flag the way its slash command does (state + preference). */
  setRuntimeFlag: (key: RuntimeFlagKey, value: boolean) => void;
};

export type RuntimeHandlers = PageRuntimeProps & {
  handlePermissionModeChange: (mode: PermissionMode) => void;
};

/** A `useState` pair, so the caller names each flag once. */
export type RuntimeState = readonly [
  value: boolean,
  set: Dispatch<SetStateAction<boolean>>,
];

export function useRuntimeHandlers(input: {
  streaming: RuntimeState;
  reasoning: RuntimeState;
  setUiPermissionMode: (mode: PermissionMode) => void;
}): RuntimeHandlers {
  const [streamingEnabled, setStreaming] = input.streaming;
  const [reasoningCycleEnabled, setReasoningCycle] = input.reasoning;
  const { setUiPermissionMode } = input;

  // The composer already calls `permissionMode.setMode` before this callback, and
  // `setUiPermissionMode` keeps the singleton in sync; this is only the state half.
  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      setUiPermissionMode(mode);
    },
    [setUiPermissionMode],
  );

  const setRuntimeFlag = useCallback(
    (key: RuntimeFlagKey, value: boolean) => {
      if (key === "tokenStreaming") {
        setStreaming(value);
        settingsManager.updateSettings({ tokenStreaming: value });
        return;
      }
      setReasoningCycle(value);
      settingsManager.updateSettings({ reasoningTabCycleEnabled: value });
    },
    [setReasoningCycle, setStreaming],
  );

  const runtimeFlags = useMemo(
    () => ({
      tokenStreaming: streamingEnabled,
      reasoningTabCycle: reasoningCycleEnabled,
    }),
    [reasoningCycleEnabled, streamingEnabled],
  );

  return { handlePermissionModeChange, runtimeFlags, setRuntimeFlag };
}
