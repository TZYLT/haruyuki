import { Box } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
  getCachedModelHandles,
  getCachedModelProviderTypes,
  getCachedOpenAICompatibleProxyHandles,
} from "@/agent/available-models";
import {
  CHATGPT_FAST_SERVICE_TIER,
  getChatGptFastRegistryHandleForModelHandle,
  models,
  normalizeModelHandleForRegistry,
} from "@/agent/model";
import { refreshModelCatalog } from "@/agent/remote-model-catalog";
import {
  getPiProviderRegistryRevision,
  subscribePiProviderRegistry,
} from "@/backend/dev/pi-provider-mod-registry";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import {
  buildByokProviderAliases,
  buildOpenAICompatibleProxyProviderNames,
  isByokHandleForSelector,
  listProviders,
} from "@/providers/byok-providers";
import { settingsManager } from "@/settings-manager";
import { colors } from "./colors";
import {
  baseHandleForByokAlias,
  filterModelsByAvailabilityForSelector,
  includeUnknownBackendHandleInRecommended,
  labelForBackendModel,
  type ModelSelectorSelection,
  registryHandleForBackendModel,
  registryHandleForByokAlias,
  toByokSelectorModel,
  toSelectorModelForHandle,
  type UiModel,
  withProviderMetadataForSelector,
} from "./model-selector-helpers";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

const VISIBLE_ITEMS = 8;

type ModelCategory =
  | "recents"
  | "supported"
  | "byok"
  | "byok-all"
  | "all"
  | "server-recommended"
  | "server-all";

// Re-export for consumers that import from ModelSelector
export { buildByokProviderAliases, isByokHandleForSelector };
export type {
  ModelSelectorSelection,
  UiModel,
} from "./model-selector-helpers";
export {
  filterModelsByAvailabilityForSelector,
  includeUnknownBackendHandleInRecommended,
  labelForBackendModel,
  labelForChatGPTByokAlias,
  registryHandleForBackendModel,
  registryHandleForByokAlias,
  toByokSelectorModel,
  toSelectorModelForHandle,
  withProviderMetadataForSelector,
} from "./model-selector-helpers";

export function usesBackendModelCatalog(
  isSelfHosted?: boolean,
  localModelCatalog?: boolean,
): boolean {
  return Boolean(isSelfHosted || localModelCatalog);
}

export function getEmptyStateActionDescriptors(): Array<{
  id: "connect";
  label: string;
  description: string;
}> {
  return [
    {
      id: "connect",
      label: "/connect",
      description: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
    },
  ];
}

// Get tab order for model categories.
// For self-hosted servers, only show server-specific tabs.
// For Letta-hosted, keep ordering consistent across billing tiers.
// "recents" is prepended when the user has >= 2 recently used models.
export function getModelCategories(
  _billingTier?: string,
  isSelfHosted?: boolean,
  localModelCatalog?: boolean,
  recentModelCount?: number,
): ModelCategory[] {
  const showRecents =
    (recentModelCount ?? settingsManager.getRecentModels().length) >= 2;
  if (usesBackendModelCatalog(isSelfHosted, localModelCatalog)) {
    const base: ModelCategory[] = ["server-recommended", "server-all"];
    if (showRecents) {
      return ["recents", ...base];
    }
    return base;
  }
  const base: ModelCategory[] = ["supported", "all", "byok", "byok-all"];
  if (showRecents) {
    return ["recents", ...base];
  }
  return base;
}

interface ModelSelectorProps {
  currentModelId?: string;
  /** The current model's handle (e.g., "anthropic/claude-sonnet-4.6") for accurate current model highlighting */
  currentModelHandle?: string | null;
  currentModelServiceTier?: string | null;
  onSelect: (selection: ModelSelectorSelection) => void;
  onOpenConnect?: () => void;
  onCancel: () => void;
  /** Filter models to only show those matching this provider prefix (e.g., "chatgpt-plus-pro") */
  filterProvider?: string;
  /** Force refresh the models list on mount */
  forceRefresh?: boolean;
  /** User's billing tier (kept for compatibility and future gating logic) */
  billingTier?: string;
  /** Whether connected to a self-hosted server instead of Letta Cloud */
  isSelfHosted?: boolean;
  /** Whether the active backend provides a local-only model catalog */
  localModelCatalog?: boolean;
}

