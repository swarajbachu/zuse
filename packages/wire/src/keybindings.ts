import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

/**
 * Every action the renderer can dispatch via a keybinding or menu click. The
 * literal union is the contract: handlers are wired up in
 * `apps/renderer/src/lib/commands.ts`, and the settings UI iterates over this
 * list to render the editor. Adding a command is an additive change here +
 * a default in `apps/renderer/src/lib/default-keybindings.ts` + a handler.
 *
 *   - `*` commands without a dot are top-level menu actions (also surfaced
 *     as Electron menu accelerators by the main process).
 *   - `composer.*` commands fire inside the chat composer (CodeMirror).
 *   - `editor.*` commands fire inside the file editor (CodeMirror).
 */
export const Command = Schema.Literal(
  // menu / global
  "new-chat",
  "open-project",
  "settings",
  "close-tab",
  "toggle-left-sidebar",
  "toggle-right-sidebar",
  "toggle-terminal",
  "focus-composer",
  // composer (chat input)
  "composer.submit",
  "composer.newline",
  "composer.forceSubmit",
  "composer.togglePlanMode",
  // file editor
  "editor.save",
  "editor.annotate",
);
export type Command = typeof Command.Type;

/**
 * One user-defined keybinding override. `key` is the human-writable form
 * (`"mod+shift+n"`, `"enter"`, `"shift+tab"`); the parser in
 * `keybindings-parse.ts` converts it to a `KeybindingShortcut` for matching.
 * `when` is an optional boolean expression evaluated against the current
 * context (e.g. `"composerFocus && !settingsOpen"`).
 *
 * Rules are stored in order; later rules win over earlier ones on the same
 * key+context — matching the precedence VS Code & t3code use.
 *
 * Declared as a `Schema.Struct` (not `Schema.Class`) on purpose: rules are
 * pure data with no methods, and the renderer constructs plain objects when
 * sending edits over RPC — `Schema.Class` would reject those for not being
 * actual class instances. Matches the `RepositorySettingsPatch` convention.
 */
export const KeybindingRule = Schema.Struct({
  key: Schema.String,
  command: Command,
  when: Schema.optional(Schema.String),
});
export type KeybindingRule = typeof KeybindingRule.Type;

/**
 * Wire-shape of `keybindings.json`. v1 stores only user overrides — the
 * defaults are baked into the renderer (`default-keybindings.ts`) so a new
 * build can change them without rewriting the user's file.
 */
export class KeybindingsFile extends Schema.Class<KeybindingsFile>(
  "KeybindingsFile",
)({
  schemaVersion: Schema.Literal(1),
  rules: Schema.Array(KeybindingRule),
}) {}

/** Safety cap, matching t3code. Truncates oldest if exceeded. */
export const MAX_KEYBINDING_RULES = 256;

export const KeybindingsGetRpc = Rpc.make("keybindings.get", {
  success: KeybindingsFile,
});

export const KeybindingsReplaceRpc = Rpc.make("keybindings.replace", {
  payload: Schema.Struct({ rules: Schema.Array(KeybindingRule) }),
  success: KeybindingsFile,
});

/**
 * Live stream of the merged rules array. Emits once on subscribe with the
 * current file, then re-emits whenever the file changes (RPC write or
 * external hand-edit picked up by the file watcher).
 */
export const KeybindingsStreamRpc = Rpc.make("keybindings.stream", {
  success: KeybindingsFile,
  stream: true,
});
