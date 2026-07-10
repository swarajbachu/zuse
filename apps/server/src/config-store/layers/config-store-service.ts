import * as fsSync from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as NodePath from "node:path";

import { FileSystem, Path } from "effect";
import { Effect, Layer, PubSub, Ref, Semaphore, Stream } from "effect";

import {
  type AppearanceMode,
  type BranchNamingStyle,
  type Command,
  type CompletionSoundPreset,
  defaultModelEnabledByProvider,
  defaultModelFor,
  type KeybindingRule,
  KeybindingsFile,
  MODELS_BY_PROVIDER,
  MAX_KEYBINDING_RULES,
  type ProviderId,
  resolveModelSlug,
  SettingsFile,
  type MergePrefs,
  type SettingsPatch,
  type SubagentPresetState,
} from "@zuse/wire";

import { AppPaths } from "../../app-paths.ts";
import {
  ConfigStoreService,
  type ConfigStoreServiceShape,
} from "../services/config-store-service.ts";

/**
 * Coalesce watcher fires inside this window. Editors save by truncate+
 * rewrite or rename-over, both of which emit multiple events per logical
 * write — debouncing keeps the change pipeline single-fire.
 */
const WATCH_DEBOUNCE_MS = 100;

const SETTINGS_FILENAME = "settings.json";
const KEYBINDINGS_FILENAME = "keybindings.json";
const USER_CONFIG_DIRNAME = ".zuse";
const DEV_USER_CONFIG_DIRNAME = ".zuse-dev";

