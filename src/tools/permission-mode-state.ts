import {
  permissionMode as globalPermissionMode,
  type PermissionMode,
} from "@/permissions/mode";

/** Mutable, shared-by-reference permission mode state. */
export type PermissionModeState = {
  mode: PermissionMode;
  /**
   * True while an unattended scheduled run owns this state (F-05 Q-51).
   *
   * Set by the task runner for the duration of one scheduled run and cleared
   * afterwards. `checkPermission` turns any `ask`/`alwaysAsk` into a deny with
   * reason `unattended`, so no approval request is ever built for a run nobody
   * is watching. Absent means "a human may be present" (the pre-F-05 behaviour).
   */
  unattended?: boolean;
};

export function getEffectivePermissionModeState(
  permissionModeState?: PermissionModeState,
): PermissionModeState {
  return (
    permissionModeState ?? {
      get mode() {
        return globalPermissionMode.getMode();
      },
      set mode(value: PermissionMode) {
        globalPermissionMode.setMode(value);
      },
    }
  );
}
