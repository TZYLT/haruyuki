// src/cli/app/pages/page-host.tsx

import type { AppViewProps } from "@/cli/app/AppView";
import { isPageTabId, type PageTabId, useTabsState } from "@/cli/app/tabs";
import { OverviewPage } from "./overview/overview-page";
import { SettingsPage } from "./settings/settings-page";
import { UsagePage } from "./usage/usage-page";

/**
 * Which page the main area shows, and nothing else.
 *
 * The shell decides *that* a page is up (`useActiveTabIsPage`), and the tab store
 * says *which* one. Keeping the choice here means the shell never learns what a
 * Settings page is, and a page added later is one entry in this switch rather than
 * a new branch in the shell.
 *
 * `overview` is the `+` page: the agent→conversation overview (W-15). The tab,
 * the host and the keyboard path shipped in W-08 behind a placeholder; this is
 * the real page in the same slot, so the shell still only sees one page id.
 */
export function PageHost(view: AppViewProps) {
  const state = useTabsState();
  const pageId: PageTabId = isPageTabId(state.activeId)
    ? state.activeId
    : "settings";
  if (pageId === "settings") return <SettingsPage {...view} />;
  if (pageId === "overview") return <OverviewPage {...view} />;
  return <UsagePage {...view} />;
}
