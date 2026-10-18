import { Box } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { clearAvailableModelsCache } from "@/agent/available-models";
import {
  getPiProviderRegistryRevision,
  subscribePiProviderRegistry,
} from "@/backend/dev/pi-provider-mod-registry";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { OverlayFrame } from "@/cli/overlay/frame";
import { listBindings } from "@/cli/overlay/list-bindings";
import { type OverlayListItem, visibleWindow } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { OverlayTextField } from "@/cli/overlay/text-view";
import { useWizard, wizardBindings } from "@/cli/overlay/wizard";
import {
  type AuthMethod,
  type ByokProvider,
  checkProviderApiKey,
  createOrUpdateProvider,
  defaultProviderApiKey,
  defaultProviderStorageTarget,
  getConnectedProviders,
  getProviderConfigs,
  type ProviderField,
  type ProviderResponse,
  type ProviderStorageTarget,
  removeProviderByName,
} from "@/providers/byok-providers";
import {
  formatChatGPTUsageQuotaRows,
  readChatGPTUsage,
} from "@/providers/chatgpt-usage-service";
import { normalizeChatGPTOAuthProviderName } from "@/providers/openai-codex-provider";
import { connectedRecordsForProvider } from "@/providers/provider-connections";
import { settingsManager } from "@/settings-manager";
import { type AwsProfile, parseAwsCredentials } from "@/utils/aws-credentials";
import { debugLog } from "@/utils/debug";
import { colors } from "./colors";
import {
  type ConnectedProvidersByTarget,
  connectedProviderSummary,
  connectProviderTabOrder,
  fieldValuesFromProviderPlaceholders,
  filterProviderConfigs,
  formatConnectProviderTab,
  hasCloudProviderStoreCredentials,
  isChatGPTUsageProvider,
  isProviderTargetLoading,
  nextProviderConnectionName,
  providerApiKeyFromInput,
  providerManageActionLabel,
  providerManageActions,
  providerSelectionFlow,
  shouldForceLocalProviderTab,
  shouldShowProviderStoreTabs,
} from "./provider-selector-helpers";
import {
  type ChatGPTUsageStatus,
  ProviderOptionsView,
} from "./provider-selector-options-view";
import {
  type ConnectStep,
  type ConnectSubject,
  type ConnectViewState,
  viewFor,
} from "./provider-selector-steps";
import { Text } from "./Text";

const VISIBLE_PROVIDERS = 8;

type ValidationState = "idle" | "validating" | "valid" | "invalid" | "saving";

interface ProviderSelectorProps {
  onCancel: () => void;
  /** Called when an OAuth flow should start */
  onStartOAuth?: (
    provider: ByokProvider,
    target: ProviderStorageTarget,
    providerName?: string,
  ) => void;
}

export {
  canConnectAnotherProvider,
  connectAnotherProviderOption,
  connectedProviderSummary,
  fieldValuesFromProviderPlaceholders,
  filterProviderConfigs,
  hasCloudProviderStoreCredentials,
  isChatGPTUsageProvider,
  isProviderTargetLoading,
  nextProviderConnectionName,
  providerApiKeyFromInput,
  providerSelectionFlow,
  shouldShowProviderStoreTabs,
} from "./provider-selector-helpers";

