import { afterEach, describe, expect, test } from "bun:test";
import { Text } from "@/cli/components/Text";
import type { KeyEvent } from "@/cli/helpers/input-keys";
import { matchingBindings } from "@/cli/helpers/input-keys";
import { keyEventFrom } from "@/cli/helpers/input-sequence";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { OverlayFrame } from "./frame";
import {
  useWizard,
  type WizardKeyHost,
  wizardBack,
  wizardBindings,
  wizardForward,
  wizardPopTo,
} from "./wizard";

/**
 * The trail is a value and the keys are a table, so both halves are asserted
 * where they are decided: the arithmetic as data, the two keys through the same
 * dispatch walk the router does (first matching binding that consumes wins).
 *
 * The mounted probe at the end is the other half of that: the table can be
 * perfectly correct and reach nothing, because the router consults only the
 * scope its owner claimed — `useWizard` does not claim one (it binds nothing),
 * and the frame it is rendered inside does. A test that only dispatched the
 * table would pass with the overlay's keys dead in the app.
 */

const ESC = "\u001b";
const CTRL_C = "\u0003";

function dispatch(host: WizardKeyHost, event: KeyEvent): string | undefined {
  for (const binding of matchingBindings(wizardBindings(host), event)) {
    if (binding.run(event) === "consumed") return binding.id;
  }
  return undefined;
}

interface Harness {
  host: WizardKeyHost;
  backs: number;
  cancels: number;
}

function harness(overrides: Partial<WizardKeyHost> = {}): Harness {
  const state = {
    backs: 0,
    cancels: 0,
    host: null as unknown as WizardKeyHost,
  };
  state.host = {
    canGoBack: true,
    onBack: () => {
      state.backs += 1;
    },
    onCancel: () => {
      state.cancels += 1;
    },
    ...overrides,
  };
  return state;
}

describe("the wizard trail", () => {
  test("walking forward appends, and re-entering the current step does not", () => {
    const root = ["root"] as const;
    expect(wizardForward(root, "a")).toEqual(["root", "a"]);
    // A face that re-opens the view it is already showing must not leave a
    // duplicate behind for Escape to walk back through.
    const walked = wizardForward(root, "a");
    expect(wizardForward(walked, "a")).toBe(walked);
  });

  test("pop removes one step, and the root is never popped", () => {
    const root = ["root"] as const;
    expect(wizardBack(root)).toBe(root);
    expect(wizardBack(["root", "a"])).toEqual(["root"]);
  });

  test("popTo keeps the step it names and drops everything above it", () => {
    expect(
      wizardPopTo(["events", "hooks", "matcher", "command"], "hooks"),
    ).toEqual(["events", "hooks"]);
    expect(wizardPopTo(["events", "hooks"], "hooks")).toEqual([
      "events",
      "hooks",
    ]);
    // A step the trail never visited is a bug in the face: the trail is handed
    // back untouched rather than collapsed to a step nobody pushed.
    const trail = ["events", "hooks"] as const;
    expect(wizardPopTo(trail, "command")).toBe(trail);
  });
});