export function ModelSelector({
  currentModelId,
  currentModelHandle,
  currentModelServiceTier,
  onSelect,
  onOpenConnect,
  onCancel,
  filterProvider,
  forceRefresh: forceRefreshOnMount,
  billingTier,
  isSelfHosted,
  localModelCatalog,
}: ModelSelectorProps) {
  const typedModels = models as UiModel[];

  // For self-hosted and local backends, only show the active backend's model catalog.
  const modelCategories = useMemo(
    () => getModelCategories(billingTier, isSelfHosted, localModelCatalog),
    [billingTier, isSelfHosted, localModelCatalog],
  );
  const backendModelCatalog = usesBackendModelCatalog(
    isSelfHosted,
    localModelCatalog,
  );
  const isFreeTier = billingTier === "free";
  const defaultCategory = modelCategories[0] ?? "supported";

  const [category, setCategory] = useState<ModelCategory>(defaultCategory);
  const cachedHandlesAtMount = useMemo(() => getCachedModelHandles(), []);

  // The toolkit owns the cursor. The key table is an argument to the controller
  // that hands it the cursor, so the table reaches it through this ref -- the
  // same latest-value pattern `useKeyBindings` uses, and what keeps the bindings
  // reading the render that is on screen.
  const resetCursorRef = useRef<(index: number) => void>(() => {});

  // undefined: not loaded yet (show spinner)
  // Set<string>: loaded and filtered
  // null: error fallback (show all models + warning)
  const [availableHandles, setAvailableHandles] = useState<
    Set<string> | null | undefined
  >(cachedHandlesAtMount ?? undefined);
  const [allApiHandles, setAllApiHandles] = useState<string[]>(
    cachedHandlesAtMount ? Array.from(cachedHandlesAtMount) : [],
  );
  const [providerTypesByHandle, setProviderTypesByHandle] = useState<
    Map<string, string>
  >(() => getCachedModelProviderTypes() ?? new Map());
  const [isLoading, setIsLoading] = useState(cachedHandlesAtMount === null);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(cachedHandlesAtMount !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [byokProviderAliases, setByokProviderAliases] = useState<
    Record<string, string>
  >(() => buildByokProviderAliases([]));
  const [openAICompatibleProxyHandles, setOpenAICompatibleProxyHandles] =
    useState<Set<string>>(
      () => getCachedOpenAICompatibleProxyHandles() ?? new Set(),
    );
  const [openAICompatibleProxyProviders, setOpenAICompatibleProxyProviders] =
    useState<Set<string>>(new Set());
  const providerRegistryRevision = useSyncExternalStore(
    subscribePiProviderRegistry,
    getPiProviderRegistryRevision,
    getPiProviderRegistryRevision,
  );
  const previousProviderRegistryRevision = useRef(providerRegistryRevision);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch available models from the API (with caching + inflight dedupe)
  const loadModels = useRef(async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        clearAvailableModelsCache();
        if (mountedRef.current) {
          setRefreshing(true);
          setError(null);
        }
      }

      const cacheInfoBefore = getAvailableModelsCacheInfo();
      // Refresh the curated catalog alongside availability so the preset
      // list reflects cloud-canon data before this component re-renders
      // (best-effort: on failure `models` keeps its current contents).
      const [result] = await Promise.all([
        getAvailableModelHandles({ forceRefresh }),
        refreshModelCatalog(forceRefresh ? { force: true } : undefined).catch(
          () => false,
        ),
      ]);

      if (!mountedRef.current) return;

      setAvailableHandles(result.handles);
      setAllApiHandles(Array.from(result.handles));
      setProviderTypesByHandle(new Map(result.providerTypes));
      setOpenAICompatibleProxyHandles(
        new Set(result.openAICompatibleProxyHandles),
      );
      setIsCached(!forceRefresh && cacheInfoBefore.isFresh);
      setIsLoading(false);
      setRefreshing(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load models");
      setIsLoading(false);
      setRefreshing(false);
      // Fallback: show all models if API fails
      setAvailableHandles(null);
      setAllApiHandles([]);
      setProviderTypesByHandle(new Map());
      setOpenAICompatibleProxyHandles(new Set());
    }
  });

  useEffect(() => {
    if (previousProviderRegistryRevision.current !== providerRegistryRevision) {
      previousProviderRegistryRevision.current = providerRegistryRevision;
      clearAvailableModelsCache();
    }
    loadModels.current(forceRefreshOnMount ?? false);
  }, [forceRefreshOnMount, providerRegistryRevision]);

  useEffect(() => {
    if (localModelCatalog) {
      setByokProviderAliases(buildByokProviderAliases([]));
      setOpenAICompatibleProxyProviders(new Set());
      return;
    }
    (async () => {
      try {
        const providers = await listProviders();
        if (!mountedRef.current) return;
        setByokProviderAliases(buildByokProviderAliases(providers));
        setOpenAICompatibleProxyProviders(
          buildOpenAICompatibleProxyProviderNames(providers),
        );
      } catch {
        if (!mountedRef.current) return;
        setByokProviderAliases(buildByokProviderAliases([]));
        setOpenAICompatibleProxyProviders(new Set());
      }
    })();
  }, [localModelCatalog]);

  const pickPreferredStaticModel = useCallback(
    (handle: string, contextWindow?: number): UiModel | undefined => {
      const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;
      const staticCandidates = typedModels.filter(
        (m) =>
          m.handle === registryHandle &&
          (contextWindow === undefined ||
            (m.updateArgs?.context_window as number | undefined) ===
              contextWindow),
      );
      return (
        staticCandidates.find((m) => m.isDefault) ??
        staticCandidates.find((m) => m.isFeatured) ??
        staticCandidates.find(
          (m) =>
            (m.updateArgs as { reasoning_effort?: unknown } | undefined)
              ?.reasoning_effort === "medium",
        ) ??
        staticCandidates.find(
          (m) =>
            (m.updateArgs as { reasoning_effort?: unknown } | undefined)
              ?.reasoning_effort === "high",
        ) ??
        staticCandidates[0]
      );
    },
    [typedModels],
  );

  const serviceTierForModel = useCallback((model: UiModel): string | null => {
    const value = model.updateArgs?.service_tier;
    return value === CHATGPT_FAST_SERVICE_TIER
      ? CHATGPT_FAST_SERVICE_TIER
      : null;
  }, []);

  const withActualHandle = useCallback(
    (
      model: UiModel,
      handle: string,
      registryHandle?: string,
      updateArgs?: Record<string, unknown>,
    ): UiModel => ({
      ...model,
      id:
        updateArgs?.service_tier === CHATGPT_FAST_SERVICE_TIER
          ? `${handle}::service_tier=${CHATGPT_FAST_SERVICE_TIER}`
          : handle,
      handle,
      registryHandle: registryHandle ?? model.registryHandle ?? model.handle,
      updateArgs: updateArgs ?? model.updateArgs,
    }),
    [],
  );

  const withProviderTypeMetadata = useCallback(
    (
      handle: string,
      updateArgs: Record<string, unknown> | undefined,
    ): Record<string, unknown> | undefined => {
      const providerType = providerTypesByHandle.get(handle);
      const providerName = handle.split("/")[0];
      return withProviderMetadataForSelector(
        updateArgs,
        providerType,
        isByokHandleForSelector(handle, byokProviderAliases),
        openAICompatibleProxyHandles.has(handle) ||
          (providerName !== undefined &&
            openAICompatibleProxyProviders.has(providerName)),
      );
    },
    [
      byokProviderAliases,
      openAICompatibleProxyHandles,
      openAICompatibleProxyProviders,
      providerTypesByHandle,
    ],
  );

  const modelsForBackendHandle = useCallback(
    (handle: string, includeUnknown: boolean): UiModel[] => {
      const providerType = providerTypesByHandle.get(handle);
      const registryHandle = registryHandleForBackendModel(
        handle,
        providerType,
      );
      const baseStaticModel = pickPreferredStaticModel(registryHandle);
      const fastRegistryHandle =
        getChatGptFastRegistryHandleForModelHandle(handle);

      const baseUpdateArgs = {
        ...((baseStaticModel?.updateArgs as
          | Record<string, unknown>
          | undefined) ?? {}),
        ...(fastRegistryHandle ? { service_tier: null } : {}),
      };
      const baseUpdateArgsWithProviderType = withProviderTypeMetadata(
        handle,
        Object.keys(baseUpdateArgs).length > 0 ? baseUpdateArgs : undefined,
      );
      const fallbackModel = includeUnknown
        ? toSelectorModelForHandle(handle)
        : null;
      const baseModel = baseStaticModel
        ? withActualHandle(
            {
              ...baseStaticModel,
              label: labelForBackendModel(baseStaticModel.label, providerType),
            },
            handle,
            registryHandle,
            baseUpdateArgsWithProviderType,
          )
        : fallbackModel
          ? {
              ...fallbackModel,
              updateArgs: withProviderTypeMetadata(
                handle,
                fallbackModel.updateArgs,
              ),
            }
          : null;

      const result = baseModel ? [baseModel] : [];

      if (fastRegistryHandle) {
        const fastStaticModel = pickPreferredStaticModel(fastRegistryHandle);
        if (fastStaticModel) {
          result.push(
            withActualHandle(fastStaticModel, handle, fastRegistryHandle, {
              ...((fastStaticModel.updateArgs as
                | Record<string, unknown>
                | undefined) ?? {}),
              service_tier: CHATGPT_FAST_SERVICE_TIER,
              ...withProviderTypeMetadata(handle, undefined),
            }),
          );
        }
      }

      return result;
    },
    [
      pickPreferredStaticModel,
      providerTypesByHandle,
      withActualHandle,
      withProviderTypeMetadata,
    ],
  );

  // Supported models: runtime catalog entries that are available
  // Featured models first, then non-featured, preserving catalog order within each group
  // If filterProvider is set, only show models from that provider
  const supportedModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    let available = filterModelsByAvailabilityForSelector(
      typedModels,
      availableHandles,
      allApiHandles,
    );
    // Apply provider filter if specified
    if (filterProvider) {
      available = available.filter((m) =>
        m.handle.startsWith(`${filterProvider}/`),
      );
    }
    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      available = available.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }

    // Deduplicate by handle+context_window: keep one representative entry per unique combo.
    // Models with multiple reasoning tiers (e.g., gpt-5.5 none/low/med/high/max)
    // share the same handle — the ModelReasoningSelector handles tier selection after pick.
    // Models with different context_window (e.g., 200k vs 1M) show separately.
    const seen = new Set<string>();
    const deduped: UiModel[] = [];
    for (const m of available) {
      const contextWindow = m.updateArgs?.context_window as number | undefined;
      const key = `${m.handle}:${contextWindow ?? 0}:${serviceTierForModel(m) ?? "default"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(pickPreferredStaticModel(m.handle, contextWindow) ?? m);
    }

    const featured = deduped.filter((m) => m.isFeatured);
    const nonFeatured = deduped.filter((m) => !m.isFeatured);
    return [...featured, ...nonFeatured];
  }, [
    typedModels,
    availableHandles,
    allApiHandles,
    filterProvider,
    searchQuery,
    pickPreferredStaticModel,
    serviceTierForModel,
  ]);

  // BYOK models: models from ChatGPT OAuth, standard lc-* providers, or any connected custom BYOK provider
  const isByokHandle = useCallback(
    (handle: string) => isByokHandleForSelector(handle, byokProviderAliases),
    [byokProviderAliases],
  );

  // Letta API (all): preserve backend metadata when aliases are not yet classified as BYOK.
  const allLettaModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    const modelsForHandles = allApiHandles
      .filter((handle) => !isByokHandle(handle))
      .map((handle) => {
        const staticModel = pickPreferredStaticModel(handle);
        return {
          ...(staticModel ?? { label: handle, description: "" }),
          id: handle,
          handle,
          updateArgs: withProviderTypeMetadata(
            handle,
            staticModel?.updateArgs as Record<string, unknown> | undefined,
          ),
        } satisfies UiModel;
      });

    if (!searchQuery) {
      return modelsForHandles;
    }

    const query = searchQuery.toLowerCase();
    return modelsForHandles.filter(
      (model) =>
        model.label.toLowerCase().includes(query) ||
        model.description.toLowerCase().includes(query) ||
        model.handle.toLowerCase().includes(query),
    );
  }, [
    availableHandles,
    allApiHandles,
    isByokHandle,
    pickPreferredStaticModel,
    searchQuery,
    withProviderTypeMetadata,
  ]);

  // Convert a BYOK handle to its base provider handle for catalog lookup
  // e.g., "lc-anthropic/claude-3-5-haiku" -> "anthropic/claude-3-5-haiku"
  // e.g., "lc-gemini/gemini-2.0-flash" -> "google_ai/gemini-2.0-flash"
  const toBaseHandle = useCallback(
    (handle: string): string =>
      baseHandleForByokAlias(handle, byokProviderAliases),
    [byokProviderAliases],
  );

  // BYOK (recommended): BYOK API handles with matching runtime catalog entries
  const byokModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    // Get all BYOK handles from API
    const byokHandles = allApiHandles.filter(isByokHandle);

    // Find matching catalog entries (using aliases for lc-* providers)
    const matched: UiModel[] = [];
    for (const handle of byokHandles) {
      const baseHandle = toBaseHandle(handle);
      const staticModel = pickPreferredStaticModel(baseHandle);
      if (staticModel) {
        // Use catalog metadata but keep the BYOK handle as the ID
        matched.push(
          toByokSelectorModel(
            staticModel,
            handle,
            byokProviderAliases,
            withProviderTypeMetadata(
              handle,
              staticModel.updateArgs as Record<string, unknown> | undefined,
            ),
          ),
        );
      }
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return matched.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }

    return matched;
  }, [
    availableHandles,
    allApiHandles,
    byokProviderAliases,
    pickPreferredStaticModel,
    searchQuery,
    isByokHandle,
    toBaseHandle,
    withProviderTypeMetadata,
  ]);

  // BYOK (all): all BYOK handles from API (including recommended ones)
  const byokAllModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    const byokHandles = allApiHandles.filter(isByokHandle);

    // Apply search filter
    let filtered = byokHandles;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = byokHandles.filter((handle) =>
        handle.toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [availableHandles, allApiHandles, searchQuery, isByokHandle]);

  // Server-recommended models: runtime catalog entries available on the server.
  // Discoverable local endpoint providers (Ollama, LM Studio, llama.cpp) may
  // not have preset entries, so include their live-discovered
  // handles here instead of hiding them until the user switches to "All".
  const serverRecommendedModels = useMemo(() => {
    if (!backendModelCatalog || availableHandles === undefined) return [];
    let available = allApiHandles.flatMap((handle) =>
      modelsForBackendHandle(
        handle,
        includeUnknownBackendHandleInRecommended(handle),
      ),
    );
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      available = available.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.registryHandle?.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }
    // Deduplicate by handle+context_window (same as supportedModels)
    const seen = new Set<string>();
    const deduped: UiModel[] = [];
    for (const m of available) {
      const contextWindow = m.updateArgs?.context_window as number | undefined;
      const key = `${m.handle}:${contextWindow ?? 0}:${serviceTierForModel(m) ?? "default"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }
    return deduped;
  }, [
    backendModelCatalog,
    availableHandles,
    allApiHandles,
    searchQuery,
    modelsForBackendHandle,
    serviceTierForModel,
  ]);

  // Server-all models: ALL handles from the server (for self-hosted)
  const serverAllModels = useMemo(() => {
    if (!backendModelCatalog) return [];
    return allApiHandles;
  }, [backendModelCatalog, allApiHandles]);

  const serverAllModelRows = useMemo(() => {
    if (!backendModelCatalog) return [];
    let rows = serverAllModels.flatMap((handle) =>
      modelsForBackendHandle(handle, true),
    );
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      rows = rows.filter(
        (model) =>
          model.label.toLowerCase().includes(query) ||
          model.description.toLowerCase().includes(query) ||
          model.registryHandle?.toLowerCase().includes(query) ||
          model.handle.toLowerCase().includes(query),
      );
    }
    return rows;
  }, [
    backendModelCatalog,
    serverAllModels,
    modelsForBackendHandle,
    searchQuery,
  ]);

  // Recent models: models the user has recently selected (max 10)
  // Only includes models that are currently available
  const recentModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    const recentHandles = settingsManager.getRecentModels();
    if (recentHandles.length < 2) return []; // Don't show recents with < 2 items

    const resolved: UiModel[] = [];
    for (const handle of recentHandles) {
      // When availableHandles is non-null, skip unavailable models
      if (availableHandles !== null && !availableHandles.has(handle)) continue;

      if (backendModelCatalog) {
        const backendModel = modelsForBackendHandle(handle, true)[0];
        if (backendModel) resolved.push(backendModel);
        continue;
      }

      // Try to resolve to a static model with label/description
      const staticModel = pickPreferredStaticModel(toBaseHandle(handle));
      if (staticModel) {
        resolved.push(
          toByokSelectorModel(
            staticModel,
            handle,
            byokProviderAliases,
            withProviderTypeMetadata(
              handle,
              staticModel.updateArgs as Record<string, unknown> | undefined,
            ),
          ),
        );
      } else {
        const fallbackModel = toSelectorModelForHandle(handle);
        resolved.push({
          ...fallbackModel,
          updateArgs: withProviderTypeMetadata(
            handle,
            fallbackModel.updateArgs,
          ),
        });
      }
    }
    return resolved;
  }, [
    availableHandles,
    backendModelCatalog,
    byokProviderAliases,
    modelsForBackendHandle,
    pickPreferredStaticModel,
    toBaseHandle,
    withProviderTypeMetadata,
  ]);

  // Map category -> list for O(1) lookup
  const categoryListMap = useMemo(
    () => ({
      recents: recentModels,
      supported: supportedModels,
      byok: byokModels,
      "byok-all": byokAllModels.map((handle) => {
        const staticModel = pickPreferredStaticModel(toBaseHandle(handle));
        const staticUpdateArgs = staticModel?.updateArgs as
          | Record<string, unknown>
          | undefined;

        return {
          id: handle,
          handle,
          label: handle,
          description: staticModel?.description ?? "",
          registryHandle: staticModel
            ? registryHandleForByokAlias(handle, byokProviderAliases)
            : undefined,
          updateArgs: withProviderTypeMetadata(handle, staticUpdateArgs),
        };
      }),
      "server-recommended": serverRecommendedModels,
      "server-all": serverAllModelRows,
      all: allLettaModels,
    }),
    [
      recentModels,
      supportedModels,
      byokModels,
      byokAllModels,
      allLettaModels,
      serverRecommendedModels,
      serverAllModelRows,
      byokProviderAliases,
      pickPreferredStaticModel,
      toBaseHandle,
      withProviderTypeMetadata,
    ],
  );

  // Filter out empty categories so the tab bar never shows tabs with 0 items
  const nonEmptyCategories = useMemo(
    () =>
      modelCategories.filter((cat) => {
        const list = categoryListMap[cat];
        if (!list || list.length === 0) return false;
        // Recents tab only shows when there are ≥2 available recent models
        if (cat === "recents" && list.length < 2) return false;
        return true;
      }),
    [modelCategories, categoryListMap],
  );

  // All categories empty → show null state under a single "All" tab
  const allEmpty =
    !isLoading && nonEmptyCategories.length === 0 && !searchQuery;
  const emptyStateActions = useMemo(
    () =>
      getEmptyStateActionDescriptors().map((action) => ({
        ...action,
        onSelect: onOpenConnect,
      })),
    [onOpenConnect],
  );

  // When all categories are empty, collapse to a single "All" tab
  const displayCategories = useMemo(
    () =>
      allEmpty
        ? ([backendModelCatalog ? "server-all" : "all"] as ModelCategory[])
        : nonEmptyCategories,
    [allEmpty, backendModelCatalog, nonEmptyCategories],
  );

  // Get the list for current category
  const currentList: UiModel[] = useMemo(() => {
    const list = categoryListMap[category] as UiModel[] | undefined;
    return list ?? [];
  }, [category, categoryListMap]);

  // Show 1 fewer item because Search line takes space
  const visibleCount = VISIBLE_ITEMS - 1;

  // Auto-switch to first non-empty category if current category becomes empty
  useEffect(() => {
    if (allEmpty) return;
    if (
      nonEmptyCategories.length > 0 &&
      !nonEmptyCategories.includes(category)
    ) {
      setCategory(nonEmptyCategories[0] as ModelCategory);
      resetCursorRef.current(0);
    }
  }, [nonEmptyCategories, category, allEmpty]);

  // Move to the next (or previous) category, and put the cursor back at the top
  // of the new list: the same reset the inline key handler used to do in two
  // places.
  const cycleCategory = useCallback(
    (direction: 1 | -1 = 1) => {
      setCategory((current) => {
        const cats =
          displayCategories.length > 0 ? displayCategories : modelCategories;
        const idx = cats.indexOf(current);
        return cats[
          (idx + direction + cats.length) % cats.length
        ] as ModelCategory;
      });
      resetCursorRef.current(0);
      setSearchQuery("");
    },
    [displayCategories, modelCategories],
  );

  // Set initial selection to current model on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && currentList.length > 0) {
      const index = currentList.findIndex((m) => m.id === currentModelId);
      if (index >= 0) {
        resetCursorRef.current(index);
      }
      initializedRef.current = true;
    }
  }, [currentList, currentModelId]);

  // The toolkit owns the cursor and the navigation keys now. `useOverlayList`
  // publishes `list-bindings.ts` and claims the `overlay` scope; what this face
  // still owns -- its always-live search field, its category tabs, its refresh --
  // goes in `extra`, which sits at the head of the table so a caller can claim
  // keys the list would otherwise take.
  //
  // `vimKeys: false` because that search field is always live: `j` and `k` are
  // search text here, which is exactly the case `list-bindings.ts` documents
  // ("a list that sits beside a text field wants them off: they are letters").
  const listItems: OverlayListItem[] = useMemo(() => {
    if (allEmpty) {
      return emptyStateActions.map((action) => ({
        key: action.id,
        label: action.label,
        description: action.description,
      }));
    }
    return currentList.map((model) => ({
      key: model.id,
      label: model.label,
      description: model.description,
    }));
  }, [allEmpty, emptyStateActions, currentList]);
  const confirmAtCursor = useCallback(
    (key: string) => {
      if (allEmpty) {
        emptyStateActions.find((action) => action.id === key)?.onSelect?.();
        return;
      }
      const selectedModel = currentList.find((model) => model.id === key);
      if (!selectedModel) return;
      onSelect({
        id: selectedModel.id,
        handle: selectedModel.handle,
        label: selectedModel.label,
        description: selectedModel.description,
        registryHandle: selectedModel.registryHandle,
        updateArgs: selectedModel.updateArgs,
      });
    },
    [allEmpty, currentList, emptyStateActions, onSelect],
  );

  const modelList = useOverlayList({
    owner: "model-selector",
    items: listItems,
    // One row is spent on the search line; the toolkit reserves its own indicator
    // rows on top of this window.
    rows: allEmpty ? undefined : visibleCount,
    vimKeys: false,
    navigationEnabled: !isLoading && listItems.length > 0,
    onConfirm: confirmAtCursor,
    onCancel,
    extra: [
      // Escape clears the search first and only cancels when there is nothing to
      // clear -- the order this face has always had.
      {
        id: "model-selector.clear-search",
        chords: [{ key: "escape" }],
        run: () => {
          if (!searchQuery) return "declined";
          setSearchQuery("");
          resetCursorRef.current(0);
          return "consumed";
        },
      },
      // `r` refreshes, even while a refresh is in flight (the key is consumed so
      // repeated presses do not become search text); with a query live it is
      // search text instead.
      {
        id: "model-selector.refresh",
        chords: [{ key: "r" }],
        run: () => {
          if (searchQuery) return "declined";
          if (!refreshing) loadModels.current(true);
          return "consumed";
        },
      },
      {
        id: "model-selector.cycle-category",
        chords: [{ key: "tab" }, { key: "rightArrow" }, { key: "leftArrow" }],
        run: ({ key }) => {
          cycleCategory(key.leftArrow ? -1 : 1);
          return "consumed";
        },
      },
      {
        id: "model-selector.search-backspace",
        chords: [{ key: "backspace" }, { key: "delete" }],
        run: () => {
          if (searchQuery) {
            setSearchQuery((prev) => prev.slice(0, -1));
            resetCursorRef.current(0);
          }
          return "consumed";
        },
      },
      // Anything else printable is search text. Named keys (arrows, Enter, Tab,
      // Escape, PageUp/Down, Home/End) decline, so the navigation table below
      // still receives them.
      {
        id: "model-selector.search-text",
        run: ({ input, key }) => {
          if (
            !input ||
            input.length !== 1 ||
            key.ctrl ||
            key.meta ||
            key.return ||
            key.upArrow ||
            key.downArrow
          ) {
            return "declined";
          }
          setSearchQuery((prev) => prev + input);
          resetCursorRef.current(0);
          return "consumed";
        },
      },
    ],
  });
  resetCursorRef.current = modelList.setCursor;

  const getCategoryLabel = (cat: ModelCategory) => {
    if (cat === "recents") return `Recents [${recentModels.length}]`;
    if (cat === "supported") return `Letta API [${supportedModels.length}]`;
    if (cat === "byok") return `BYOK [${byokModels.length}]`;
    if (cat === "byok-all") return `BYOK (all) [${byokAllModels.length}]`;
    if (cat === "server-recommended")
      return `Recommended [${serverRecommendedModels.length}]`;
    if (cat === "server-all")
      return `All models [${serverAllModelRows.length}]`;
    return `Letta API (all) [${allLettaModels.length}]`;
  };

  const getCategoryDescription = (cat: ModelCategory) => {
    if (cat === "recents") {
      return "Models you've recently used";
    }
    if (cat === "server-recommended") {
      return "Recommended models currently available for this account";
    }
    if (cat === "server-all") {
      return "All models currently available for this account";
    }
    if (cat === "supported") {
      return isFreeTier
        ? "Upgrade your account to access more models"
        : "Recommended Letta API models currently available for this account";
    }
    if (cat === "byok")
      return "Recommended models via your connected API keys (use /connect to add more)";
    if (cat === "byok-all")
      return "All models via your connected API keys (use /connect to add more)";
    if (cat === "all") {
      return isFreeTier
        ? "Upgrade your account to access more models"
        : "All Letta API models currently available for this account";
    }
    return "All Letta API models currently available for this account";
  };

  return (
    <OverlayFrame
      command="/model"
      title="Swap your agent's model"
      footer={
        !isLoading && currentList.length > 0 ? (
          <Box flexDirection="column">
            <Text dimColor>
              {"  "}
              {currentList.length} models{isCached ? " · cached" : ""}
              {refreshing ? " · refreshing..." : " · R to refresh list"}
            </Text>
            <Text dimColor>
              {"  "}Enter select · ↑↓ navigate · ←→/Tab switch · Esc cancel
            </Text>
          </Box>
        ) : undefined
      }
    >
      {!isLoading && !allEmpty && (
        <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
          <TabBar
            tabs={displayCategories}
            activeTab={category}
            getLabel={getCategoryLabel}
          />
          <Text dimColor> {getCategoryDescription(category)}</Text>
          <Text>
            <Text dimColor> Search: </Text>
            {searchQuery ? (
              <Text>{searchQuery}</Text>
            ) : (
              <Text dimColor>(type to filter)</Text>
            )}
          </Text>
        </Box>
      )}

      {/* Null state — no models available */}
      {!isLoading && allEmpty && (
        <Box flexDirection="column" paddingLeft={1}>
          <TabBar
            tabs={displayCategories}
            activeTab={displayCategories[0] as ModelCategory}
            getLabel={getCategoryLabel}
          />
          <Box flexDirection="column" paddingLeft={1} marginTop={1}>
            <Text dimColor>No models available.</Text>
            <Text dimColor>
              Set an LLM API key in your env and restart `haruyuki` or use the
              following options:
            </Text>
            <Box height={1} />
            <OverlayListView
              items={listItems}
              cursor={modelList.cursor}
              renderRow={(item, _index, isCursor) => (
                <Box flexDirection="column" marginBottom={1}>
                  <Text
                    color={
                      isCursor ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {isCursor ? "> " : "  "}
                    {item.label}
                  </Text>
                  <Box paddingLeft={2}>
                    <Text dimColor>{item.description ?? ""}</Text>
                  </Box>
                </Box>
              )}
            />
          </Box>
        </Box>
      )}

      {/* Loading states */}
      {isLoading && (
        <Box paddingLeft={2}>
          <Text dimColor>Loading available models...</Text>
        </Box>
      )}

      {error && (
        <Box paddingLeft={2}>
          <Text color="yellow">
            Warning: Could not fetch available models. Showing all models.
          </Text>
        </Box>
      )}

      {!isLoading && !allEmpty && listItems.length === 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>
            {searchQuery
              ? "No models match your search."
              : "No additional models available."}
          </Text>
        </Box>
      )}

      {/* Model list */}
      {refreshing && (
        <Box paddingLeft={2}>
          <Text dimColor>Refreshing list...</Text>
        </Box>
      )}
      <OverlayListView
        items={listItems}
        cursor={modelList.cursor}
        rows={allEmpty ? undefined : visibleCount}
        renderRow={(_item, index, isCursor) => {
          const model = currentList[index];
          if (!model) return null;
          const modelServiceTier = serviceTierForModel(model);
          const currentServiceTier =
            currentModelServiceTier === CHATGPT_FAST_SERVICE_TIER
              ? CHATGPT_FAST_SERVICE_TIER
              : null;
          const isCurrent =
            (model.id === currentModelId ||
              model.handle === currentModelHandle) &&
            modelServiceTier === currentServiceTier;
          // Show lock for non-free models when on free tier (only for Letta API tabs)
          const showLock =
            isFreeTier &&
            !model.free &&
            (category === "supported" || category === "all");

          return (
            <Box flexDirection="row">
              <Text
                color={isCursor ? colors.selector.itemHighlighted : undefined}
              >
                {isCursor ? "> " : "  "}
              </Text>
              {showLock && <Text dimColor>🔒 </Text>}
              <Text
                bold={isCursor}
                color={
                  isCursor
                    ? colors.selector.itemHighlighted
                    : isCurrent
                      ? colors.selector.itemCurrent
                      : undefined
                }
              >
                {model.label}
                {isCurrent && <Text> (current)</Text>}
              </Text>
              {model.description && (
                <Text dimColor> · {model.description}</Text>
              )}
            </Box>
          );
        }}
      />
    </OverlayFrame>
  );
}
