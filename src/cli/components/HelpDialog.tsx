import { Box } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { commands } from "@/cli/commands/registry";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { getVersion } from "@/version";
import { colors } from "./colors";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

const PAGE_SIZE = 10;

type HelpTab = "commands" | "shortcuts";
const HELP_TABS: HelpTab[] = ["commands", "shortcuts"];

interface CommandItem {
  name: string;
  description: string;
  order: number;
}

interface ShortcutItem {
  keys: string;
  description: string;
}

type HelpRow = CommandItem | ShortcutItem;

interface HelpDialogProps {
  onClose: () => void;
}

/**
 * `/help` on the overlay toolkit.
 *
 * This face is **page-aligned**: the window moves a whole page at a time, the
 * cursor is put back at the page's first row when it does, and the face prints
 * `Page n/m` itself. That is why the toolkit grew `anchor: "page"`
 * (`list-model.ts`) — `edge` and `center` both slide, and migrating onto either
 * would have changed what the list shows. `indicators` is off for the same
 * reason: the count is already in the header, in this face's own wording.
 *
 * What the toolkit owns now is the cursor and the keys. The face used to hold
 * `currentPage` *and* `selectedIndex`, and to re-derive the page-crossing
 * arithmetic for ↑/↓ itself; the page a row is on is now
 * `floor(cursor / PAGE_SIZE)`, and ↑/↓ crossing a boundary is what a contiguous
 * cursor does.
 *
 * Gained: Home/End and PageUp/PageDown step the list, which this face never
 * bound. Kept exactly: `j`/`k` (`j` is the *previous* page here, the opposite of
 * vim) and ←/→ as whole-page steps that land on the page's first row, and the
 * `↑↓ scroll · ←→ page · Tab switch · Esc cancel` footer.
 */
export function HelpDialog({ onClose }: HelpDialogProps) {
  const [activeTab, setActiveTab] = useState<HelpTab>("commands");
  const [customCommands, setCustomCommands] = useState<CommandItem[]>([]);

  // Load custom commands once on mount
  useEffect(() => {
    import("@/cli/commands/custom.js").then(({ getCustomCommands }) => {
      getCustomCommands().then((customs) => {
        setCustomCommands(
          customs.map((cmd) => ({
            name: `/${cmd.id}`,
            description: `${cmd.description} (${cmd.source}${cmd.namespace ? `:${cmd.namespace}` : ""})`,
            order: 200 + (cmd.source === "project" ? 0 : 100),
          })),
        );
      });
    });
  }, []);

  // Get all non-hidden commands, sorted by order (includes custom commands)
  const allCommands = useMemo<CommandItem[]>(() => {
    const builtins = Object.entries(commands)
      .filter(([_, cmd]) => !cmd.hidden)
      .map(([name, cmd]) => ({
        name,
        description: cmd.desc,
        order: cmd.order ?? 100,
      }));
    return [...builtins, ...customCommands].sort((a, b) => a.order - b.order);
  }, [customCommands]);

  // Keyboard shortcuts
  const shortcuts = useMemo<ShortcutItem[]>(() => {
    return [
      { keys: "/", description: "Open command autocomplete" },
      { keys: "@", description: "Open file autocomplete" },
      {
        keys: "Esc",
        description: "Cancel dialog / clear input (double press)",
      },
      { keys: "Tab", description: "Autocomplete command or file path" },
      { keys: "↓", description: "Navigate down / next command in history" },
      { keys: "↑", description: "Navigate up / previous command in history" },
      { keys: "Shift+Enter", description: "Insert newline (multi-line input)" },
      { keys: "Opt+Enter", description: "Insert newline (alternative)" },
      {
        keys: "Ctrl+C",
        description: "Interrupt operation / exit (double press)",
      },
      { keys: "Ctrl+V", description: "Paste content or image" },
    ];
  }, []);

  const visibleItems: HelpRow[] =
    activeTab === "commands" ? allCommands : shortcuts;

  const totalPages = Math.ceil(visibleItems.length / PAGE_SIZE);

  const listItems: OverlayListItem[] = useMemo(
    () =>
      visibleItems.map((item) =>
        "name" in item
          ? { key: item.name, label: item.name }
          : { key: item.keys, label: item.keys },
      ),
    [visibleItems],
  );

  const list = useOverlayList({
    owner: "help-dialog",
    items: listItems,
    rows: PAGE_SIZE,
    anchor: "page",
    // `j`/`k` are this face's page steps (and `j` is the *previous* page), so the
    // list's own vim keys stay off.
    vimKeys: false,
    onCancel: onClose,
  });

  const currentPage = Math.floor(list.cursor / PAGE_SIZE);

  const cycleTab = useCallback(() => {
    setActiveTab((current) => {
      const idx = HELP_TABS.indexOf(current);
      return HELP_TABS[(idx + 1) % HELP_TABS.length] as HelpTab;
    });
    list.setCursor(0);
  }, [list]);

  /** One page back or forward. The page's own first row is where the cursor lands. */
  const goToPage = useCallback(
    (delta: 1 | -1) => {
      const target = currentPage + delta;
      if (target < 0 || target > totalPages - 1) return "declined";
      list.setCursor(target * PAGE_SIZE);
      return "consumed";
    },
    [currentPage, list, totalPages],
  );

  useKeyBindings("help-dialog-keys", [
    {
      scope: "overlay",
      bindings: [
        {
          id: "help-dialog.cycle-tab",
          chords: [{ key: "tab" }],
          run: () => {
            cycleTab();
            return "consumed";
          },
        },
        {
          id: "help-dialog.page-back",
          chords: [
            { key: "leftArrow" },
            { key: "j" },
            { key: "j", shift: true },
          ],
          run: () => goToPage(-1),
        },
        {
          id: "help-dialog.page-forward",
          chords: [
            { key: "rightArrow" },
            { key: "k" },
            { key: "k", shift: true },
          ],
          run: () => goToPage(1),
        },
      ],
    },
  ]);

  const version = getVersion();

  const getTabLabel = (tab: HelpTab) => {
    if (tab === "commands") return `Commands (${allCommands.length})`;
    return `Shortcuts (${shortcuts.length})`;
  };

  return (
    <OverlayFrame
      command="/help"
      title={`Haruyuki v${version}`}
      footer={"↑↓ scroll · ←→ page · Tab switch · Esc cancel"}
    >
      <Box flexDirection="column" paddingLeft={1}>
        <TabBar tabs={HELP_TABS} activeTab={activeTab} getLabel={getTabLabel} />
        <Text dimColor>
          {" "}
          Page {currentPage + 1}/{totalPages}
        </Text>
      </Box>

      <OverlayListView
        items={listItems}
        cursor={list.cursor}
        rows={PAGE_SIZE}
        anchor="page"
        indicators={false}
        renderRow={(_item, index, isSelected) => {
          const row = visibleItems[index];
          if (!row) return null;

          return (
            <Box flexDirection="row" gap={1}>
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "›" : " "}
              </Text>
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Text
                    bold={isSelected}
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {"name" in row ? row.name : row.keys}
                  </Text>
                  <Box marginLeft={1}>
                    <Text dimColor>{row.description}</Text>
                  </Box>
                </Box>
              </Box>
            </Box>
          );
        }}
      />
    </OverlayFrame>
  );
}
