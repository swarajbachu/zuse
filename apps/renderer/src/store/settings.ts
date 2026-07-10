import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import {
  type AppearanceMode,
  type AutonomyLevel,
  type BranchNamingStyle,
  defaultModelEnabledByProvider,
  defaultModelFor,
  type CompletionSoundPreset,
  type GitMergeMethod,
  type ModelEnabledByProvider,
  type OpencodeCustomProvider,
  type ProviderId,
  resolveModelSlug,
  type RuntimeMode,
  type SettingsFile,
} from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client";
import { readStorageWithLegacy, removeStorageKeys } from "../lib/storage-keys";

/**
 * Renderer view of `settings.json`. Lives in the main process — this store
 * is just a hot mirror kept in sync via `settings.stream`. Setters POST
 * patches via `settings.update`; the resulting echo through the stream
 * updates the store, so we don't optimistically write twice.
 *
 * Two pre-existing localStorage keys (`memoize.settings.v1` and
 * `memoize.subagents`) are migrated to disk on first launch via
 * `settings.migrateLocalStorage` and then cleared.
 */

const DEFAULT_PROVIDER: ProviderId = "claude";
const DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";
const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "approval-gated";
const DEFAULT_BRANCH_NAMING_STYLE: BranchNamingStyle = "username-slug";

const PROVIDER_IDS: ReadonlyArray<ProviderId> = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "gemini",
  "opencode",
];

const seedModels = (): Record<ProviderId, string> => ({
  claude: defaultModelFor("claude"),
  codex: defaultModelFor("codex"),
  grok: defaultModelFor("grok"),
  cursor: defaultModelFor("cursor"),
  gemini: defaultModelFor("gemini"),
  opencode: defaultModelFor("opencode"),
});

const seedProviderEnabled = (): Record<ProviderId, boolean> => {
  const out = {} as Record<ProviderId, boolean>;
  for (const id of PROVIDER_IDS) out[id] = true;
  return out;
};

const seedModelEnabledByProvider = defaultModelEnabledByProvider;

const mergeModelEnabled = (
  input: Partial<Record<ProviderId, Partial<Record<string, boolean>>>>,
): ModelEnabledByProvider => {
  const base = seedModelEnabledByProvider();
  for (const id of PROVIDER_IDS) {
    const providerFlags = input[id];
    if (providerFlags === undefined) continue;
    for (const [modelId, value] of Object.entries(providerFlags)) {
      if (typeof value === "boolean") base[id][modelId] = value;
    }
  }
  return base;
};

const OLD_SETTINGS_KEY = "memoize.settings.v1";
const OLD_SUBAGENTS_KEY = "memoize.subagents";
const MERGE_PREFS_KEY = "zuse.mergePrefs.v1";
const OLD_MERGE_PREFS_KEYS = ["memoize.mergePrefs.v1"] as const;

const fallbackSnapshot = (): SettingsSlice => ({
  defaultProviderId: DEFAULT_PROVIDER,
  defaultModelByProvider: seedModels(),
  defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
  defaultAutoCreateWorktree: true,
  defaultAutonomyLevel: DEFAULT_AUTONOMY_LEVEL,
  completionSoundEnabled: false,
  completionSoundPreset: "chime",
  appearanceMode: "dark",
  onboardingCompleted: false,
  providerEnabled: seedProviderEnabled(),
  modelEnabledByProvider: seedModelEnabledByProvider(),
  opencodeProviderVisible: {},
  opencodeModelVisibleByProvider: {},
  opencodeCustomProviders: [],
  branchNamingStyle: DEFAULT_BRANCH_NAMING_STYLE,
  branchNamingPrefix: "",
  mergePrefs: { method: "merge", deleteBranch: false },
  notchTrayEnabled: false,
  notchTrayPinned: false,
});

