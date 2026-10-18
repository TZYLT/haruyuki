/**
 * SubagentManager component - displays available subagents
 *
 * A read-only listing: there is no cursor and nothing to pick, so it has no list
 * navigation — only the three ways out (Escape, Enter, Ctrl+C). Those are a key
 * table now rather than a `useInput` handler, and the chrome is the frame every
 * other overlay draws, so the overlay claims its input scope like the rest.
 */

import { Box } from "ink";
import { useEffect, useState } from "react";
import {
  AGENTS_DIR,
  clearSubagentConfigCache,
  GLOBAL_AGENTS_DIR,
  getAllSubagentConfigs,
  getBuiltinSubagentNames,
  type SubagentConfig,
} from "@/agent/subagents";
import { type KeyBinding, namedKeyChords } from "@/cli/helpers/input-keys";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { colors } from "./colors";
import { Text } from "./Text";

const TITLE = "Available Subagents";

interface SubagentManagerProps {
  onClose: () => void;
}

interface SubagentItem {
  name: string;
  config: SubagentConfig;
}

export function SubagentManager({ onClose }: SubagentManagerProps) {
  const [builtinSubagents, setBuiltinSubagents] = useState<SubagentItem[]>([]);
  const [customSubagents, setCustomSubagents] = useState<SubagentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadSubagents() {
      setLoading(true);
      setError(null);
      try {
        clearSubagentConfigCache();
        const configs = await getAllSubagentConfigs();
        const builtinNames = getBuiltinSubagentNames();
        const builtin: SubagentItem[] = [];
        const custom: SubagentItem[] = [];

        for (const [name, config] of Object.entries(configs)) {
          const item = { name, config };
          if (builtinNames.has(name)) {
            builtin.push(item);
          } else {
            custom.push(item);
          }
        }

        builtin.sort((a, b) => a.name.localeCompare(b.name));
        custom.sort((a, b) => a.name.localeCompare(b.name));

        setBuiltinSubagents(builtin);
        setCustomSubagents(custom);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    loadSubagents();
  }, []);

  // Unconditional: the overlay is closable from every state, including while the
  // configs are still loading, which is what the hand-written handler did.
  const bindings: KeyBinding[] = [
    {
      id: "subagent-manager.close",
      chords: [
        { key: "c", ctrl: true },
        ...namedKeyChords("escape"),
        ...namedKeyChords("return"),
      ],
      run: () => {
        onClose();
        return "consumed";
      },
    },
  ];

  useKeyBindings("subagent-manager", [{ scope: "overlay", bindings }]);

  const hints = (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>
        To add custom subagents, create .md files in {AGENTS_DIR}/ (project) or{" "}
        {GLOBAL_AGENTS_DIR}/ (global)
      </Text>
      <Text dimColor>Press ESC or Enter to close</Text>
    </Box>
  );

  const renderSubagentList = (items: SubagentItem[]) =>
    items.map((item, index) => (
      <Box
        key={item.name}
        flexDirection="column"
        marginBottom={index < items.length - 1 ? 1 : 0}
      >
        <Box gap={1}>
          <Text bold color={colors.selector.itemHighlighted}>
            {item.name}
          </Text>
        </Box>
        <Text> {item.config.description}</Text>
      </Box>
    ));

  if (loading) {
    return (
      <OverlayFrame command="/subagents" title={TITLE} footer={hints}>
        <Text>Loading subagents...</Text>
      </OverlayFrame>
    );
  }

  const hasNoSubagents =
    builtinSubagents.length === 0 && customSubagents.length === 0;

  return (
    <OverlayFrame command="/subagents" title={TITLE} footer={hints}>
      <Box flexDirection="column" gap={1}>
        {error && <Text color={colors.status.error}>Error: {error}</Text>}

        {hasNoSubagents ? (
          <Text dimColor>No subagents found</Text>
        ) : (
          <>
            {builtinSubagents.length > 0 && (
              <Box flexDirection="column">
                <Text bold dimColor>
                  Built-in
                </Text>
                {renderSubagentList(builtinSubagents)}
              </Box>
            )}

            {customSubagents.length > 0 && (
              <Box flexDirection="column">
                <Text bold dimColor>
                  Custom
                </Text>
                {renderSubagentList(customSubagents)}
              </Box>
            )}
          </>
        )}
      </Box>
    </OverlayFrame>
  );
}
