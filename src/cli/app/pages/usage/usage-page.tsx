// src/cli/app/pages/usage/usage-page.tsx

import { Box } from "ink";
import { useEffect, useState } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import { PageFrame } from "@/cli/app/pages/page-frame";
import type { PageRow } from "@/cli/app/pages/page-model";
import { Text } from "@/cli/components/Text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { readUsageLedger, type UsageRecord } from "@/usage/ledger";
import { buildDetailRows } from "./detail";
import { summarizeUsage } from "./ledger-view";
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
 * test for the collision).
 *
 * The ledger is read once when the page mounts. It is a JSONL file that only
 * grows at the end of a turn, so there is nothing to poll: switching screens is
 * instant, and a turn finishing behind the page shows up after `Esc` and a
 * re-entry — reading it every second would cost a full file parse per tick for
 * a number nobody is watching.
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
        return [{ kind: "note", text: "正在读取用量台账…" }];
      }
      if (state.status === "error" || !summary) {
        return [{ kind: "note", text: "读取用量台账失败。" }];
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
          });
    },
  };

  return (
    <PageFrame
      view={view}
      body={body}
      headerSlot={<UsageHeader screen={screen} range={rangeLabel(now)} />}
    />
  );
}

function UsageHeader({
  screen,
  range,
}: {
  screen: UsageScreen;
  range: string;
}) {
  const label = screen === "overview" ? "概览" : "明细";
  return (
    <Box flexDirection="row">
      <Text bold>{`Usage / ${label}`}</Text>
      <Text dimColor>{`   ${range}`}</Text>
      <Text>{`    ${screen === "overview" ? "Tab 明细" : "Tab 概览"} · Esc 返回`}</Text>
    </Box>
  );
}
