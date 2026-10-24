// src/cli/app/pages/usage/usage-page.tsx

import { Box, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import { type ClickSegment, useLineClicks } from "@/cli/app/pages/click-line";
import { PageFrame } from "@/cli/app/pages/page-frame";
import type { PageRow } from "@/cli/app/pages/page-model";
import { Text } from "@/cli/components/Text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { readUsageLedger, type UsageRecord } from "@/usage/ledger";
import { summarizeUsage } from "@/usage/summary";
import { buildDetailRows } from "./detail";
import { buildOverviewRows, rangeLabel } from "./overview";

export type UsageScreen = "overview" | "detail";

type LedgerState =
  | { status: "loading" }
  | { status: "ready"; records: UsageRecord[] }
  | { status: "error" };

/**
 * Usage, as a page (P5).
 *
 * Two screens, one page: `Tab` switches between them (docs/38 §14.1 — the page
 * owns the keyboard, so `Tab` here is **not** the reasoning-level switch it is
 * in the app scope; the binding below is what makes that true, and there is a
 * test for the collision). The header names the screen the page is on, and that
 * one word is also the switch for the pointer: clicking it opens the other screen
 * and the word becomes that screen's name. The two words are never drawn side by
 * side (2026-10-24: "自切换不引入两个词同时显示").
 *
 * The ledger is read once when the page mounts. It is a JSONL file that only
 * grows at the end of a turn, so there is nothing to poll: switching screens is
 * instant, and a turn finishing behind the page shows up after `Esc` and a
 * re-entry — reading it every second would cost a full file parse per tick for
 * a number nobody is watching.
 *
 * Everything on the panel is English, like the settings page and the rail: one
 * panel in a second language reads as a different application (2026-10-22).
 */
export function UsagePage(view: AppViewProps) {
  const [state, setState] = useState<LedgerState>({ status: "loading" });
  const [screen, setScreen] = useState<UsageScreen>("overview");

  useEffect(() => {
    let cancelled = false;
    readUsageLedger()
      .then((records) => {
        if (!cancelled) setState({ status: "ready", records });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useKeyBindings("usage-page", [
    {
      scope: "page",
      bindings: [
        {
          id: "usage.screen.switch",
          chords: [{ key: "tab" }],
          label: "Switch screen",
          run: () => {
            setScreen((current) =>
              current === "overview" ? "detail" : "overview",
            );
            return "consumed";
          },
        },
      ],
    },
  ]);

  const now = new Date();
  const summary =
    state.status === "ready" ? summarizeUsage(state.records, now) : null;
  const body = {
    title: "Usage",
    screen,
    rows: (geometry: { width: number; height: number }): readonly PageRow[] => {
      if (state.status === "loading") {
        return [{ kind: "note", text: "Reading the usage ledger…" }];
      }
      if (state.status === "error" || !summary) {
        return [{ kind: "note", text: "Could not read the usage ledger." }];
      }
      return screen === "overview"
        ? buildOverviewRows({
            summary,
            records: state.records,
            now,
            width: geometry.width,
            height: geometry.height,
          })
        : buildDetailRows({
            summary,
            records: state.records,
            now,
            width: geometry.width,
            // The window is the current model's, and the composition line is
            // the last request's: the same model, by construction.
            contextWindow: view.contextWindowSize ?? null,
          });
    },
  };

  return (
    <PageFrame
      view={view}
      body={body}
      headerSlot={
        <UsageHeader
          screen={screen}
          range={rangeLabel(now)}
          onScreen={setScreen}
        />
      }
    />
  );
}

/** How each screen is written in the header. */
const SCREEN_LABEL: Record<UsageScreen, string> = {
  overview: "Overview",
  detail: "Detail",
};

/**
 * The header's clickable word: the screen the page is on.
 *
 * A page owns the main area, so `Tab` is the keyboard's switch and this word is
 * the pointer's. It names the current screen and opens the other one, so the
 * header always reads `Usage / <screen>` — a second word beside it would be a
 * target that changes place from under the pointer, and the user asked for the
 * name itself to be the switch (2026-10-24). The result is exactly what `Tab`
 * does, and the word the user clicked is replaced by the screen they landed on.
 *
 * The prefix, the date and the key hint are told, not aimed at: they carry no
 * target, so a click on them is spent on nothing rather than switching screens.
 */
export function usageHeaderSegments(
  screen: UsageScreen,
  range: string,
): readonly ClickSegment<UsageScreen>[] {
  const other: UsageScreen = screen === "overview" ? "detail" : "overview";
  return [
    // The page's own name, not a destination.
    { label: "Usage / " },
    // The current screen's name; clicking it opens the other screen.
    { label: SCREEN_LABEL[screen], target: other },
    { label: `   ${range}   Tab switch · Esc` },
  ];
}

function UsageHeader({
  screen,
  range,
  onScreen,
}: {
  screen: UsageScreen;
  range: string;
  onScreen: (screen: UsageScreen) => void;
}) {
  const headerRef = useRef<DOMElement | null>(null);
  useLineClicks<UsageScreen>({
    ref: headerRef,
    segments: usageHeaderSegments(screen, range),
    onSelect: (segment) => {
      if (segment.target) onScreen(segment.target);
    },
    name: "usage-screen-word",
  });

  return (
    <Box ref={headerRef} flexDirection="row">
      <Text bold>{`Usage / ${SCREEN_LABEL[screen]}`}</Text>
      <Text dimColor>{`   ${range}   Tab switch · Esc`}</Text>
    </Box>
  );
}