const PROVIDER_IDS: ProviderId[] = [
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

const freshSettings = (): SettingsFile =>
  SettingsFile.make({
    schemaVersion: 1,
    defaultProviderId: "claude",
    defaultModelByProvider: seedModels(),
    defaultRuntimeMode: "approval-required",
    // Worktrees on by default: each new chat runs on its own branch so parallel
    // agents stay isolated. Per-repo settings can still opt a repo out.
    defaultAutoCreateWorktree: true,
    defaultAutonomyLevel: "approval-gated",
    onboardingCompleted: false,
    appearanceMode: "dark",
    completionSoundEnabled: false,
    completionSoundPreset: "chime",
    providerEnabled: seedProviderEnabled(),
    modelEnabledByProvider: seedModelEnabledByProvider(),
    opencodeProviderVisible: {},
    opencodeModelVisibleByProvider: {},
    opencodeCustomProviders: [],
    subagents: { enableForNewSessions: true, presets: {} },
    branchNamingStyle: "username-slug",
    branchNamingPrefix: "",
    mergePrefs: { method: "merge", deleteBranch: false },
    notchTrayEnabled: false,
    notchTrayPinned: false,
  });

const freshKeybindings = (): KeybindingsFile =>
  KeybindingsFile.make({ schemaVersion: 1, rules: [] });

const serialize = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/* ───────────── parse helpers — tolerant of legacy / missing fields ───────────── */

const isProviderId = (v: unknown): v is ProviderId =>
  v === "claude" ||
  v === "codex" ||
  v === "grok" ||
  v === "cursor" ||
  v === "gemini" ||
  v === "opencode";

const isRuntimeMode = (v: unknown): v is SettingsFile["defaultRuntimeMode"] =>
  v === "approval-required" ||
  v === "auto-accept-edits" ||
  v === "auto-accept-edits-and-bash" ||
  v === "full-access";

const isAutonomyLevel = (
  v: unknown,
): v is SettingsFile["defaultAutonomyLevel"] =>
  v === "off" || v === "approval-gated" || v === "autonomous";

const isCompletionSoundPreset = (v: unknown): v is CompletionSoundPreset =>
  v === "chime" ||
  v === "soft" ||
  v === "pop" ||
  v === "bell" ||
  v === "rise" ||
  v === "bloom";

const isAppearanceMode = (v: unknown): v is AppearanceMode =>
  v === "system" || v === "light" || v === "dark";

const isBranchNamingStyle = (v: unknown): v is BranchNamingStyle =>
  v === "username-slug" || v === "slug" || v === "feat-slug" || v === "custom";

const isMergeMethod = (v: unknown): v is MergePrefs["method"] =>
  v === "merge" || v === "squash" || v === "rebase";

const isCommand = (v: unknown): v is Command =>
  v === "new-chat" ||
  v === "open-project" ||
  v === "settings" ||
  v === "close-tab" ||
  v === "toggle-left-sidebar" ||
  v === "toggle-right-sidebar" ||
  v === "toggle-terminal" ||
  v === "focus-composer" ||
  v === "next-tab" ||
  v === "prev-tab" ||
  v === "select-tab-1" ||
  v === "select-tab-2" ||
  v === "select-tab-3" ||
  v === "select-tab-4" ||
  v === "select-tab-5" ||
  v === "select-tab-6" ||
  v === "select-tab-7" ||
  v === "select-tab-8" ||
  v === "select-last-tab" ||
  v === "new-tab" ||
  v === "next-chat" ||
  v === "prev-chat" ||
  v === "next-panel" ||
  v === "prev-panel" ||
  v === "focus-next-pane" ||
  v === "focus-prev-pane" ||
  v === "open-chat-switcher" ||
  v === "composer.submit" ||
  v === "composer.newline" ||
  v === "composer.forceSubmit" ||
  v === "composer.togglePlanMode" ||
  v === "editor.save" ||
  v === "editor.annotate";

const isDevConfigProfile = (): boolean =>
  process.env.ZUSE_CONFIG_PROFILE?.trim() === "dev" ||
  process.env.ZUSE_DEV_CONFIG?.trim() === "1" ||
  Boolean(process.env.VITE_DEV_SERVER_URL?.trim());

const defaultUserConfigDirname = (): string =>
  isDevConfigProfile() ? DEV_USER_CONFIG_DIRNAME : USER_CONFIG_DIRNAME;

const resolveUserConfigDir = (join: (a: string, b: string) => string): string =>
  process.env.ZUSE_CONFIG_DIR?.trim() ||
  join(homedir(), defaultUserConfigDirname());

/**
 * Re-shape an arbitrary parsed JSON value onto a `SettingsFile`, falling
 * through to defaults for anything missing/invalid. We don't trust the file
 * on disk — it can be hand-edited and might be from an older schema.
 */
const coerceSettings = (raw: unknown): SettingsFile => {
  const base = freshSettings();
  if (raw === null || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;

  const provider = isProviderId(obj.defaultProviderId)
    ? obj.defaultProviderId
    : base.defaultProviderId;

  const inputModels =
    typeof obj.defaultModelByProvider === "object" &&
    obj.defaultModelByProvider !== null
      ? (obj.defaultModelByProvider as Record<string, unknown>)
      : {};
  const models: Record<ProviderId, string> = { ...base.defaultModelByProvider };
  for (const id of PROVIDER_IDS) {
    const v = inputModels[id];
    if (typeof v === "string" && v.length > 0) {
      models[id] = resolveModelSlug(id, v);
    }
  }

  const runtime = isRuntimeMode(obj.defaultRuntimeMode)
    ? obj.defaultRuntimeMode
    : base.defaultRuntimeMode;

  const autoWorktree =
    typeof obj.defaultAutoCreateWorktree === "boolean"
      ? obj.defaultAutoCreateWorktree
      : base.defaultAutoCreateWorktree;

  const autonomy = isAutonomyLevel(obj.defaultAutonomyLevel)
    ? obj.defaultAutonomyLevel
    : base.defaultAutonomyLevel;

  const onboarding =
    typeof obj.onboardingCompleted === "boolean"
      ? obj.onboardingCompleted
      : base.onboardingCompleted;

  const appearanceMode = isAppearanceMode(obj.appearanceMode)
    ? obj.appearanceMode
    : base.appearanceMode;

  const completionSoundEnabled =
    typeof obj.completionSoundEnabled === "boolean"
      ? obj.completionSoundEnabled
      : base.completionSoundEnabled;

  const completionSoundPreset = isCompletionSoundPreset(
    obj.completionSoundPreset,
  )
    ? obj.completionSoundPreset
    : base.completionSoundPreset;

  const providerEnabled: Record<ProviderId, boolean> = {
    ...base.providerEnabled,
  };
  if (typeof obj.providerEnabled === "object" && obj.providerEnabled !== null) {
    const flags = obj.providerEnabled as Record<string, unknown>;
    for (const id of PROVIDER_IDS) {
      const v = flags[id];
      if (typeof v === "boolean") providerEnabled[id] = v;
    }
  }

  const modelEnabledByProvider = seedModelEnabledByProvider();
  if (
    typeof obj.modelEnabledByProvider === "object" &&
    obj.modelEnabledByProvider !== null
  ) {
    const byProvider = obj.modelEnabledByProvider as Record<string, unknown>;
    for (const id of PROVIDER_IDS) {
      const providerModels = byProvider[id];
      if (typeof providerModels !== "object" || providerModels === null) {
        continue;
      }
      const flags = providerModels as Record<string, unknown>;
      const knownModelIds = new Set(MODELS_BY_PROVIDER[id].map((m) => m.id));
      for (const [modelId, value] of Object.entries(flags)) {
        if (!knownModelIds.has(modelId)) continue;
        if (typeof value === "boolean") {
          modelEnabledByProvider[id][modelId] = value;
        }
      }
    }
  }

  // OpenCode provider-manager fields. Keyed by opencode sub-provider id
  // (free-form strings), so unlike the maps above we don't restrict to a
  // known key set — just validate value shapes and drop anything malformed.
  const opencodeProviderVisible: Record<string, boolean> = {};
  if (
    typeof obj.opencodeProviderVisible === "object" &&
    obj.opencodeProviderVisible !== null
  ) {
    for (const [k, v] of Object.entries(
      obj.opencodeProviderVisible as Record<string, unknown>,
    )) {
      if (typeof v === "boolean") opencodeProviderVisible[k] = v;
    }
  }

  const opencodeModelVisibleByProvider: Record<
    string,
    Record<string, boolean>
  > = {};
  if (
    typeof obj.opencodeModelVisibleByProvider === "object" &&
    obj.opencodeModelVisibleByProvider !== null
  ) {
    for (const [pid, models] of Object.entries(
      obj.opencodeModelVisibleByProvider as Record<string, unknown>,
    )) {
      if (typeof models !== "object" || models === null) continue;
      const flags: Record<string, boolean> = {};
      for (const [mid, v] of Object.entries(
        models as Record<string, unknown>,
      )) {
        if (typeof v === "boolean") flags[mid] = v;
      }
      opencodeModelVisibleByProvider[pid] = flags;
    }
  }

  const opencodeCustomProviders: {
    id: string;
    name: string;
    baseURL: string;
    npm: string;
    models: { id: string; name: string }[];
  }[] = [];
  if (Array.isArray(obj.opencodeCustomProviders)) {
    for (const item of obj.opencodeCustomProviders) {
      if (typeof item !== "object" || item === null) continue;
      const p = item as Record<string, unknown>;
      if (
        typeof p.id !== "string" ||
        typeof p.name !== "string" ||
        typeof p.baseURL !== "string"
      ) {
        continue;
      }
      const models: { id: string; name: string }[] = [];
      if (Array.isArray(p.models)) {
        for (const m of p.models) {
          if (typeof m !== "object" || m === null) continue;
          const mm = m as Record<string, unknown>;
          if (typeof mm.id === "string" && typeof mm.name === "string") {
            models.push({ id: mm.id, name: mm.name });
          }
        }
      }
      opencodeCustomProviders.push({
        id: p.id,
        name: p.name,
        baseURL: p.baseURL,
        // Legacy entries (pre-type-picker) default to OpenAI-compatible.
        npm:
          typeof p.npm === "string" && p.npm.length > 0
            ? p.npm
            : "@ai-sdk/openai-compatible",
        models,
      });
    }
  }

  let subagents = base.subagents;
  if (typeof obj.subagents === "object" && obj.subagents !== null) {
    const sub = obj.subagents as Record<string, unknown>;
    const enable =
      typeof sub.enableForNewSessions === "boolean"
        ? sub.enableForNewSessions
        : true;
    const presets: Record<string, SubagentPresetState> = {};
    if (typeof sub.presets === "object" && sub.presets !== null) {
      for (const [key, val] of Object.entries(
        sub.presets as Record<string, unknown>,
      )) {
        if (typeof val !== "object" || val === null) continue;
        const ps = val as Record<string, unknown>;
        presets[key] = {
          enabled: typeof ps.enabled === "boolean" ? ps.enabled : true,
          overrides:
            typeof ps.overrides === "object" && ps.overrides !== null
              ? (ps.overrides as SubagentPresetState["overrides"])
              : {},
        };
      }
    }
    subagents = { enableForNewSessions: enable, presets };
  }

  const branchNamingStyle = isBranchNamingStyle(obj.branchNamingStyle)
    ? obj.branchNamingStyle
    : base.branchNamingStyle;

  const branchNamingPrefix =
    typeof obj.branchNamingPrefix === "string"
      ? obj.branchNamingPrefix
      : base.branchNamingPrefix;

  let mergePrefs = base.mergePrefs;
  if (typeof obj.mergePrefs === "object" && obj.mergePrefs !== null) {
    const prefs = obj.mergePrefs as Record<string, unknown>;
    mergePrefs = {
      method: isMergeMethod(prefs.method)
        ? prefs.method
        : base.mergePrefs.method,
      deleteBranch:
        typeof prefs.deleteBranch === "boolean"
          ? prefs.deleteBranch
          : base.mergePrefs.deleteBranch,
    };
  }

  const notchTrayEnabled =
    typeof obj.notchTrayEnabled === "boolean"
      ? obj.notchTrayEnabled
      : base.notchTrayEnabled;

  const notchTrayPinned =
    typeof obj.notchTrayPinned === "boolean"
      ? obj.notchTrayPinned
      : base.notchTrayPinned;

  return SettingsFile.make({
    schemaVersion: 1,
    defaultProviderId: provider,
    defaultModelByProvider: models,
    defaultRuntimeMode: runtime,
    defaultAutoCreateWorktree: autoWorktree,
    defaultAutonomyLevel: autonomy,
    onboardingCompleted: onboarding,
    appearanceMode,
    completionSoundEnabled,
    completionSoundPreset,
    providerEnabled,
    modelEnabledByProvider,
    opencodeProviderVisible,
    opencodeModelVisibleByProvider,
    opencodeCustomProviders,
    subagents,
    branchNamingStyle,
    branchNamingPrefix,
    mergePrefs,
    notchTrayEnabled,
    notchTrayPinned,
  });
};

const coerceKeybindings = (raw: unknown): KeybindingsFile => {
  if (raw === null || typeof raw !== "object") return freshKeybindings();
  const obj = raw as Record<string, unknown>;
  const inRules = Array.isArray(obj.rules) ? obj.rules : [];
  const rules: KeybindingRule[] = [];
  for (const item of inRules) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== "string" || !isCommand(r.command)) continue;
    // Keep the original strings; the renderer / matcher revalidates on parse.
    const rule: KeybindingRule = {
      key: r.key,
      command: r.command,
      when: typeof r.when === "string" ? r.when : undefined,
    };
    rules.push(rule);
    if (rules.length >= MAX_KEYBINDING_RULES) break;
  }
  return KeybindingsFile.make({ schemaVersion: 1, rules });
};

