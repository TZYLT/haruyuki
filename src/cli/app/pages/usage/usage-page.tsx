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
 * test for the collision). The header's two screen words are the same switch for
 * the pointer, including the one you are already on: clicking a word sets that
 * screen, never toggles, so a stray click cannot drop you somewhere you did not
 * aim at.
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
 * The header's clickable words: the screen the page is on, and the other one.
 *
 * A page owns the main area, so `Tab` is the keyboard's switch and these words are
 * the pointer's. Both are drawn — the current one inside the breadcrumb, the other
 * beside it — because a pointer target that only appears while you are on the
 * *other* screen is a target you cannot see when you need it. Clicking either sets
 * that screen (never toggles), which is exactly what `Tab` does.
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
    { label: SCREEN_LABEL[screen], target: screen },
    { label: "   " },
    { label: SCREEN_LABEL[other], target: other },
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
  const other: UsageScreen = screen === "overview" ? "detail" : "overview";
  useLineClicks<UsageScreen>({
    ref: headerRef,
    segments: usageHeaderSegments(screen, range),
    onSelect: (segment) => {
      if (segment.target) onScreen(segment.target);
    },
    name: "usage-screen-words",
  });

  return (
    <Box ref={headerRef} flexDirection="row">
      <Text bold>{`Usage / ${SCREEN_LABEL[screen]}`}</Text>
      <Text>{`   ${SCREEN_LABEL[other]}`}</Text>
      <Text dimColor>{`   ${range}   Tab switch · Esc`}</Text>
    </Box>
  );
}
