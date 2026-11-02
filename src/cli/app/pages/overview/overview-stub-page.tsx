// src/cli/app/pages/overview/overview-stub-page.tsx

import type { AppViewProps } from "@/cli/app/AppView";
import { PageFrame } from "@/cli/app/pages/page-frame";

/**
 * The `+` tab's page, as a placeholder (W-08).
 *
 * **This file is temporary and is deleted when W-15 delivers the real page**
 * (《47-2》§1.9 修正 4 / §4.2 W-15). It exists only so the tab, the page host and
 * the keyboard path can be wired and judged before the overview has data: the
 * third fixed page is reachable, it owns the main area, and it leaves by `Esc`
 * exactly as `Usage` and `Settings` do.
 *
 * The frame supplies everything a page is (`page-frame.tsx`): the band height, the
 * rail, the title row, the `page` keyboard scope, `Esc` back to the conversation
 * and the pointer band. The placeholder's only content is the title and the empty
 * state — the agent list that replaces it is W-15's, and it reads its data from
 * W-12/W-13, which this package must not anticipate.
 *
 * The title is `Agents`: that is the overview's name (《47-1》C-14), while the tab
 * itself shows the compact `+` (Q-43).
 */
export function OverviewStubPage(view: AppViewProps) {
  return (
    <PageFrame
      view={view}
      body={{
        title: "Agents",
        rows: [{ kind: "note", text: "No agents to show yet." }],
      }}
    />
  );
}
