import { Rpc } from "effect/unstable/rpc";
import { Schema, Struct } from "effect";

import {
  AgentDefinition,
  OpencodeCustomProvider,
  ProviderId,
  RuntimeMode,
} from "./agent.ts";
import { AutonomyLevel } from "./autonomy.ts";
import { GitMergeMethod } from "./git.ts";

/**
 * Per-preset overlay matching the renderer's old localStorage shape. Storing
 * a partial overlay (rather than a full `AgentDefinition`) means a future
 * memoize build can update the seed prompts/models and the user picks them
 * up automatically — only fields they've explicitly customised stick.
 */
export const SubagentPresetState = Schema.Struct({
  enabled: Schema.Boolean,
  overrides: AgentDefinition.mapFields(Struct.map(Schema.optional)),
});
export type SubagentPresetState = typeof SubagentPresetState.Type;

export const CompletionSoundPreset = Schema.Literals([
  "chime",
  "soft",
  "pop",
  "bell",
  "rise",
  "bloom",
]);
export type CompletionSoundPreset = typeof CompletionSoundPreset.Type;

export const AppearanceMode = Schema.Literals(["system", "light", "dark"]);
export type AppearanceMode = typeof AppearanceMode.Type;

/**
 * How the auto-namer (PR: "auto-name chat + branch after first message")
 * shapes a worktree's git branch once it has an LLM-derived title slug.
 *   - `username-slug` → `<git-user>/<slug>` (e.g. `swarajbachu/dark-mode`)
 *   - `slug`          → `<slug>`            (e.g. `dark-mode`)
 *   - `feat-slug`     → `feat/<slug>`       (e.g. `feat/dark-mode`)
 *   - `custom`        → `<branchNamingPrefix>/<slug>` (user-defined prefix)
 * Default is `username-slug`, mirroring the convention most teams use.
 */
export const BranchNamingStyle = Schema.Literals([
  "username-slug",
  "slug",
  "feat-slug",
  "custom",
]);
export type BranchNamingStyle = typeof BranchNamingStyle.Type;

export const MergePrefs = Schema.Struct({
  method: GitMergeMethod,
  deleteBranch: Schema.Boolean,
});
export type MergePrefs = typeof MergePrefs.Type;

/**
 * Wire-shape of `settings.json`. Owned by the main process; rendered to and
 * mutated from the renderer over RPC. The renderer keeps a hot cache in a
 * Zustand store that subscribes to `settings.stream`.
 *
 * Fields here used to live in `localStorage["memoize.settings.v1"]` and
 * `localStorage["memoize.subagents"]`. A one-time migration on first launch
 * after this PR copies the values across (see `apps/desktop/src/config-store.ts`).
 */
export class SettingsFile extends Schema.Class<SettingsFile>("SettingsFile")({
  schemaVersion: Schema.Literal(1),
  defaultProviderId: ProviderId,
  defaultModelByProvider: Schema.Record(ProviderId, Schema.String),
  defaultRuntimeMode: RuntimeMode,
  defaultAutoCreateWorktree: Schema.Boolean,
  /**
   * Legacy autonomy level for new sessions. Current runtimes expose the
   * built-in orchestration tools by default and route mutating calls through
   * the normal permission system; see {@link AutonomyLevel}.
   */
  defaultAutonomyLevel: AutonomyLevel,
  onboardingCompleted: Schema.Boolean,
  appearanceMode: AppearanceMode,
  completionSoundEnabled: Schema.Boolean,
  completionSoundPreset: CompletionSoundPreset,
  /**
   * Per-provider on/off toggle from the Providers settings card. Defaults
   * to `true` for every provider; flipping it to `false` filters the
   * provider from the new-session picker without uninstalling its CLI.
   */
  providerEnabled: Schema.Record(ProviderId, Schema.Boolean),
  /**
   * Per-model visibility toggles from provider settings. Missing entries are
   * filled from each model's catalog `defaultVisible` flag by config-store.
   */
  modelEnabledByProvider: Schema.Record(
    ProviderId,
    Schema.Record(Schema.String, Schema.Boolean),
  ),
  /**
   * OpenCode is a meta-harness fronting ~150 model providers. These four
   * fields drive the in-app OpenCode provider manager. They are keyed by
   * opencode's own *sub-provider* id (e.g. `"openai"`, `"openrouter"`, or a
   * custom slug) — a free-form string, unlike the six-member {@link ProviderId}
   * the maps above use. Credentials are NOT stored here; API keys live in
   * opencode's `auth.json` (written via `agent.opencodeSetProviderAuth`).
   *
   * Which connected sub-providers appear in the model picker. Missing entry ⇒
   * visible (a newly connected provider shows by default).
   */
  opencodeProviderVisible: Schema.Record(Schema.String, Schema.Boolean),
  /** Per-sub-provider model visibility. Missing entry ⇒ visible. */
  opencodeModelVisibleByProvider: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Boolean),
  ),
  /**
   * User-defined OpenAI-compatible providers (no secrets — the API key lives
   * in opencode's `auth.json`). Injected into every `opencode serve` we spawn
   * via `OPENCODE_CONFIG_CONTENT` so both inventory and sessions see them.
   */
  opencodeCustomProviders: Schema.Array(OpencodeCustomProvider),
  /**
   * User MCP servers switched off globally, by descriptor key
   * (`claude:<name>` / `codex:<name>` — see `McpServerDescriptor.key`).
   * Server *definitions* never live here; the user's native Claude/Codex
   * config files are the source of truth and this stores only overrides.
   */
  mcpDisabledServers: Schema.Array(Schema.String),
  subagents: Schema.Struct({
    enableForNewSessions: Schema.Boolean,
    presets: Schema.Record(Schema.String, SubagentPresetState),
  }),
  /**
   * Branch-name shape the auto-namer uses when it renames a new chat's
   * worktree branch from the first message. See {@link BranchNamingStyle}.
   */
  branchNamingStyle: BranchNamingStyle,
  /**
   * User-defined prefix used only when `branchNamingStyle === "custom"`,
   * slash-joined before the slug (e.g. prefix `wip` → `wip/dark-mode`).
   * Empty falls back to a bare slug.
   */
  branchNamingPrefix: Schema.String,
  mergePrefs: MergePrefs,
  /**
   * macOS-only notch tray. The main process only shows it on likely notched
   * MacBook built-in displays; unsupported hardware keeps the preference but
   * renders nothing.
   */
  notchTrayEnabled: Schema.Boolean,
  /** Keep the notch tray expanded instead of only expanding on hover. */
  notchTrayPinned: Schema.Boolean,
}) {}

