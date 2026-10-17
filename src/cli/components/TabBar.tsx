// Shared tab bar for overlay selectors.
// Renders a row of tabs with the active one highlighted.
// Does NOT own tab state or handle input — the parent controls activeTab.

import { Box } from "ink";
import { colors } from "./colors";
import { Text } from "./Text";

export interface TabBarProps<T extends string> {
  tabs: T[];
  activeTab: T;
  getLabel: (tab: T) => string;
  /**
   * Let the row wrap onto the next line instead of running past the terminal.
   * The memory viewer needs it: an agent's block labels routinely overflow 80
   * columns, and a strip that cannot wrap is drawn wider than the frame it sits
   * in.
   */
  wrap?: boolean;
  /**
   * Space between tabs. The default suits tab names that are written bare;
   * a caller whose labels already carry their own padding (` persona `) passes 0,
   * which is what keeps the memory viewer's strip looking the way it did.
   */
  gap?: number;
}

export function TabBar<T extends string>({
  tabs,
  activeTab,
  getLabel,
  wrap,
  gap = 2,
}: TabBarProps<T>) {
  return (
    <Box flexDirection="row" gap={gap} flexWrap={wrap ? "wrap" : undefined}>
      {tabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <Text
            key={tab}
            backgroundColor={
              isActive ? colors.selector.itemHighlighted : undefined
            }
            color={isActive ? "white" : undefined}
            bold={isActive}
          >
            {` ${getLabel(tab)} `}
          </Text>
        );
      })}
    </Box>
  );
}
