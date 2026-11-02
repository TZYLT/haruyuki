// src/cli/app/pages/page-host.tsx

import type { AppViewProps } from "@/cli/app/AppView";
import { isPageTabId, type PageTabId, useTabsState } from "@/cli/app/tabs";
import { OverviewStubPage } from "./overview/overview-stub-page";
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
 * `overview` is the `+` page. Until W-15 delivers the real overview it is the
 * named stub (`overview/overview-stub-page.tsx`), so the tab, the host and the
 * keyboard path ship as one package and W-15 only swaps the component.
 */
export function PageHost(view: AppViewProps) {
  const state = useTabsState();
  const pageId: PageTabId = isPageTabId(state.activeId)
    ? state.activeId
    : "settings";
  if (pageId === "settings") return <SettingsPage {...view} />;
  if (pageId === "overview") return <OverviewStubPage {...view} />;
  return <UsagePage {...view} />;
}