export function ProviderSelector({
  onCancel,
  onStartOAuth,
}: ProviderSelectorProps) {
  // State
  const [selectedTarget, setSelectedTarget] = useState<ProviderStorageTarget>(
    defaultProviderStorageTarget(),
  );
  const [hasCloudCredentials, setHasCloudCredentials] = useState<
    boolean | null
  >(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [connectedProvidersByTarget, setConnectedProvidersByTarget] =
    useState<ConnectedProvidersByTarget>({});
  const [loadingTargets, setLoadingTargets] = useState<
    Set<ProviderStorageTarget>
  >(new Set());
  // The step is the wizard's, the payload is the face's; `viewState` is what
  // both of them say together, so the renderers below read it unchanged. It is
  // memoized on purpose: three effects and several callbacks compare it by
  // identity, which is how it behaved when it was the state itself.
  const wizard = useWizard<ConnectStep>({ initial: "list" });
  const {
    goTo: goToStep,
    back: stepBack,
    popTo: popToList,
    canGoBack,
  } = wizard;
  const [subject, setSubject] = useState<ConnectSubject | null>(null);
  const viewState: ConnectViewState = useMemo(
    () => viewFor(wizard.step, subject),
    [wizard.step, subject],
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [providerNameInput, setProviderNameInput] = useState("");
  const [providerNameError, setProviderNameError] = useState<string | null>(
    null,
  );
  const [validationState, setValidationState] =
    useState<ValidationState>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [optionIndex, setOptionIndex] = useState(0);
  const [chatGPTUsageByProvider, setChatGPTUsageByProvider] = useState<
    Record<string, ChatGPTUsageStatus>
  >({});
  // Multi-field input state (for providers like Bedrock)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [focusedFieldIndex, setFocusedFieldIndex] = useState(0);
  // Auth method selection state (for providers with multiple auth options)
  const [methodIndex, setMethodIndex] = useState(0);
  // AWS profile selection state
  const [awsProfiles, setAwsProfiles] = useState<AwsProfile[]>([]);
  const [profileIndex, setProfileIndex] = useState(0);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  useSyncExternalStore(
    subscribePiProviderRegistry,
    getPiProviderRegistryRevision,
    getPiProviderRegistryRevision,
  );
  const providers = getProviderConfigs(selectedTarget);
  const filteredProviders = filterProviderConfigs(providers, searchQuery);
  const showProviderStoreTabs =
    shouldShowProviderStoreTabs(hasCloudCredentials);
  const connectedProviders = useMemo(
    () => connectedProvidersByTarget[selectedTarget] ?? new Map(),
    [connectedProvidersByTarget, selectedTarget],
  );
  const isLoading = isProviderTargetLoading({
    selectedTarget,
    connectedProvidersByTarget,
    showProviderStoreTabs,
  });
  const selectableProviders = filteredProviders;
  // The window the list shows, from the toolkit's own arithmetic: `edge` keeps
  // the cursor on the bottom edge, which is the shape this list already had.
  // The view is handed the same three values, so it windows identically, and
  // `indicators: false` because this face prints the count itself, in the
  // wording it always used (and, at the end of a long list, a blank row in its
  // place so the frame's height does not move with the cursor).
  const providerWindow = visibleWindow({
    count: selectableProviders.length,
    cursor: selectedIndex,
    rows: VISIBLE_PROVIDERS,
    anchor: "edge",
  });
  const providerItems = useMemo(
    () =>
      selectableProviders.map(
        (provider): OverlayListItem => ({
          key: provider.id,
          label: provider.displayName,
        }),
      ),
    [selectableProviders],
  );

  /**
   * Walk forward to a step, carrying the provider it is about. The payload goes
   * with the step in one handler, so the two cannot disagree about what is on
   * screen.
   */
  const openStep = useCallback(
    (
      next: ConnectStep,
      provider: ByokProvider,
      authMethod: AuthMethod | null = null,
    ) => {
      setSubject({ provider, authMethod });
      goToStep(next);
    },
    [goToStep],
  );

  /** Back to the list, and forget the provider with it. */
  const returnToList = useCallback(() => {
    setSubject(null);
    popToList("list");
  }, [popToList]);

  /**
   * Escape from a step that has somewhere to go back to: this face's own fields
   * are cleared first (the wizard's stack only knows the path, not what a step
   * holds), then the trail is popped. The conditional escapes the hand-written
   * ladder had — `/connect`'s multi-field step returns to the method picker only
   * when it was the picker that opened it — are gone: the trail *is* the path
   * that was taken.
   */
  const leaveStep = useCallback(() => {
    if (viewState.type === "input") {
      setApiKeyInput("");
      setValidationState("idle");
      setValidationError(null);
    } else if (viewState.type === "methodSelect") {
      setMethodIndex(0);
    } else if (viewState.type === "profileSelect") {
      setMethodIndex(0);
      setAwsProfiles([]);
      setProfileIndex(0);
    } else if (viewState.type === "multiInput") {
      setFieldValues({});
      setFocusedFieldIndex(0);
      setValidationState("idle");
      setValidationError(null);
    } else if (viewState.type === "oauthNameInput") {
      setProviderNameError(null);
    }
    stepBack();
  }, [viewState, stepBack]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    settingsManager
      .getSettingsWithSecureTokens()
      .then((settings) => {
        if (cancelled || !mountedRef.current) return;
        setHasCloudCredentials(hasCloudProviderStoreCredentials(settings));
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setHasCloudCredentials(Boolean(process.env.LETTA_API_KEY));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setConnectedProvidersForTarget = useCallback(
    (
      target: ProviderStorageTarget,
      providers: Map<string, ProviderResponse>,
    ) => {
      setConnectedProvidersByTarget((previous) => ({
        ...previous,
        [target]: providers,
      }));
    },
    [],
  );

  const refreshConnectedProviders = useCallback(
    async (target: ProviderStorageTarget) => {
      setLoadingTargets((previous) => new Set(previous).add(target));
      try {
        const providers = await getConnectedProviders({ target });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(target, providers);
        }
      } catch {
        if (mountedRef.current) {
          setConnectedProvidersForTarget(target, new Map());
        }
      } finally {
        if (mountedRef.current) {
          setLoadingTargets((previous) => {
            const next = new Set(previous);
            next.delete(target);
            return next;
          });
        }
      }
    },
    [setConnectedProvidersForTarget],
  );

  // Load connected providers once per target while the overlay is mounted.
  useEffect(() => {
    if (selectedTarget === "api" && !showProviderStoreTabs) return;
    if (connectedProvidersByTarget[selectedTarget]) return;
    if (loadingTargets.has(selectedTarget)) return;
    void refreshConnectedProviders(selectedTarget);
  }, [
    connectedProvidersByTarget,
    loadingTargets,
    refreshConnectedProviders,
    selectedTarget,
    showProviderStoreTabs,
  ]);

  // When both tabs are available, prefetch the inactive tab so switching tabs
  // can render from overlay-local cache instead of flashing a loading state.
  useEffect(() => {
    if (!showProviderStoreTabs) return;
    for (const target of ["local", "api"] as const) {
      if (target === selectedTarget) continue;
      if (connectedProvidersByTarget[target]) continue;
      if (loadingTargets.has(target)) continue;
      void refreshConnectedProviders(target);
    }
  }, [
    connectedProvidersByTarget,
    loadingTargets,
    refreshConnectedProviders,
    selectedTarget,
    showProviderStoreTabs,
  ]);

  useEffect(() => {
    if (shouldForceLocalProviderTab(hasCloudCredentials, selectedTarget)) {
      setSelectedTarget("local");
      setSelectedIndex(0);
      setSearchQuery("");
      returnToList();
    }
  }, [hasCloudCredentials, selectedTarget, returnToList]);

  useEffect(() => {
    if (selectableProviders.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      return;
    }

    if (selectedIndex >= selectableProviders.length) {
      setSelectedIndex(selectableProviders.length - 1);
    }
  }, [selectedIndex, selectableProviders.length]);

  const switchTarget = useCallback(() => {
    if (!showProviderStoreTabs) return;
    setSelectedTarget((target) => (target === "local" ? "api" : "local"));
    setSelectedIndex(0);
    setSearchQuery("");
    returnToList();
  }, [showProviderStoreTabs, returnToList]);

  const getConnectedProviderRecords = useCallback(
    (provider: ByokProvider): ProviderResponse[] =>
      connectedRecordsForProvider(provider, connectedProviders, selectedTarget),
    [connectedProviders, selectedTarget],
  );

  const getConnectedProviderName = useCallback(
    (provider: ByokProvider): string | undefined => {
      return getConnectedProviderRecords(provider)[0]?.name;
    },
    [getConnectedProviderRecords],
  );

  const loadChatGPTUsageForProvider = useCallback(
    (provider: ByokProvider, forceRefresh = false) => {
      if (!isChatGPTUsageProvider(provider)) return;

      const records = getConnectedProviderRecords(provider);
      for (const record of records) {
        const providerName = record.name;
        setChatGPTUsageByProvider((previous) => ({
          ...previous,
          [providerName]: { status: "loading" },
        }));

        void readChatGPTUsage({
          target: selectedTarget,
          providerName,
          forceRefresh,
        })
          .then((result) => {
            if (!mountedRef.current) return;
            setChatGPTUsageByProvider((previous) => ({
              ...previous,
              [providerName]: result.success
                ? {
                    status: "ready",
                    rows: formatChatGPTUsageQuotaRows(result.usage),
                  }
                : { status: "error", message: result.error.message },
            }));
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            setChatGPTUsageByProvider((previous) => ({
              ...previous,
              [providerName]: {
                status: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to read ChatGPT usage.",
              },
            }));
          });
      }
    },
    [getConnectedProviderRecords, selectedTarget],
  );

  useEffect(() => {
    if (viewState.type !== "options") return;
    loadChatGPTUsageForProvider(viewState.provider);
  }, [loadChatGPTUsageForProvider, viewState]);

  // Get provider ID if connected
  const getProviderId = useCallback(
    (provider: ByokProvider): string | undefined => {
      return getConnectedProviderRecords(provider)[0]?.id;
    },
    [getConnectedProviderRecords],
  );

  // Handle selecting a provider from the list
  const handleSelectProvider = useCallback(
    (provider: ByokProvider) => {
      const providerId = getProviderId(provider);
      const flow = providerSelectionFlow(provider, providerId);

      if (flow === "options") {
        openStep("options", provider);
        setOptionIndex(0);
        return;
      }

      if (flow === "oauth") {
        // OAuth provider - trigger OAuth flow
        if (onStartOAuth) {
          onStartOAuth(provider, selectedTarget);
        }
        return;
      }

      if (flow === "methodSelect") {
        // Provider with multiple auth methods - show method selection
        openStep("methodSelect", provider);
        setMethodIndex(0);
      } else if (flow === "multiInput") {
        // Multi-field provider - show multi-input view
        openStep("multiInput", provider);
        setFieldValues(fieldValuesFromProviderPlaceholders(provider.fields));
        setFocusedFieldIndex(0);
        setValidationState("idle");
        setValidationError(null);
      } else {
        // Single API key input for regular providers
        openStep("input", provider);
        setApiKeyInput("");
        setValidationState("idle");
        setValidationError(null);
      }
    },
    [getProviderId, onStartOAuth, openStep, selectedTarget],
  );

  // Handle selecting an auth method
  const handleSelectAuthMethod = useCallback(
    async (provider: ByokProvider, authMethod: AuthMethod) => {
      // Special handling for profile method - load AWS profiles first
      if (authMethod.id === "profile") {
        setIsLoadingProfiles(true);
        openStep("profileSelect", provider);
        setProfileIndex(0);

        // Load profiles asynchronously
        parseAwsCredentials()
          .then((profiles) => {
            if (mountedRef.current) {
              setAwsProfiles(profiles);
              setIsLoadingProfiles(false);
            }
          })
          .catch((err) => {
            debugLog("provider", "Failed to parse AWS credentials: %O", err);
            if (mountedRef.current) {
              setAwsProfiles([]);
              setIsLoadingProfiles(false);
            }
          });
        return;
      }

      openStep("multiInput", provider, authMethod);
      setFieldValues({});
      setFocusedFieldIndex(0);
      setValidationState("idle");
      setValidationError(null);
    },
    [openStep],
  );

  // Handle selecting an AWS profile - pre-fill IAM fields with credentials
  const handleSelectAwsProfile = useCallback(
    (provider: ByokProvider, profile: AwsProfile) => {
      // Find the IAM auth method to use its fields
      const iamMethod =
        "authMethods" in provider
          ? provider.authMethods?.find((m) => m.id === "iam")
          : undefined;

      if (!iamMethod) return;

      // Pre-fill field values from the profile
      setFieldValues({
        accessKey: profile.accessKeyId || "",
        apiKey: profile.secretAccessKey || "",
        region: profile.region || "",
      });

      openStep("multiInput", provider, iamMethod);
      setFocusedFieldIndex(profile.region ? 0 : 2); // Focus region if not set
      setValidationState("idle");
      setValidationError(null);
    },
    [openStep],
  );

  // Handle API key validation and saving
  const handleValidateAndSave = useCallback(async () => {
    if (viewState.type !== "input") return;

    const { provider } = viewState;
    const apiKey = providerApiKeyFromInput(provider, apiKeyInput);
    if (!apiKey) return;

    // If already validated, save
    if (validationState === "valid") {
      setValidationState("saving");
      try {
        await createOrUpdateProvider(
          provider.providerType,
          provider.providerName,
          apiKey,
          undefined,
          undefined,
          undefined,
          {},
          { target: selectedTarget },
        );
        clearAvailableModelsCache();
        // Refresh connected providers
        const providers = await getConnectedProviders({
          target: selectedTarget,
        });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(selectedTarget, providers);
          returnToList();
          setApiKeyInput("");
          setValidationState("idle");
        }
      } catch (err) {
        if (mountedRef.current) {
          setValidationError(
            err instanceof Error ? err.message : "Failed to save",
          );
          setValidationState("invalid");
        }
      }
      return;
    }

    // Validate the key
    setValidationState("validating");
    setValidationError(null);

    try {
      await checkProviderApiKey(
        provider.providerType,
        apiKey,
        undefined,
        undefined,
        undefined,
        { target: selectedTarget },
      );
      if (mountedRef.current) {
        setValidationState("valid");
      }
    } catch (err) {
      if (mountedRef.current) {
        setValidationState("invalid");
        setValidationError(
          err instanceof Error ? err.message : "Invalid API key",
        );
      }
    }
  }, [
    viewState,
    apiKeyInput,
    validationState,
    selectedTarget,
    setConnectedProvidersForTarget,
    returnToList,
  ]);

  // Handle multi-field validation and saving (for providers like Bedrock)
  const handleMultiFieldValidateAndSave = useCallback(async () => {
    if (viewState.type !== "multiInput") return;

    const { provider, authMethod } = viewState;
    // Get fields from authMethod if present, otherwise from provider
    const fields: ProviderField[] | undefined =
      authMethod?.fields ||
      ("fields" in provider ? (provider.fields as ProviderField[]) : undefined);
    if (!fields) return;

    // Check all required fields are filled
    const allFilled = fields.every(
      (field) => field.required === false || fieldValues[field.key]?.trim(),
    );
    if (!allFilled) return;

    const apiKey =
      fieldValues.apiKey?.trim() || defaultProviderApiKey(provider) || "";
    const accessKey = fieldValues.accessKey?.trim();
    const region = fieldValues.region?.trim();
    const profile = fieldValues.profile?.trim();
    const baseURL = fieldValues.baseUrl?.trim();

    // If already validated, save
    if (validationState === "valid") {
      setValidationState("saving");
      try {
        await createOrUpdateProvider(
          provider.providerType,
          provider.providerName,
          apiKey,
          accessKey,
          region,
          profile,
          baseURL ? { baseURL } : {},
          { target: selectedTarget },
        );
        clearAvailableModelsCache();
        // Refresh connected providers
        const providers = await getConnectedProviders({
          target: selectedTarget,
        });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(selectedTarget, providers);
          returnToList();
          setFieldValues({});
          setValidationState("idle");
        }
      } catch (err) {
        if (mountedRef.current) {
          setValidationError(
            err instanceof Error ? err.message : "Failed to save",
          );
          setValidationState("invalid");
        }
      }
      return;
    }

    // Validate the credentials
    setValidationState("validating");
    setValidationError(null);

    try {
      await checkProviderApiKey(
        provider.providerType,
        apiKey,
        accessKey,
        region,
        profile,
        { target: selectedTarget, connection: baseURL ? { baseURL } : {} },
      );
      if (mountedRef.current) {
        setValidationState("valid");
      }
    } catch (err) {
      if (mountedRef.current) {
        setValidationState("invalid");
        setValidationError(
          err instanceof Error ? err.message : "Invalid credentials",
        );
      }
    }
  }, [
    viewState,
    fieldValues,
    validationState,
    selectedTarget,
    setConnectedProvidersForTarget,
    returnToList,
  ]);

  // Handle disconnect
  const handleDisconnect = useCallback(
    async (providerName?: string) => {
      if (viewState.type !== "options") return;

      const { provider } = viewState;
      try {
        await removeProviderByName(
          providerName ??
            getConnectedProviderName(provider) ??
            provider.providerName,
          {
            target: selectedTarget,
          },
        );
        clearAvailableModelsCache();
        // Refresh connected providers
        const providers = await getConnectedProviders({
          target: selectedTarget,
        });
        if (mountedRef.current) {
          setConnectedProvidersForTarget(selectedTarget, providers);
          returnToList();
        }
      } catch {
        // Silently fail, stay on options view
      }
    },
    [
      viewState,
      selectedTarget,
      getConnectedProviderName,
      setConnectedProvidersForTarget,
      returnToList,
    ],
  );

  const startNamedOAuthConnect = useCallback(() => {
    if (viewState.type !== "oauthNameInput") return;

    let providerName: string;
    try {
      providerName = normalizeChatGPTOAuthProviderName(providerNameInput);
    } catch (error) {
      setProviderNameError(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    if (connectedProviders.has(providerName)) {
      setProviderNameError(`Provider '${providerName}' already exists.`);
      return;
    }

    if (!onStartOAuth) {
      setProviderNameError("OAuth connection is unavailable.");
      return;
    }

    setProviderNameError(null);
    onStartOAuth(viewState.provider, selectedTarget, providerName);
  }, [
    viewState,
    providerNameInput,
    connectedProviders,
    onStartOAuth,
    selectedTarget,
  ]);

  // The keys, as data. Every step's list is declared at once and gated by
  // `navigationEnabled`, so a table that does not apply to the step on screen
  // declines instead of eating the key. None of them declares a cancel of its
  // own: Escape and Ctrl+C are the wizard's, and a list that claimed Escape
  // would take it away from every other step — which is also why the filter's
  // Escape (clear it first, or decline) sits at the head of the table rather
  // than being folded into the provider list's own row handling.
  const authMethods =
    viewState.type === "methodSelect"
      ? viewState.provider.authMethods
      : undefined;
  const manageActions =
    viewState.type === "options"
      ? providerManageActions(
          viewState.provider,
          selectedTarget,
          getConnectedProviderRecords(viewState.provider),
        )
      : [];
  const multiFields: ProviderField[] =
    viewState.type === "multiInput"
      ? (viewState.authMethod?.fields ??
        ("fields" in viewState.provider
          ? (viewState.provider.fields as ProviderField[])
          : undefined) ??
        [])
      : [];
  const onList = viewState.type === "list" && !isLoading;

  useKeyBindings("provider-selector", [
    {
      scope: "overlay",
      bindings: wizardBindings({
        canGoBack,
        onBack: leaveStep,
        onCancel,
        extra: [
          {
            id: "connect.clear-filter",
            chords: [{ key: "escape" }],
            run: () => {
              if (!onList || !searchQuery) return "declined";
              setSearchQuery("");
              setSelectedIndex(0);
              return "consumed";
            },
          },
          {
            id: "connect.switch-target",
            chords: [
              { key: "tab" },
              { key: "leftArrow" },
              { key: "rightArrow" },
            ],
            run: () => {
              if (!onList || !showProviderStoreTabs) return "declined";
              switchTarget();
              return "consumed";
            },
          },
          ...listBindings({
            count: selectableProviders.length,
            cursor: selectedIndex,
            onMoveCursor: setSelectedIndex,
            onConfirm: () => {
              const provider = selectableProviders[selectedIndex];
              if (provider) handleSelectProvider(provider);
            },
            onCancel: undefined,
            navigationEnabled: onList,
            // The filter is a live editor beside this list, so `j`/`k` are its
            // letters — the same call `/resume` makes — and Home/End are its
            // caret's. That one cannot be left to registration order: the filter
            // remounts every time the overlay walks into a provider's step and
            // back, and a remount registers behind this table.
            vimKeys: false,
            edgeKeys: false,
          }),
          ...listBindings({
            count: authMethods?.length ?? 0,
            cursor: methodIndex,
            onMoveCursor: setMethodIndex,
            onConfirm: () => {
              const method = authMethods?.[methodIndex];
              if (method && viewState.type === "methodSelect") {
                void handleSelectAuthMethod(viewState.provider, method);
              }
            },
            onCancel: undefined,
            navigationEnabled: viewState.type === "methodSelect",
          }),
          ...listBindings({
            count: awsProfiles.length,
            cursor: profileIndex,
            onMoveCursor: setProfileIndex,
            onConfirm: () => {
              const profile = awsProfiles[profileIndex];
              if (profile && viewState.type === "profileSelect") {
                handleSelectAwsProfile(viewState.provider, profile);
              }
            },
            onCancel: undefined,
            navigationEnabled:
              viewState.type === "profileSelect" && !isLoadingProfiles,
          }),
          ...listBindings({
            count: manageActions.length,
            cursor: optionIndex,
            onMoveCursor: setOptionIndex,
            onConfirm: () => {
              if (viewState.type !== "options") return;
              const action = manageActions[optionIndex];
              if (action?.type === "disconnect") {
                void handleDisconnect(action.name);
                return;
              }
              if (action?.type === "connect-another") {
                setProviderNameInput(
                  nextProviderConnectionName(
                    viewState.provider,
                    getConnectedProviderRecords(viewState.provider),
                  ),
                );
                setProviderNameError(null);
                openStep("oauthNameInput", viewState.provider);
                return;
              }
              if (action?.type === "reconnect") {
                onStartOAuth?.(viewState.provider, selectedTarget);
                return;
              }
              if (action?.type === "refresh-usage") {
                loadChatGPTUsageForProvider(viewState.provider, true);
                return;
              }
              // The row that manages nothing is how this list is left.
              returnToList();
            },
            onCancel: undefined,
            navigationEnabled: viewState.type === "options",
          }),
          {
            id: "connect.next-field",
            chords: [{ key: "tab" }, { key: "downArrow" }],
            run: () => {
              if (viewState.type !== "multiInput") return "declined";
              setFocusedFieldIndex((prev) =>
                Math.min(multiFields.length - 1, prev + 1),
              );
              return "consumed";
            },
          },
          {
            id: "connect.previous-field",
            chords: [{ key: "tab", shift: true }, { key: "upArrow" }],
            run: () => {
              if (viewState.type !== "multiInput") return "declined";
              setFocusedFieldIndex((prev) => Math.max(0, prev - 1));
              return "consumed";
            },
          },
        ],
      }),
    },
  ]);

  // Render list view
  const renderListView = () => (
    <>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Connect your LLM API keys
        </Text>
        <Text dimColor>Change models with /model after connecting</Text>
        {showProviderStoreTabs && (
          <Box marginTop={1} flexDirection="row">
            {connectProviderTabOrder(defaultProviderStorageTarget()).map(
              (target) => (
                <Box key={target} flexDirection="row">
                  <Text>{"  "}</Text>
                  <Text
                    bold={selectedTarget === target}
                    color={
                      selectedTarget === target
                        ? colors.selector.title
                        : colors.command.running
                    }
                  >
                    {formatConnectProviderTab(target, selectedTarget)}
                  </Text>
                </Box>
              ),
            )}
          </Box>
        )}
        {!showProviderStoreTabs && <Box height={1} />}
        <OverlayTextField
          marker={<Text dimColor>{"  Filter: "}</Text>}
          value={searchQuery}
          onChange={(next) => {
            setSearchQuery(next);
            setSelectedIndex(0);
          }}
          placeholder="(type to filter)"
          focus={onList}
        />
      </Box>

      {isLoading ? (
        <Box>
          <Text dimColor>{"  "}Loading providers...</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {selectableProviders.length === 0 && searchQuery ? (
            <Text dimColor>{"  "}No providers match your filter.</Text>
          ) : null}
          <OverlayListView
            items={providerItems}
            cursor={selectedIndex}
            rows={VISIBLE_PROVIDERS}
            anchor="edge"
            indicators={false}
            renderRow={(_item, index, isSelected) => {
              const provider = selectableProviders[index];
              if (!provider) return null;
              const connectedRecords = getConnectedProviderRecords(provider);
              const connected = connectedRecords.length > 0;

              return (
                <Box flexDirection="row">
                  <Text
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {isSelected ? "> " : "  "}
                  </Text>
                  <Text color={connected ? "green" : undefined}>
                    [{connected ? "✓" : " "}]
                  </Text>
                  <Text> </Text>
                  <Text
                    bold={isSelected}
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {provider.displayName}
                  </Text>
                  <Text dimColor>
                    {" · "}
                    {connected ? (
                      <Text color="green">
                        {connectedProviderSummary(provider, connectedRecords)}
                      </Text>
                    ) : (
                      provider.description
                    )}
                  </Text>
                </Box>
              );
            }}
          />
          {providerWindow.below > 0 ? (
            <Text dimColor>
              {"  "}↓ {providerWindow.below} more below
            </Text>
          ) : selectableProviders.length > VISIBLE_PROVIDERS ? (
            <Text> </Text>
          ) : null}
        </Box>
      )}

      {!isLoading && (
        <Box marginTop={1}>
          <Text dimColor>
            {searchQuery
              ? showProviderStoreTabs
                ? "  Enter select · ↑↓ navigate · Backspace edit filter · Tab/←→ switch tab · Esc clear"
                : "  Enter select · ↑↓ navigate · Backspace edit filter · Esc clear"
              : showProviderStoreTabs
                ? "  Enter select · ↑↓ navigate · type filter · Tab/←→ switch tab · Esc cancel"
                : "  Enter select · ↑↓ navigate · type filter · Esc cancel"}
          </Text>
        </Box>
      )}
    </>
  );

  // Render input view
  const renderInputView = () => {
    if (viewState.type !== "input") return null;
    const { provider } = viewState;
    const hasDefaultApiKey = defaultProviderApiKey(provider) !== undefined;
    const hasTypedApiKey = Boolean(apiKeyInput.trim());

    const statusText =
      validationState === "validating"
        ? " (validating...)"
        : validationState === "saving"
          ? " (saving & syncing models...)"
          : validationState === "valid"
            ? " (key validated!)"
            : validationState === "invalid"
              ? ` (invalid key${validationError ? `: ${validationError}` : ""})`
              : "";

    const statusColor =
      validationState === "valid"
        ? "green"
        : validationState === "invalid"
          ? "red"
          : undefined;

    const footerText =
      validationState === "saving"
        ? "Saving provider..."
        : validationState === "valid"
          ? "Enter to save · Esc cancel"
          : "Enter to validate · Esc cancel";

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {"  "}
            {hasDefaultApiKey
              ? `Connect ${provider.displayName} (API key optional):`
              : `Connect your ${provider.displayName} key:`}
          </Text>
        </Box>

        <OverlayTextField
          markerColor={colors.selector.itemHighlighted}
          // The key is a secret, so the editor paints it over rather than
          // showing it: a single repeated character, where the hand-rolled row
          // showed the first four characters of a long key and nothing else of
          // it. The draft the overlay holds is still the real key.
          mask="*"
          value={apiKeyInput}
          onChange={(next) => {
            setApiKeyInput(next);
            // Reset validation if key changed
            if (validationState !== "idle") {
              setValidationState("idle");
              setValidationError(null);
            }
          }}
          onSubmit={handleValidateAndSave}
          placeholder={
            hasDefaultApiKey ? "(press Enter for default key)" : "(enter key)"
          }
          trailing={
            <Text
              color={statusColor}
              dimColor={
                validationState === "validating" || validationState === "saving"
              }
            >
              {statusText}
            </Text>
          }
        />

        <Box marginTop={1}>
          <Text dimColor>
            {"  "}
            {hasDefaultApiKey && !hasTypedApiKey && validationState === "idle"
              ? "Enter to validate with default key · Esc cancel"
              : footerText}
          </Text>
        </Box>
      </>
    );
  };

  // Render method select view (for providers with multiple auth options)
  const renderMethodSelectView = () => {
    if (viewState.type !== "methodSelect") return null;
    if (
      !("authMethods" in viewState.provider) ||
      !viewState.provider.authMethods
    )
      return null;

    const { provider } = viewState;
    const authMethods = viewState.provider.authMethods;

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {provider.displayName}
          </Text>
          <Text dimColor>Select authentication method</Text>
        </Box>

        <Box flexDirection="column">
          {authMethods.map((method, index) => {
            const isSelected = index === methodIndex;
            return (
              <Box key={method.id} flexDirection="row">
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "> " : "  "}
                </Text>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {method.label}
                </Text>
                <Text dimColor> · {method.description}</Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc back</Text>
        </Box>
      </>
    );
  };

  // Render AWS profile select view
  const renderProfileSelectView = () => {
    if (viewState.type !== "profileSelect") return null;

    const { provider } = viewState;

    if (isLoadingProfiles) {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {provider.displayName}
          </Text>
          <Text dimColor>Loading AWS profiles...</Text>
        </Box>
      );
    }

    if (awsProfiles.length === 0) {
      return (
        <>
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={colors.selector.title}>
              Connect {provider.displayName}
            </Text>
            <Text color="yellow">No AWS profiles found</Text>
            <Text dimColor>
              Check that ~/.aws/credentials exists and contains valid profiles.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{"  "}Esc back</Text>
          </Box>
        </>
      );
    }

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {provider.displayName}
          </Text>
          <Text dimColor>Select AWS profile from ~/.aws/credentials</Text>
        </Box>

        <Box flexDirection="column">
          {awsProfiles.map((profile, index) => {
            const isSelected = index === profileIndex;
            const hasCredentials =
              profile.accessKeyId && profile.secretAccessKey;
            return (
              <Box key={profile.name} flexDirection="row">
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "> " : "  "}
                </Text>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {profile.name}
                </Text>
                <Text dimColor>
                  {" · "}
                  {hasCredentials ? (
                    <>
                      {profile.accessKeyId?.slice(0, 8)}...
                      {profile.region && ` · ${profile.region}`}
                    </>
                  ) : (
                    <Text color="yellow">missing credentials</Text>
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter select · ↑↓ navigate · Esc back</Text>
        </Box>
      </>
    );
  };

  // Render multi-input view (for providers like Bedrock)
  const renderMultiInputView = () => {
    if (viewState.type !== "multiInput") return null;

    const { provider, authMethod } = viewState;
    // Get fields from authMethod if present, otherwise from provider
    const fields: ProviderField[] | undefined =
      authMethod?.fields ||
      ("fields" in provider ? (provider.fields as ProviderField[]) : undefined);
    if (!fields) return null;

    // Check if all required fields are filled
    const allFilled = fields.every(
      (field: ProviderField) =>
        field.required === false || fieldValues[field.key]?.trim(),
    );

    const statusText =
      validationState === "validating"
        ? " (validating...)"
        : validationState === "saving"
          ? " (saving & syncing models...)"
          : validationState === "valid"
            ? " (credentials validated!)"
            : validationState === "invalid"
              ? ` (invalid${validationError ? `: ${validationError}` : ""})`
              : "";

    const statusColor =
      validationState === "valid"
        ? "green"
        : validationState === "invalid"
          ? "red"
          : undefined;

    const hasAuthMethods = "authMethods" in provider && provider.authMethods;
    const escText = hasAuthMethods ? "Esc back" : "Esc cancel";
    const footerText =
      validationState === "saving"
        ? "Saving provider..."
        : validationState === "valid"
          ? `Enter to save · ${escText}`
          : allFilled
            ? `Enter to validate · Tab/↑↓ navigate · ${escText}`
            : `Tab/↑↓ navigate · ${escText}`;

    // Build title - include auth method name if present
    const title = authMethod
      ? `${provider.displayName} · ${authMethod.label}`
      : provider.displayName;

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect {title}
          </Text>
        </Box>

        <Box flexDirection="column">
          {fields.map((field: ProviderField, index: number) => {
            const isFocused = index === focusedFieldIndex;
            const value = fieldValues[field.key] || "";

            return (
              <OverlayTextField
                key={field.key}
                value={value}
                onChange={(next) => {
                  setFieldValues((prev) => ({
                    ...prev,
                    [field.key]: next,
                  }));
                  // Reset validation if value changed
                  if (validationState !== "idle") {
                    setValidationState("idle");
                    setValidationError(null);
                  }
                }}
                onSubmit={handleMultiFieldValidateAndSave}
                // Every field is an editor; only the row the cursor is on takes
                // keys, so Tab/↑↓ can walk the form across the ones it is not on.
                focus={isFocused}
                mask={field.secret ? "*" : undefined}
                // The hint is the row's own wording, parentheses and all, and
                // only the focused row shows it — which is what this view did
                // before the field was an editor.
                placeholder={
                  isFocused
                    ? `(${field.placeholder || "enter value"})`
                    : undefined
                }
                marker={
                  <>
                    <Text
                      color={
                        isFocused ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {isFocused ? "> " : "  "}
                    </Text>
                    <Text dimColor={!isFocused} bold={isFocused}>
                      {field.label}
                      {field.required === false ? " (optional)" : ""}:
                    </Text>
                    <Text> </Text>
                  </>
                }
              />
            );
          })}
        </Box>

        {(validationState !== "idle" || validationError) && (
          <Box marginTop={1}>
            <Text
              color={statusColor}
              dimColor={
                validationState === "validating" || validationState === "saving"
              }
            >
              {"  "}
              {statusText}
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>
            {"  "}
            {footerText}
          </Text>
        </Box>
      </>
    );
  };

  // Render options view (for connected providers)
  const renderOptionsView = () => {
    if (viewState.type !== "options") return null;
    const { provider } = viewState;
    const connectedRecords = getConnectedProviderRecords(provider);
    const options = providerManageActions(
      provider,
      selectedTarget,
      connectedRecords,
    ).map((action) => providerManageActionLabel(action, provider));

    return (
      <ProviderOptionsView
        provider={provider}
        options={options}
        connectedRecords={connectedRecords}
        showUsage={isChatGPTUsageProvider(provider)}
        usageByProvider={chatGPTUsageByProvider}
        optionIndex={optionIndex}
      />
    );
  };

  const renderOAuthNameInputView = () => {
    if (viewState.type !== "oauthNameInput") return null;
    const { provider } = viewState;

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Connect another {provider.displayName}
          </Text>
          <Box height={1} />
          <OverlayTextField
            marker={<Text>{"  "}Provider name: </Text>}
            value={providerNameInput}
            onChange={(next) => {
              setProviderNameInput(next);
              setProviderNameError(null);
            }}
            onSubmit={startNamedOAuthConnect}
          />
          {providerNameError ? (
            <Box marginTop={1}>
              <Text color="red">
                {"  "}
                {providerNameError}
              </Text>
            </Box>
          ) : null}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>{"  "}Enter connect · Backspace edit · Esc back</Text>
        </Box>
      </>
    );
  };

  return (
    <OverlayFrame command="/connect">
      {viewState.type === "list" && renderListView()}
      {viewState.type === "input" && renderInputView()}
      {viewState.type === "methodSelect" && renderMethodSelectView()}
      {viewState.type === "profileSelect" && renderProfileSelectView()}
      {viewState.type === "multiInput" && renderMultiInputView()}
      {viewState.type === "options" && renderOptionsView()}
      {viewState.type === "oauthNameInput" && renderOAuthNameInputView()}
    </OverlayFrame>
  );
}
