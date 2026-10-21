// src/cli/app/pages/page-host.tsx

import type { AppViewProps } from "@/cli/app/AppView";
import { isPageTabId, type PageTabId, useTabsState } from "@/cli/app/tabs";
import { PageFrame } from "./page-frame";
import { pageBodyFor } from "./page-model";

/**
 * Which page the main area shows, and nothing else.
 *
 * The shell decides *that* a page is up (`useActiveTabIsPage`), and the tab store
 * says *which* one. Keeping the choice here means the shell never learns what a
 * Settings page is, and a page added later is one entry in this switch rather than
 * a new branch in the shell.
 */
export function PageHost(view: AppViewProps) {
  const state = useTabsState();
  const pageId: PageTabId = isPageTabId(state.activeId)
    ? state.activeId
    : "settings";
  return <PageFrame view={view} body={pageBodyFor(pageId)} />;
}
