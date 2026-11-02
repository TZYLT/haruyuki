import { Box } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { colors } from "@/cli/components/colors";
import { ProviderSelector } from "@/cli/components/ProviderSelector";
import { Text } from "@/cli/components/Text";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayTextField } from "@/cli/overlay/text-view";
import {
  createDefaultAgentAfterConnect,
  formatDisconnectedMessageHint,
  formatOAuthShellGuidance,
  listConnectedProviderNames,
  type NoProviderConnectResult,
} from "./provider-connection";

/**
 * T-07's `--no-provider` empty state (47-2 §1.6, R-07.3–R-07.5).
 *
 * Two stages, because the surface must both explain the state and offer the
 * connect path:
 *
 * - **message**: the explanation, the two connection routes, and a real message
 *   line. A message sent here is not silently dropped — R-07.5 requires a line
 *   pointing at the connection, and that line is what this stage paints.
 * - **connect**: the reused `ProviderSelector` (the API-key path). Esc returns
 *   to the message stage; an OAuth provider leaves it and prints the shell
 *   guidance instead, because that sign-in runs outside the TUI.
 *
 * The surface never builds an agent itself and never picks a model: connecting a
 * provider is what triggers the default-agent creation (Q-44), and a failure
 * comes back here as one line (47-2 §2.5) rather than an exit.
 */

/** The I/O this surface needs; tests inject fakes instead of a real store. */
export interface NoProviderDeps {
  listConnectedProviders: () => Promise<string[]>;
  completeConnection: () => Promise<NoProviderConnectResult>;
  /** How often the empty state looks for a provider appearing in the store. */
  pollIntervalMs: number;
}

export interface NoProviderEmptyStateProps {
  onConnected: (agentId: string) => void;
  /** Ctrl+C in this state; defaults to leaving the process. */
  onCancel?: () => void;
  /** Test seam only; production omits it and gets the real store/catalog. */
  deps?: Partial<NoProviderDeps>;
}

const DEFAULT_DEPS: NoProviderDeps = {
  listConnectedProviders: listConnectedProviderNames,
  completeConnection: createDefaultAgentAfterConnect,
  pollIntervalMs: 1000,
};

type Stage = "message" | "connect";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NoProviderEmptyState({
  onConnected,
  onCancel,
  deps: overrides,
}: NoProviderEmptyStateProps) {
  const deps: NoProviderDeps = { ...DEFAULT_DEPS, ...overrides };
  const [stage, setStage] = useState<Stage>("message");
  const [message, setMessage] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Set when a detected connection failed to become an agent: polling stops so
  // a broken provider store cannot spin, and re-entering the connect step
  // re-arms it (the user's own action).
  const [autoContinueBlocked, setAutoContinueBlocked] = useState(false);
  const connectingRef = useRef(false);
  // Entering the session happens once: the poll runs until the parent swaps
  // this surface out, and a second tick must not hand over a second agent.
  const completedRef = useRef(false);
  // The poll owns no render-triggering state besides `connecting`; keeping the
  // I/O in a ref means a caller's inline `onConnected`/`deps` cannot restart the
  // interval on every render.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Ctrl+C from the empty state, the same exit an overlay's cancel does.
  useKeyBindings("no-provider-empty-state", [
    {
      scope: "app",
      bindings: [
        {
          id: "no-provider.empty-state.cancel",
          chords: [{ key: "c", ctrl: true }],
          run: () => {
            (onCancel ?? (() => process.exit(0)))();
            return "consumed";
          },
        },
      ],
    },
  ]);

  useEffect(() => {
    if (autoContinueBlocked) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const checkStore = async () => {
      const activeDeps = depsRef.current;
      if (cancelled || connectingRef.current || completedRef.current) return;
      try {
        const names = await activeDeps.listConnectedProviders();
        if (cancelled || completedRef.current || names.length === 0) return;
        connectingRef.current = true;
        setConnecting(true);
        setError(null);
        const result = await activeDeps.completeConnection();
        if (cancelled) return;
        if (result.kind === "connected") {
          completedRef.current = true;
          if (timer) clearInterval(timer);
          onConnectedRef.current(result.agentId);
          return;
        }
        setError(result.message);
        setAutoContinueBlocked(true);
      } catch (caught) {
        if (cancelled) return;
        setError(
          `Could not read the provider list: ${errorMessage(caught)}. Run /config connect or haruyuki connect <provider> in a shell.`,
        );
        setAutoContinueBlocked(true);
      } finally {
        connectingRef.current = false;
        if (!cancelled) setConnecting(false);
      }
    };

    void checkStore();
    timer = setInterval(() => {
      void checkStore();
    }, depsRef.current.pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [autoContinueBlocked]);

  const openConnectStep = useCallback(() => {
    setAutoContinueBlocked(false);
    setError(null);
    setStage("connect");
  }, []);

  const handleMessageSubmit = useCallback(
    (value: string) => {
      if (value.trim().length > 0) {
        setHint(formatDisconnectedMessageHint());
        setMessage("");
        return;
      }
      openConnectStep();
    },
    [openConnectStep],
  );

  return (
    <Box flexDirection="column">
      <Text bold color={colors.selector.title}>
        Haruyuki is not connected
      </Text>
      <Text dimColor>
        No LLM provider is connected yet, so there is no agent and no model.
        Nothing will be sent until a provider is connected.
      </Text>

      <Box height={1} />

      <Text bold>Connect a provider</Text>
      <Text>
        {"  "}• In the TUI:{" "}
        <Text color={colors.selector.title}>/config connect</Text>
        {"  "}(choose a provider and paste its API key)
      </Text>
      <Text>
        {"  "}• In a shell:{" "}
        <Text color={colors.selector.title}>
          haruyuki connect &lt;provider&gt;
        </Text>
        {"  "}(for example: haruyuki connect deepseek)
      </Text>

      <Box height={1} />

      {stage === "message" ? (
        <Box flexDirection="column">
          <OverlayTextField
            marker="Message: "
            value={message}
            onChange={(next) => {
              setMessage(next);
              if (hint) setHint(null);
            }}
            onSubmit={handleMessageSubmit}
            placeholder="(press Enter on an empty line to open the provider list)"
          />
          <Text dimColor>
            {"  "}Press Enter on an empty line to open the provider list here.
          </Text>
          {hint ? (
            <Box marginTop={1}>
              <Text color={colors.selector.title}>{hint}</Text>
            </Box>
          ) : null}
        </Box>
      ) : (
        <ProviderSelector
          onCancel={() => setStage("message")}
          onStartOAuth={(provider) => {
            setStage("message");
            setHint(formatOAuthShellGuidance(provider.displayName));
          }}
        />
      )}

      {connecting ? (
        <Box marginTop={1}>
          <Text color={colors.selector.title}>
            Provider connected. Creating your agent…
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