export const configStoreTestHelpers = {
  coerceSettings,
  userConfigDir: () => resolveUserConfigDir(NodePath.join),
};

/* ────────────────────────── Service implementation ──────────────────────────── */

export const ConfigStoreServiceLive = Layer.effect(
  ConfigStoreService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const { userData } = yield* AppPaths;
    const userConfigDir = resolveUserConfigDir(pathSvc.join);

    yield* fs.makeDirectory(userData, { recursive: true }).pipe(Effect.orDie);
    yield* fs
      .makeDirectory(userConfigDir, { recursive: true })
      .pipe(Effect.orDie);

    const settingsPath = pathSvc.join(userConfigDir, SETTINGS_FILENAME);
    const keybindingsPath = pathSvc.join(userConfigDir, KEYBINDINGS_FILENAME);
    const legacySettingsPath = pathSvc.join(userData, SETTINGS_FILENAME);
    const legacyKeybindingsPath = pathSvc.join(userData, KEYBINDINGS_FILENAME);

    /**
     * Read a JSON file from disk, returning the parsed object or `null` if
     * the file doesn't exist / is malformed. Other I/O failures bubble out.
     */
    const readJsonOrNull = (absPath: string): Effect.Effect<unknown | null> =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(absPath).pipe(Effect.orDie);
        if (!exists) return null;
        const text = yield* fs.readFileString(absPath).pipe(Effect.orDie);
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      });

    // One semaphore per path. Concurrent writes to the same file (e.g. the
    // model-picker firing `defaultProviderId` and `defaultModelByProvider`
    // back-to-back; or migrateLocalStorage racing the first updateSettings)
    // would otherwise both pick the same `<path>.tmp` and the second
    // rename ENOENTs because the first already renamed the tmp away.
    const writeLocks = new Map<string, Semaphore.Semaphore>();
    const lockFor = (absPath: string): Effect.Effect<Semaphore.Semaphore> =>
      Effect.gen(function* () {
        const existing = writeLocks.get(absPath);
        if (existing) return existing;
        const sem = yield* Semaphore.make(1);
        writeLocks.set(absPath, sem);
        return sem;
      });

    /**
     * Atomic write — write the contents to a unique `<absPath>.<rand>.tmp`
     * and rename over the target so a crash during write never leaves a
     * partial file. Serialised per-path so concurrent callers don't race
     * on the tmp filename.
     */
    const writeAtomically = (
      absPath: string,
      contents: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sem = yield* lockFor(absPath);
        yield* sem.withPermits(1)(
          Effect.gen(function* () {
            const tmp = `${absPath}.${randomBytes(6).toString("hex")}.tmp`;
            yield* fs.writeFileString(tmp, contents).pipe(Effect.orDie);
            yield* fs.rename(tmp, absPath).pipe(Effect.orDie);
          }),
        );
      });

    const settingsExists = yield* fs.exists(settingsPath).pipe(Effect.orDie);
    const keybindingsExists = yield* fs
      .exists(keybindingsPath)
      .pipe(Effect.orDie);

    const initialSettingsRaw = settingsExists
      ? yield* readJsonOrNull(settingsPath)
      : yield* readJsonOrNull(legacySettingsPath);
    const initialKeybindingsRaw = keybindingsExists
      ? yield* readJsonOrNull(keybindingsPath)
      : yield* readJsonOrNull(legacyKeybindingsPath);

    const initialSettings = coerceSettings(initialSettingsRaw);
    const initialKeybindings = coerceKeybindings(initialKeybindingsRaw);

    // Persist defaults on first launch so the file is hand-editable
    // immediately. If the user already had a file, leave it alone unless our
    // coerce step rewrote a stale slug — in which case write the cleaned
    // version back so it sticks.
    const initialSettingsSerialized = serialize(initialSettings);
    const initialKeybindingsSerialized = serialize(initialKeybindings);
    if (
      !settingsExists ||
      initialSettingsRaw === null ||
      serialize(initialSettingsRaw) !== initialSettingsSerialized
    ) {
      yield* writeAtomically(settingsPath, initialSettingsSerialized);
    }
    if (!keybindingsExists || initialKeybindingsRaw === null) {
      yield* writeAtomically(keybindingsPath, initialKeybindingsSerialized);
    }

    const settingsRef = yield* Ref.make<SettingsFile>(initialSettings);
    const keybindingsRef = yield* Ref.make<KeybindingsFile>(initialKeybindings);

    // Hubs broadcast to every subscriber (renderer stream consumers, the
    // desktop menu-rebuild hook). Unbounded is fine — payloads are small and
    // change events are rare.
    const settingsHub = yield* PubSub.unbounded<SettingsFile>();
    const keybindingsHub = yield* PubSub.unbounded<KeybindingsFile>();

    /**
     * "Last serialized contents" — used to suppress no-op fs.watch events
     * (we just wrote the same content) and to detect genuine external edits.
     */
    let lastSettingsContent = initialSettingsSerialized;
    let lastKeybindingsContent = initialKeybindingsSerialized;

    const publishSettings = (next: SettingsFile, serialized: string) =>
      Effect.gen(function* () {
        lastSettingsContent = serialized;
        yield* Ref.set(settingsRef, next);
        yield* PubSub.publish(settingsHub, next);
      });

    const publishKeybindings = (next: KeybindingsFile, serialized: string) =>
      Effect.gen(function* () {
        lastKeybindingsContent = serialized;
        yield* Ref.set(keybindingsRef, next);
        yield* PubSub.publish(keybindingsHub, next);
      });

    /* ──────────────── fs.watch — pick up external hand-edits ──────────────── */

    let settingsDebounce: NodeJS.Timeout | null = null;
    let keybindingsDebounce: NodeJS.Timeout | null = null;

    const reReadSettings = (): void => {
      Effect.runFork(
        Effect.gen(function* () {
          const raw = yield* readJsonOrNull(settingsPath);
          if (raw === null) return;
          const serialized = serialize(raw);
          if (serialized === lastSettingsContent) return;
          const next = coerceSettings(raw);
          yield* publishSettings(next, serialize(next));
        }),
      );
    };

    const reReadKeybindings = (): void => {
      Effect.runFork(
        Effect.gen(function* () {
          const raw = yield* readJsonOrNull(keybindingsPath);
          if (raw === null) return;
          const serialized = serialize(raw);
          if (serialized === lastKeybindingsContent) return;
          const next = coerceKeybindings(raw);
          yield* publishKeybindings(next, serialize(next));
        }),
      );
    };

    const watchers: fsSync.FSWatcher[] = [];
    // Watch the user config directory, not the files themselves — atomic
    // rename swaps the inode out from under a per-file watcher and the
    // events stop arriving. Directory-level watch survives that.
    try {
      const w = fsSync.watch(userConfigDir, (_eventType, filename) => {
        if (filename === SETTINGS_FILENAME) {
          if (settingsDebounce !== null) clearTimeout(settingsDebounce);
          settingsDebounce = setTimeout(() => {
            settingsDebounce = null;
            reReadSettings();
          }, WATCH_DEBOUNCE_MS);
        } else if (filename === KEYBINDINGS_FILENAME) {
          if (keybindingsDebounce !== null) clearTimeout(keybindingsDebounce);
          keybindingsDebounce = setTimeout(() => {
            keybindingsDebounce = null;
            reReadKeybindings();
          }, WATCH_DEBOUNCE_MS);
        }
      });
      w.on("error", () => {
        /* watcher dying is best-effort; the in-memory ref stays correct */
      });
      watchers.push(w);
    } catch {
      // Userdata not watchable (sandboxed FS, network mount). The RPC
      // surface still works; only external hand-edits go un-noticed.
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (settingsDebounce !== null) clearTimeout(settingsDebounce);
        if (keybindingsDebounce !== null) clearTimeout(keybindingsDebounce);
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* ignore */
          }
        }
      }),
    );

    /* ────────────────────────── Public API ─────────────────────────────── */

    const getSettings: ConfigStoreServiceShape["getSettings"] = () =>
      Ref.get(settingsRef);

    const updateSettings: ConfigStoreServiceShape["updateSettings"] = (patch) =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(settingsRef);
        const next: SettingsFile = SettingsFile.make({
          schemaVersion: 1,
          defaultProviderId: patch.defaultProviderId ?? cur.defaultProviderId,
          defaultModelByProvider:
            patch.defaultModelByProvider ?? cur.defaultModelByProvider,
          defaultRuntimeMode:
            patch.defaultRuntimeMode ?? cur.defaultRuntimeMode,
          defaultAutoCreateWorktree:
            patch.defaultAutoCreateWorktree ?? cur.defaultAutoCreateWorktree,
          defaultAutonomyLevel:
            patch.defaultAutonomyLevel ?? cur.defaultAutonomyLevel,
          onboardingCompleted:
            patch.onboardingCompleted ?? cur.onboardingCompleted,
          appearanceMode: patch.appearanceMode ?? cur.appearanceMode,
          completionSoundEnabled:
            patch.completionSoundEnabled ?? cur.completionSoundEnabled,
          completionSoundPreset:
            patch.completionSoundPreset ?? cur.completionSoundPreset,
          providerEnabled: patch.providerEnabled ?? cur.providerEnabled,
          modelEnabledByProvider:
            patch.modelEnabledByProvider ?? cur.modelEnabledByProvider,
          opencodeProviderVisible:
            patch.opencodeProviderVisible ?? cur.opencodeProviderVisible,
          opencodeModelVisibleByProvider:
            patch.opencodeModelVisibleByProvider ??
            cur.opencodeModelVisibleByProvider,
          opencodeCustomProviders:
            patch.opencodeCustomProviders ?? cur.opencodeCustomProviders,
          subagents: patch.subagents ?? cur.subagents,
          branchNamingStyle: patch.branchNamingStyle ?? cur.branchNamingStyle,
          branchNamingPrefix:
            patch.branchNamingPrefix ?? cur.branchNamingPrefix,
          mergePrefs: patch.mergePrefs ?? cur.mergePrefs,
          notchTrayEnabled: patch.notchTrayEnabled ?? cur.notchTrayEnabled,
          notchTrayPinned: patch.notchTrayPinned ?? cur.notchTrayPinned,
        });
        const serialized = serialize(next);
        yield* writeAtomically(settingsPath, serialized);
        yield* publishSettings(next, serialized);
        return next;
      });

    const settingsChanges: ConfigStoreServiceShape["settingsChanges"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const sub = yield* PubSub.subscribe(settingsHub);
          const cur = yield* Ref.get(settingsRef);
          return Stream.concat(Stream.make(cur), Stream.fromSubscription(sub));
        }),
      );

    /**
     * Migration is conservative: we only overlay the localStorage values
     * onto the *current* settings if the user hasn't already meaningfully
     * customised the file. The first call after a renderer reload supplies
     * the payload; subsequent calls find onboardingCompleted=true (the
     * common "I've already migrated" tell) or any differing field and
     * leave things alone. This protects against the renderer accidentally
     * shipping a stale localStorage blob after the user has changed
     * settings on disk.
     */
    const migrateLocalStorage: ConfigStoreServiceShape["migrateLocalStorage"] =
      (payload) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(settingsRef);
          const baseline = freshSettings();
          const currentLooksFresh =
            cur.defaultProviderId === baseline.defaultProviderId &&
            cur.defaultRuntimeMode === baseline.defaultRuntimeMode &&
            cur.defaultAutoCreateWorktree ===
              baseline.defaultAutoCreateWorktree &&
            cur.completionSoundEnabled === baseline.completionSoundEnabled &&
            cur.completionSoundPreset === baseline.completionSoundPreset &&
            cur.appearanceMode === baseline.appearanceMode &&
            cur.onboardingCompleted === false &&
            Object.keys(cur.subagents.presets).length === 0 &&
            cur.mergePrefs.method === baseline.mergePrefs.method &&
            cur.mergePrefs.deleteBranch === baseline.mergePrefs.deleteBranch &&
            cur.notchTrayEnabled === baseline.notchTrayEnabled &&
            cur.notchTrayPinned === baseline.notchTrayPinned;
          if (!currentLooksFresh) return cur;

          let provider: SettingsFile["defaultProviderId"] =
            cur.defaultProviderId;
          let models: SettingsFile["defaultModelByProvider"] =
            cur.defaultModelByProvider;
          let runtime: SettingsFile["defaultRuntimeMode"] =
            cur.defaultRuntimeMode;
          let autoWorktree: boolean = cur.defaultAutoCreateWorktree;
          let onboarding: boolean = cur.onboardingCompleted;
          let appearanceMode: SettingsFile["appearanceMode"] =
            cur.appearanceMode;
          let providerEnabled: SettingsFile["providerEnabled"] =
            cur.providerEnabled;
          let modelEnabledByProvider: SettingsFile["modelEnabledByProvider"] =
            cur.modelEnabledByProvider;
          let subagents: SettingsFile["subagents"] = cur.subagents;
          let completionSoundEnabled = cur.completionSoundEnabled;
          let completionSoundPreset = cur.completionSoundPreset;

          if (
            payload.settingsV1Raw !== undefined &&
            payload.settingsV1Raw.length > 0
          ) {
            try {
              const parsed = JSON.parse(payload.settingsV1Raw) as Record<
                string,
                unknown
              >;
              const fromLs = coerceSettings(parsed);
              provider = fromLs.defaultProviderId;
              models = fromLs.defaultModelByProvider;
              runtime = fromLs.defaultRuntimeMode;
              autoWorktree = fromLs.defaultAutoCreateWorktree;
              onboarding = fromLs.onboardingCompleted;
              appearanceMode = fromLs.appearanceMode;
              completionSoundEnabled = fromLs.completionSoundEnabled;
              completionSoundPreset = fromLs.completionSoundPreset;
              providerEnabled = fromLs.providerEnabled;
              modelEnabledByProvider = fromLs.modelEnabledByProvider;
            } catch {
              /* swallow — keep current values */
            }
          }

          if (
            payload.subagentsRaw !== undefined &&
            payload.subagentsRaw.length > 0
          ) {
            try {
              // Zustand persist wraps state as `{state: {...}, version: N}`.
              const wrapper = JSON.parse(payload.subagentsRaw) as {
                readonly state?: Record<string, unknown>;
              };
              const state = wrapper?.state ?? {};
              const fromLs = coerceSettings({ subagents: state });
              subagents = fromLs.subagents;
            } catch {
              /* swallow */
            }
          }

          const merged = SettingsFile.make({
            schemaVersion: 1,
            defaultProviderId: provider,
            defaultModelByProvider: models,
            defaultRuntimeMode: runtime,
            defaultAutoCreateWorktree: autoWorktree,
            // Autonomy has no localStorage predecessor — preserve current.
            defaultAutonomyLevel: cur.defaultAutonomyLevel,
            onboardingCompleted: onboarding,
            appearanceMode,
            completionSoundEnabled,
            completionSoundPreset,
            providerEnabled,
            modelEnabledByProvider,
            opencodeProviderVisible: cur.opencodeProviderVisible,
            opencodeModelVisibleByProvider: cur.opencodeModelVisibleByProvider,
            opencodeCustomProviders: cur.opencodeCustomProviders,
            subagents,
            branchNamingStyle: cur.branchNamingStyle,
            branchNamingPrefix: cur.branchNamingPrefix,
            mergePrefs: cur.mergePrefs,
            notchTrayEnabled: cur.notchTrayEnabled,
            notchTrayPinned: cur.notchTrayPinned,
          });

          const serialized = serialize(merged);
          yield* writeAtomically(settingsPath, serialized);
          yield* publishSettings(merged, serialized);
          return merged;
        });

    const getKeybindings: ConfigStoreServiceShape["getKeybindings"] = () =>
      Ref.get(keybindingsRef);

    const replaceKeybindings: ConfigStoreServiceShape["replaceKeybindings"] = (
      rules,
    ) =>
      Effect.gen(function* () {
        const clamped =
          rules.length > MAX_KEYBINDING_RULES
            ? rules.slice(rules.length - MAX_KEYBINDING_RULES)
            : rules;
        const next = KeybindingsFile.make({
          schemaVersion: 1,
          rules: [...clamped],
        });
        const serialized = serialize(next);
        yield* writeAtomically(keybindingsPath, serialized);
        yield* publishKeybindings(next, serialized);
        return next;
      });

    const keybindingsChanges: ConfigStoreServiceShape["keybindingsChanges"] =
      () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const sub = yield* PubSub.subscribe(keybindingsHub);
            const cur = yield* Ref.get(keybindingsRef);
            return Stream.concat(Stream.make(cur), Stream.fromSubscription(sub));
          }),
        );

    return {
      getSettings,
      updateSettings,
      settingsChanges,
      migrateLocalStorage,
      getKeybindings,
      replaceKeybindings,
      keybindingsChanges,
    } satisfies ConfigStoreServiceShape;
  }),
);
