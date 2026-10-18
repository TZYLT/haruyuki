import { afterEach, describe, expect, test } from "bun:test";
import { OverlayFrame } from "@/cli/overlay/frame";
import type {
  ByokProvider,
  ProviderResponse,
} from "@/providers/byok-providers";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { ProviderOptionsView } from "./provider-selector-options-view";

/**
 * The manage step, pinned row for row.
 *
 * The expected rows are not invented here: they are the frame the **pre-migration**
 * component painted for the same provider and connections (captured before the
 * face moved onto the toolkit, and byte-identical to what it painted after). The
 * view was then lifted out of the face into this module, so this is what holds
 * the picture still across that move.
 */

afterEach(resetInkTtyState);

const PROVIDER = {
  providerName: "deepseek",
  displayName: "DeepSeek",
  providerType: "deepseek",
} as ByokProvider;

const RECORD = {
  id: "local-provider-deepseek",
  name: "deepseek",
  provider_type: "deepseek",
  provider_category: "byok",
  auth_type: "api",
} as ProviderResponse;

const OPTIONS = ["Disconnect deepseek", "Back"];

interface Options {
  records?: readonly ProviderResponse[];
  showUsage?: boolean;
  usage?: Record<
    string,
    | { status: "loading" }
    | { status: "ready"; rows: string[] }
    | { status: "error"; message: string }
  >;
  optionIndex?: number;
}

async function optionsFrame(options: Options = {}): Promise<string[]> {
  const tty = mountInkTty(
    <OverlayFrame command="/connect">
      <ProviderOptionsView
        provider={PROVIDER}
        options={OPTIONS}
        connectedRecords={options.records ?? [RECORD]}
        showUsage={options.showUsage ?? false}
        usageByProvider={options.usage ?? {}}
        optionIndex={options.optionIndex ?? 0}
      />
    </OverlayFrame>,
    { columns: 100, rows: 30 },
  );
  try {
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

describe("ProviderOptionsView", () => {
  test("paints the manage step the way the face always did", async () => {
    const rows = await optionsFrame();
    expect(rows).toEqual([
      "> /connect",
      "─".repeat(100),
      "",
      "Manage DeepSeek",
      "",
      "  [✓] deepseek · Connected",
      "",
      "> Disconnect deepseek",
      "  Back",
      "",
      "  Enter confirm · ↑↓ navigate · Esc back",
    ]);
  });

  test("the cursor follows the option index", async () => {
    const rows = await optionsFrame({ optionIndex: 1 });
    expect(rows.slice(7, 9)).toEqual(["  Disconnect deepseek", "> Back"]);
  });

  test("a provider with no connections says so", async () => {
    const rows = await optionsFrame({ records: [] });
    expect(rows).toContain("  No connected providers.");
  });

  test("the usage panel follows the read it is showing", async () => {
    const loading = await optionsFrame({ showUsage: true });
    expect(loading.join("\n")).toContain("      Loading...");

    const error = await optionsFrame({
      showUsage: true,
      usage: { deepseek: { status: "error", message: "no token" } },
    });
    expect(error.join("\n")).toContain("      Unavailable: no token");

    const ready = await optionsFrame({
      showUsage: true,
      usage: { deepseek: { status: "ready", rows: ["5h: 90%", "week: 40%"] } },
    });
    const painted = ready.join("\n");
    expect(painted).toContain("      5h: 90%");
    expect(painted).toContain("      week: 40%");
    expect(painted).not.toContain("Loading...");
  });

  test("the usage panel is absent for a provider that has none", async () => {
    const rows = await optionsFrame({
      usage: { deepseek: { status: "ready", rows: ["5h: 90%"] } },
    });
    expect(rows.join("\n")).not.toContain("5h: 90%");
  });
});
