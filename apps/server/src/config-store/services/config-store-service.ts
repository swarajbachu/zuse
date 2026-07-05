import { Context, type Effect, type Stream } from "effect";

import {
  type KeybindingRule,
  type KeybindingsFile,
  type SettingsFile,
  type SettingsPatch,
} from "@zuse/wire";

/**
 * The on-disk source of truth for global settings and user-overridden
 * keybindings. Two user-editable JSON files in `~/.zuse`:
 *
 *   - `settings.json`     — provider/model/runtime mode/auto-worktree/
 *                           onboarding + the sub-agents overlay map.
 *                           Replaces the renderer's old localStorage keys
 *                           `memoize.settings.v1` and `memoize.subagents`.
 *   - `keybindings.json`  — user-overridden keybinding rules only. Defaults
 *                           are baked into the renderer so a new memoize
 *                           build can ship a new default without rewriting
 *                           every user's file.
 *
 * Reads are served from an in-memory cache; writes are atomic (write to a
 * `.tmp` sibling, then rename) and re-published through a PubSub so renderer
 * subscribers (and the desktop process's menu-rebuild hook) react in lockstep.
 * Hand-edits made while the app is running are picked up by `fs.watch` with
 * a small debounce — same UX as VS Code's `keybindings.json`.
 *
 * Legacy files under Electron `app.getPath("userData")` are migrated on first
 * read when the matching `~/.zuse` file does not exist. SQLite and other app
 * state intentionally stay under `userData`.
 */
export interface ConfigStoreServiceShape {
  readonly getSettings: () => Effect.Effect<SettingsFile>;
  readonly updateSettings: (
    patch: SettingsPatch,
  ) => Effect.Effect<SettingsFile>;
  /** Emits the current settings once, then on every change. */
  readonly settingsChanges: () => Stream.Stream<SettingsFile>;
  /**
   * One-shot migration entry-point. Accepts the raw strings the renderer
   * lifted out of localStorage; merges them into the on-disk settings the
   * *first* time only — if the file already has more than a freshly-defaulted
   * shape, the migration is a no-op so multiple renderer reloads can't
   * clobber later changes.
   */
  readonly migrateLocalStorage: (payload: {
    readonly settingsV1Raw?: string;
    readonly subagentsRaw?: string;
  }) => Effect.Effect<SettingsFile>;

  readonly getKeybindings: () => Effect.Effect<KeybindingsFile>;
  readonly replaceKeybindings: (
    rules: ReadonlyArray<KeybindingRule>,
  ) => Effect.Effect<KeybindingsFile>;
  /** Emits the current keybindings once, then on every change. */
  readonly keybindingsChanges: () => Stream.Stream<KeybindingsFile>;
}

export class ConfigStoreService extends Context.Tag(
  "memoize/ConfigStoreService",
)<ConfigStoreService, ConfigStoreServiceShape>() {}