/**
 * Patch shape for `settings.update`. Every field optional; absent means
 * "leave unchanged". This is intentionally flat — nested patches into
 * `subagents.presets` are common enough that callers send a full
 * `subagents` payload rather than a deep merge.
 */
export const SettingsPatch = Schema.Struct({
  defaultProviderId: Schema.optional(ProviderId),
  defaultModelByProvider: Schema.optional(
    Schema.Record(ProviderId, Schema.String),
  ),
  defaultRuntimeMode: Schema.optional(RuntimeMode),
  defaultAutoCreateWorktree: Schema.optional(Schema.Boolean),
  defaultAutonomyLevel: Schema.optional(AutonomyLevel),
  onboardingCompleted: Schema.optional(Schema.Boolean),
  appearanceMode: Schema.optional(AppearanceMode),
  completionSoundEnabled: Schema.optional(Schema.Boolean),
  completionSoundPreset: Schema.optional(CompletionSoundPreset),
  providerEnabled: Schema.optional(
    Schema.Record(ProviderId, Schema.Boolean),
  ),
  modelEnabledByProvider: Schema.optional(
    Schema.Record(ProviderId, Schema.Record(Schema.String, Schema.Boolean)),
  ),
  opencodeProviderVisible: Schema.optional(
    Schema.Record(Schema.String, Schema.Boolean),
  ),
  opencodeModelVisibleByProvider: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Record(Schema.String, Schema.Boolean),
    ),
  ),
  opencodeCustomProviders: Schema.optional(
    Schema.Array(OpencodeCustomProvider),
  ),
  mcpDisabledServers: Schema.optional(Schema.Array(Schema.String)),
  subagents: Schema.optional(
    Schema.Struct({
      enableForNewSessions: Schema.Boolean,
      presets: Schema.Record(Schema.String, SubagentPresetState),
    }),
  ),
  branchNamingStyle: Schema.optional(BranchNamingStyle),
  branchNamingPrefix: Schema.optional(Schema.String),
  mergePrefs: Schema.optional(MergePrefs),
  notchTrayEnabled: Schema.optional(Schema.Boolean),
  notchTrayPinned: Schema.optional(Schema.Boolean),
});
export type SettingsPatch = typeof SettingsPatch.Type;

export const SettingsGetRpc = Rpc.make("settings.get", {
  success: SettingsFile,
});

export const SettingsUpdateRpc = Rpc.make("settings.update", {
  payload: Schema.Struct({ patch: SettingsPatch }),
  success: SettingsFile,
});

/**
 * Live stream of the settings file. Emits once on subscribe with the
 * current value, then on every change (RPC update or external hand-edit
 * picked up by the file watcher).
 */
export const SettingsStreamRpc = Rpc.make("settings.stream", {
  success: SettingsFile,
  stream: true,
});

/**
 * Renderer → main: ship the contents of any pre-existing localStorage blobs
 * exactly once so the main process can write them into `settings.json` /
 * `keybindings.json`. The main process ignores subsequent calls if a config
 * file already exists on disk. Returns the resolved (possibly merged)
 * settings so the renderer can drop its localStorage immediately.
 *
 * Both payload fields are optional `string` (the raw localStorage value):
 *   - `settingsV1Raw`: the old `memoize.settings.v1` blob
 *   - `subagentsRaw`: the old `memoize.subagents` blob (zustand persist envelope)
 */
export const SettingsMigrateLocalStorageRpc = Rpc.make(
  "settings.migrateLocalStorage",
  {
    payload: Schema.Struct({
      settingsV1Raw: Schema.optional(Schema.String),
      subagentsRaw: Schema.optional(Schema.String),
    }),
    success: SettingsFile,
  },
);