describe("wizardBindings", () => {
  test("Escape goes back one step when there is one", () => {
    const host = harness({ canGoBack: true });
    expect(dispatch(host.host, keyEventFrom(ESC, { escape: true }))).toBe(
      "overlay-wizard.back",
    );
    expect(host.backs).toBe(1);
    expect(host.cancels).toBe(0);
  });

  test("Escape cancels at the root, where there is nowhere to go", () => {
    const host = harness({ canGoBack: false });
    expect(dispatch(host.host, keyEventFrom(ESC, { escape: true }))).toBe(
      "overlay-wizard.back",
    );
    expect(host.backs).toBe(0);
    expect(host.cancels).toBe(1);
  });

  test("a doubled Escape is still the cancel key", () => {
    // A doubled Escape arrives as escape + meta; the rule must match either
    // reading, or leaving `/connect`'s deepest step would take two presses.
    const host = harness({ canGoBack: false });
    dispatch(host.host, keyEventFrom(ESC, { escape: true, meta: true }));
    expect(host.cancels).toBe(1);
  });

  test("Ctrl+C cancels from a step where Escape would go back", () => {
    const host = harness({ canGoBack: true });
    expect(dispatch(host.host, keyEventFrom("c", { ctrl: true }))).toBe(
      "overlay-wizard.cancel",
    );
    expect(host.backs).toBe(0);
    expect(host.cancels).toBe(1);
  });

  test("the face's own binding is tried first, and declining reaches the rule", () => {
    let cleared = 0;
    const host = harness({
      canGoBack: false,
      extra: [
        {
          id: "connect.clear-filter",
          chords: [{ key: "escape" }],
          run: () => {
            // The `/connect` list: Escape clears the filter while there is one,
            // and declines when there is not, so the wizard's rule still runs.
            if (cleared > 0) return "declined";
            cleared += 1;
            return "consumed";
          },
        },
      ],
    });

    expect(dispatch(host.host, keyEventFrom(ESC, { escape: true }))).toBe(
      "connect.clear-filter",
    );
    expect(host.cancels).toBe(0);

    expect(dispatch(host.host, keyEventFrom(ESC, { escape: true }))).toBe(
      "overlay-wizard.back",
    );
    expect(host.cancels).toBe(1);
  });

  test("every binding declares a chord and a unique id", () => {
    const table = wizardBindings(harness().host);
    const ids = table.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const binding of table) {
      expect(binding.chords?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

type Step = "root" | "a" | "b";

/**
 * A four-step overlay in miniature: the two wizard keys, plus push/pop keys so
 * a test can walk the trail from the keyboard the way a face does.
 */
function Probe({ log }: { log: string[] }) {
  const wizard = useWizard<Step>({ initial: "root" });

  useKeyBindings("wizard-probe", [
    {
      scope: "overlay",
      bindings: wizardBindings({
        canGoBack: wizard.canGoBack,
        onBack: () => {
          log.push("back");
          wizard.back();
        },
        onCancel: () => log.push("cancel"),
        extra: [
          {
            id: "probe.push-a",
            chords: [{ key: "a" }],
            run: () => {
              wizard.goTo("a");
              return "consumed";
            },
          },
          {
            id: "probe.push-b",
            chords: [{ key: "b" }],
            run: () => {
              wizard.goTo("b");
              return "consumed";
            },
          },
          {
            id: "probe.pop-to-a",
            chords: [{ key: "p" }],
            run: () => {
              wizard.popTo("a");
              return "consumed";
            },
          },
        ],
      }),
    },
  ]);

  return (
    <OverlayFrame command="/probe" title={wizard.step}>
      <Text>{`trail ${wizard.trail.join(">")}`}</Text>
      <Text>{`canGoBack ${String(wizard.canGoBack)}`}</Text>
    </OverlayFrame>
  );
}

async function withProbe(
  run: (tty: ReturnType<typeof mountInkTty>, log: string[]) => Promise<void>,
): Promise<void> {
  const log: string[] = [];
  const tty = mountInkTty(<Probe log={log} />, { columns: 60, rows: 20 });
  try {
    await run(tty, log);
  } finally {
    tty.stop();
  }
}

afterEach(resetInkTtyState);

describe("the wizard on screen", () => {
  test("Escape walks the trail back and cancels only at the root", async () => {
    await withProbe(async (tty, log) => {
      expect((await tty.text()).includes("trail root")).toBe(true);

      // Root: Escape is the cancel. The probe does not unmount, so the frame
      // still shows the root step — what matters is that cancel ran and the
      // trail did not move.
      await tty.press(ESC);
      expect(log).toEqual(["cancel"]);

      // Two steps deep, Escape goes back one and the frame follows.
      await tty.press("a", "b");
      let painted = await tty.text();
      expect(painted.includes("trail root>a>b")).toBe(true);
      expect(painted.includes("canGoBack true")).toBe(true);

      await tty.press(ESC);
      expect(log).toEqual(["cancel", "back"]);
      painted = await tty.text();
      expect(painted.includes("trail root>a")).toBe(true);

      await tty.press(ESC, ESC);
      expect(log).toEqual(["cancel", "back", "back", "cancel"]);
      expect((await tty.text()).includes("trail root")).toBe(true);
    });
  });

  test("Ctrl+C cancels from a step Escape would only walk back from", async () => {
    await withProbe(async (tty, log) => {
      await tty.press("a", "b", CTRL_C);
      expect(log).toEqual(["cancel"]);
      // Cancelled, not popped: a cancel is not a step transition.
      expect((await tty.text()).includes("trail root>a>b")).toBe(true);
    });
  });

  test("popTo lands on a step below, and Escape from there still walks back", async () => {
    await withProbe(async (tty, log) => {
      await tty.press("a", "b", "p");
      let painted = await tty.text();
      expect(painted.includes("trail root>a")).toBe(true);

      // The step below survived the collapse: Escape returns to the root rather
      // than cancelling, which is what makes `popTo` a return and not a reset.
      await tty.press(ESC);
      expect(log).toEqual(["back"]);
      painted = await tty.text();
      expect(painted.includes("trail root")).toBe(true);
      expect(painted.includes("canGoBack false")).toBe(true);

      await tty.press(ESC);
      expect(log).toEqual(["back", "cancel"]);
    });
  });

  test("re-entering the step already on screen leaves no duplicate to walk back through", async () => {
    await withProbe(async (tty, log) => {
      await tty.press("a", "a", "a");
      expect((await tty.text()).includes("trail root>a")).toBe(true);

      // One Escape reaches the root: a trail of `root>a>a>a` would need three.
      await tty.press(ESC);
      expect(log).toEqual(["back"]);
      expect((await tty.text()).includes("canGoBack false")).toBe(true);
    });
  });
});
