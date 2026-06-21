import * as fsSync from "node:fs";
import { randomBytes } from "node:crypto";

import { FileSystem, Path } from "@effect/platform";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import {
  type BranchNamingStyle,
  defaultModelFor,
  type KeybindingRule,
  KeybindingsFile,
  MAX_KEYBINDING_RULES,
  type ProviderId,
  resolveModelSlug,
  SettingsFile,
  type CompletionSoundPreset,
  type SettingsPatch,
  type SubagentPresetState,
} from "@memoize/wire";

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

const freshSettings = (): SettingsFile =>
  SettingsFile.make({
    schemaVersion: 1,
    defaultProviderId: "claude",
    defaultModelByProvider: seedModels(),
    defaultRuntimeMode: "approval-required",
    defaultAutoCreateWorktree: false,
    defaultAutonomyLevel: "off",
    onboardingCompleted: false,
    completionSoundEnabled: false,
    completionSoundPreset: "chime",
    providerEnabled: seedProviderEnabled(),
    subagents: { enableForNewSessions: true, presets: {} },
    branchNamingStyle: "username-slug",
    branchNamingPrefix: "",
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
  v === "gemini";

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

const isBranchNamingStyle = (v: unknown): v is BranchNamingStyle =>
  v === "username-slug" || v === "slug" || v === "feat-slug" || v === "custom";

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

  return SettingsFile.make({
    schemaVersion: 1,
    defaultProviderId: provider,
    defaultModelByProvider: models,
    defaultRuntimeMode: runtime,
    defaultAutoCreateWorktree: autoWorktree,
    defaultAutonomyLevel: autonomy,
    onboardingCompleted: onboarding,
    completionSoundEnabled,
    completionSoundPreset,
    providerEnabled,
    subagents,
    branchNamingStyle,
    branchNamingPrefix,
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
    if (typeof r.key !== "string" || typeof r.command !== "string") continue;
    // Keep the original strings; the renderer / matcher revalidates on parse.
    const rule: KeybindingRule = {
      key: r.key,
      command: r.command as KeybindingRule["command"],
      when: typeof r.when === "string" ? r.when : undefined,
    };
    rules.push(rule);
    if (rules.length >= MAX_KEYBINDING_RULES) break;
  }
  return KeybindingsFile.make({ schemaVersion: 1, rules });
};

/* ────────────────────────── Service implementation ──────────────────────────── */

export const ConfigStoreServiceLive = Layer.scoped(
  ConfigStoreService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const { userData } = yield* AppPaths;

    yield* fs.makeDirectory(userData, { recursive: true }).pipe(Effect.orDie);

    const settingsPath = pathSvc.join(userData, SETTINGS_FILENAME);
    const keybindingsPath = pathSvc.join(userData, KEYBINDINGS_FILENAME);

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
    const writeLocks = new Map<string, Effect.Semaphore>();
    const lockFor = (absPath: string): Effect.Effect<Effect.Semaphore> =>
      Effect.gen(function* () {
        const existing = writeLocks.get(absPath);
        if (existing) return existing;
        const sem = yield* Effect.makeSemaphore(1);
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

    const initialSettingsRaw = yield* readJsonOrNull(settingsPath);
    const initialKeybindingsRaw = yield* readJsonOrNull(keybindingsPath);

    const initialSettings = coerceSettings(initialSettingsRaw);
    const initialKeybindings = coerceKeybindings(initialKeybindingsRaw);

    // Persist defaults on first launch so the file is hand-editable
    // immediately. If the user already had a file, leave it alone unless our
    // coerce step rewrote a stale slug — in which case write the cleaned
    // version back so it sticks.
    const initialSettingsSerialized = serialize(initialSettings);
    const initialKeybindingsSerialized = serialize(initialKeybindings);
    if (
      initialSettingsRaw === null ||
      serialize(initialSettingsRaw) !== initialSettingsSerialized
    ) {
      yield* writeAtomically(settingsPath, initialSettingsSerialized);
    }
    if (initialKeybindingsRaw === null) {
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
        yield* settingsHub.publish(next);
      });

    const publishKeybindings = (next: KeybindingsFile, serialized: string) =>
      Effect.gen(function* () {
        lastKeybindingsContent = serialized;
        yield* Ref.set(keybindingsRef, next);
        yield* keybindingsHub.publish(next);
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
    // Watch the userData directory, not the files themselves — atomic
    // rename swaps the inode out from under a per-file watcher and the
    // events stop arriving. Directory-level watch survives that.
    try {
      const w = fsSync.watch(userData, (_eventType, filename) => {
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
          completionSoundEnabled:
            patch.completionSoundEnabled ?? cur.completionSoundEnabled,
          completionSoundPreset:
            patch.completionSoundPreset ?? cur.completionSoundPreset,
          providerEnabled: patch.providerEnabled ?? cur.providerEnabled,
          subagents: patch.subagents ?? cur.subagents,
          branchNamingStyle: patch.branchNamingStyle ?? cur.branchNamingStyle,
          branchNamingPrefix:
            patch.branchNamingPrefix ?? cur.branchNamingPrefix,
        });
        const serialized = serialize(next);
        yield* writeAtomically(settingsPath, serialized);
        yield* publishSettings(next, serialized);
        return next;
      });

    const settingsChanges: ConfigStoreServiceShape["settingsChanges"] = () =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const sub = yield* settingsHub.subscribe;
          const cur = yield* Ref.get(settingsRef);
          return Stream.concat(Stream.make(cur), Stream.fromQueue(sub));
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
            cur.onboardingCompleted === false &&
            Object.keys(cur.subagents.presets).length === 0;
          if (!currentLooksFresh) return cur;

          let provider: SettingsFile["defaultProviderId"] =
            cur.defaultProviderId;
          let models: SettingsFile["defaultModelByProvider"] =
            cur.defaultModelByProvider;
          let runtime: SettingsFile["defaultRuntimeMode"] =
            cur.defaultRuntimeMode;
          let autoWorktree: boolean = cur.defaultAutoCreateWorktree;
          let onboarding: boolean = cur.onboardingCompleted;
          let providerEnabled: SettingsFile["providerEnabled"] =
            cur.providerEnabled;
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
              completionSoundEnabled = fromLs.completionSoundEnabled;
              completionSoundPreset = fromLs.completionSoundPreset;
              providerEnabled = fromLs.providerEnabled;
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
            completionSoundEnabled,
            completionSoundPreset,
            providerEnabled,
            subagents,
            branchNamingStyle: cur.branchNamingStyle,
            branchNamingPrefix: cur.branchNamingPrefix,
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
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const sub = yield* keybindingsHub.subscribe;
            const cur = yield* Ref.get(keybindingsRef);
            return Stream.concat(Stream.make(cur), Stream.fromQueue(sub));
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