const sliceFromFile = (file: SettingsFile): SettingsSlice => {
  const models: Record<ProviderId, string> = {
    ...seedModels(),
    ...file.defaultModelByProvider,
  };
  // Re-run resolveModelSlug on every emit so a stale alias doesn't sneak
  // back through a follow-up edit to the JSON file.
  for (const id of Object.keys(models) as ProviderId[]) {
    models[id] = resolveModelSlug(id, models[id]);
  }
  return {
    defaultProviderId: file.defaultProviderId,
    defaultModelByProvider: models,
    defaultRuntimeMode: file.defaultRuntimeMode,
    defaultAutoCreateWorktree: file.defaultAutoCreateWorktree,
    defaultAutonomyLevel: file.defaultAutonomyLevel,
    completionSoundEnabled: file.completionSoundEnabled,
    completionSoundPreset: file.completionSoundPreset,
    appearanceMode: file.appearanceMode,
    onboardingCompleted: file.onboardingCompleted,
    providerEnabled: {
      ...seedProviderEnabled(),
      ...file.providerEnabled,
    },
    modelEnabledByProvider: mergeModelEnabled(file.modelEnabledByProvider),
    opencodeProviderVisible: { ...file.opencodeProviderVisible },
    opencodeModelVisibleByProvider: Object.fromEntries(
      Object.entries(file.opencodeModelVisibleByProvider).map(([k, v]) => [
        k,
        { ...v },
      ]),
    ),
    opencodeCustomProviders: file.opencodeCustomProviders.map((p) => ({
      ...p,
      models: p.models.map((m) => ({ ...m })),
    })),
    branchNamingStyle: file.branchNamingStyle,
    branchNamingPrefix: file.branchNamingPrefix,
    mergePrefs: file.mergePrefs,
    notchTrayEnabled: file.notchTrayEnabled,
    notchTrayPinned: file.notchTrayPinned,
  };
};

interface SettingsSlice {
  readonly defaultProviderId: ProviderId;
  readonly defaultModelByProvider: Record<ProviderId, string>;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly defaultAutoCreateWorktree: boolean;
  readonly defaultAutonomyLevel: AutonomyLevel;
  readonly completionSoundEnabled: boolean;
  readonly completionSoundPreset: CompletionSoundPreset;
  readonly appearanceMode: AppearanceMode;
  readonly onboardingCompleted: boolean;
  readonly providerEnabled: Record<ProviderId, boolean>;
  readonly modelEnabledByProvider: ModelEnabledByProvider;
  /** OpenCode sub-provider visibility in the model picker (id → shown). */
  readonly opencodeProviderVisible: Record<string, boolean>;
  /** OpenCode per-sub-provider model visibility (providerId → modelId → shown). */
  readonly opencodeModelVisibleByProvider: Record<
    string,
    Record<string, boolean>
  >;
  readonly opencodeCustomProviders: ReadonlyArray<OpencodeCustomProvider>;
  readonly branchNamingStyle: BranchNamingStyle;
  readonly branchNamingPrefix: string;
  readonly mergePrefs: { method: GitMergeMethod; deleteBranch: boolean };
  readonly notchTrayEnabled: boolean;
  readonly notchTrayPinned: boolean;
}

type SettingsState = SettingsSlice & {
  /** True once the first RPC fetch has resolved. Used by gates that need
   *  to wait before reading defaults (e.g. onboarding). */
  readonly loaded: boolean;
  readonly hydrate: () => Promise<void>;
  readonly setDefaultProvider: (providerId: ProviderId) => void;
  readonly setDefaultModel: (providerId: ProviderId, model: string) => void;
  /**
   * Set both the default provider and that provider's default model in one
   * patch. The model picker treats picking a model as a single user action;
   * sending two separate RPCs raced on the server's atomic-write tmp file.
   */
  readonly setDefaultProviderAndModel: (
    providerId: ProviderId,
    model: string,
  ) => void;
  readonly setDefaultRuntimeMode: (mode: RuntimeMode) => void;
  readonly setDefaultAutoCreateWorktree: (value: boolean) => void;
  readonly setDefaultAutonomyLevel: (level: AutonomyLevel) => void;
  readonly setCompletionSoundEnabled: (value: boolean) => void;
  readonly setCompletionSoundPreset: (preset: CompletionSoundPreset) => void;
  readonly setAppearanceMode: (mode: AppearanceMode) => void;
  readonly setOnboardingCompleted: (value: boolean) => void;
  readonly setProviderEnabled: (providerId: ProviderId, value: boolean) => void;
  readonly setModelEnabled: (
    providerId: ProviderId,
    modelId: string,
    value: boolean,
  ) => void;
  readonly setOpencodeProviderVisible: (
    providerId: string,
    value: boolean,
  ) => void;
  readonly setOpencodeModelVisible: (
    providerId: string,
    modelId: string,
    value: boolean,
  ) => void;
  readonly setBranchNamingStyle: (style: BranchNamingStyle) => void;
  readonly setBranchNamingPrefix: (prefix: string) => void;
  readonly setMergePrefs: (prefs: {
    method: GitMergeMethod;
    deleteBranch: boolean;
  }) => void;
  readonly setNotchTrayEnabled: (value: boolean) => void;
  readonly setNotchTrayPinned: (value: boolean) => void;
};

let streamFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;

const stopStream = async () => {
  if (streamFiber !== null) {
    const f = streamFiber;
    streamFiber = null;
    await Effect.runPromise(Fiber.interrupt(f));
  }
};

/**
 * One-shot localStorage migration. Reads the two pre-feature keys and
 * forwards them to the main process; the main process merges them onto
 * the on-disk settings only if the file still looks fresh, so a second
 * call (e.g. from a hot-reloaded renderer) is a no-op. Always clear
 * localStorage afterwards so the renderer doesn't carry stale data.
 */
const migrateLocalStorageOnce = async (): Promise<SettingsFile | null> => {
  if (typeof window === "undefined") return null;
  const settingsV1Raw = window.localStorage.getItem(OLD_SETTINGS_KEY);
  const subagentsRaw = window.localStorage.getItem(OLD_SUBAGENTS_KEY);
  if (settingsV1Raw === null && subagentsRaw === null) return null;
  try {
    const client = await getRpcClient();
    const file = await Effect.runPromise(
      client["settings.migrateLocalStorage"]({
        settingsV1Raw: settingsV1Raw ?? undefined,
        subagentsRaw: subagentsRaw ?? undefined,
      }),
    );
    window.localStorage.removeItem(OLD_SETTINGS_KEY);
    window.localStorage.removeItem(OLD_SUBAGENTS_KEY);
    return file;
  } catch {
    // If the RPC fails (rare — main is up by now), leave localStorage in
    // place so the next reload can retry. The store falls back to defaults.
    return null;
  }
};

const migrateMergePrefsOnce = async (
  file: SettingsFile,
): Promise<SettingsFile> => {
  if (typeof window === "undefined") return file;
  const raw = readStorageWithLegacy(
    window.localStorage,
    MERGE_PREFS_KEY,
    OLD_MERGE_PREFS_KEYS,
  );
  if (raw === null) return file;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const method =
      parsed.method === "merge" ||
      parsed.method === "squash" ||
      parsed.method === "rebase"
        ? parsed.method
        : file.mergePrefs.method;
    const mergePrefs = {
      method,
      deleteBranch:
        typeof parsed.deleteBranch === "boolean"
          ? parsed.deleteBranch
          : file.mergePrefs.deleteBranch,
    };
    const client = await getRpcClient();
    const next = await Effect.runPromise(
      client["settings.update"]({ patch: { mergePrefs } }),
    );
    removeStorageKeys(
      window.localStorage,
      MERGE_PREFS_KEY,
      OLD_MERGE_PREFS_KEYS,
    );
    return next;
  } catch {
    return file;
  }
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...fallbackSnapshot(),
  loaded: false,

  hydrate: async () => {
    // Drain any pre-existing localStorage first so a successful migration
    // is visible on the very first `settings.get` we do below.
    await migrateLocalStorageOnce();

    try {
      const client = await getRpcClient();
      const file = await migrateMergePrefsOnce(
        await Effect.runPromise(client["settings.get"]()),
      );
      set({ ...sliceFromFile(file), loaded: true });

      await stopStream();
      streamFiber = Effect.runFork(
        Stream.runForEach(client["settings.stream"](), (next) =>
          Effect.sync(() => set(sliceFromFile(next))),
        ),
      );
    } catch {
      set({ loaded: true });
    }
  },

  setDefaultProvider: (providerId) => {
    set({ defaultProviderId: providerId });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { defaultProviderId: providerId } }),
      );
    })();
  },
  setDefaultModel: (providerId, model) => {
    const next = { ...get().defaultModelByProvider, [providerId]: model };
    set({ defaultModelByProvider: next });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { defaultModelByProvider: next } }),
      );
    })();
  },
  setDefaultProviderAndModel: (providerId, model) => {
    const next = { ...get().defaultModelByProvider, [providerId]: model };
    set({ defaultProviderId: providerId, defaultModelByProvider: next });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({
          patch: {
            defaultProviderId: providerId,
            defaultModelByProvider: next,
          },
        }),
      );
    })();
  },
  setDefaultRuntimeMode: (mode) => {
    set({ defaultRuntimeMode: mode });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { defaultRuntimeMode: mode } }),
      );
    })();
  },
  setDefaultAutoCreateWorktree: (value) => {
    set({ defaultAutoCreateWorktree: value });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({
          patch: { defaultAutoCreateWorktree: value },
        }),
      );
    })();
  },
  setDefaultAutonomyLevel: (level) => {
    set({ defaultAutonomyLevel: level });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({
          patch: { defaultAutonomyLevel: level },
        }),
      );
    })();
  },
  setCompletionSoundEnabled: (value) => {
    set({ completionSoundEnabled: value });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { completionSoundEnabled: value } }),
      );
    })();
  },
  setCompletionSoundPreset: (preset) => {
    set({ completionSoundPreset: preset });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { completionSoundPreset: preset } }),
      );
    })();
  },
  setAppearanceMode: (mode) => {
    set({ appearanceMode: mode });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { appearanceMode: mode } }),
      );
    })();
  },
  setOnboardingCompleted: (value) => {
    set({ onboardingCompleted: value });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { onboardingCompleted: value } }),
      );
    })();
  },
  setProviderEnabled: (providerId, value) => {
    const next = { ...get().providerEnabled, [providerId]: value };
    set({ providerEnabled: next });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { providerEnabled: next } }),
      );
    })();
  },
  setModelEnabled: (providerId, modelId, value) => {
    const current = get().modelEnabledByProvider;
    const next: ModelEnabledByProvider = {
      ...current,
      [providerId]: {
        ...current[providerId],
        [modelId]: value,
      },
    };
    set({ modelEnabledByProvider: next });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { modelEnabledByProvider: next } }),
      );
    })();
  },
  setOpencodeProviderVisible: (providerId, value) => {
    const next = { ...get().opencodeProviderVisible, [providerId]: value };
    set({ opencodeProviderVisible: next });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { opencodeProviderVisible: next } }),
      );
    })();
  },
  setOpencodeModelVisible: (providerId, modelId, value) => {
    const current = get().opencodeModelVisibleByProvider;
    const next: Record<string, Record<string, boolean>> = {
      ...current,
      [providerId]: { ...current[providerId], [modelId]: value },
    };
    set({ opencodeModelVisibleByProvider: next });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({
          patch: { opencodeModelVisibleByProvider: next },
        }),
      );
    })();
  },
  setBranchNamingStyle: (style) => {
    set({ branchNamingStyle: style });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { branchNamingStyle: style } }),
      );
    })();
  },
  setBranchNamingPrefix: (prefix) => {
    set({ branchNamingPrefix: prefix });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { branchNamingPrefix: prefix } }),
      );
    })();
  },
  setMergePrefs: (mergePrefs) => {
    set({ mergePrefs });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { mergePrefs } }),
      );
    })();
  },
  setNotchTrayEnabled: (value) => {
    set({ notchTrayEnabled: value });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { notchTrayEnabled: value } }),
      );
    })();
  },
  setNotchTrayPinned: (value) => {
    set({ notchTrayPinned: value });
    void (async () => {
      const client = await getRpcClient();
      await Effect.runPromise(
        client["settings.update"]({ patch: { notchTrayPinned: value } }),
      );
    })();
  },
}));
