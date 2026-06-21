import type { Command, KeybindingRule } from "@memoize/wire";

/**
 * Display metadata for each command. The label is shown in the settings
 * editor and any tooltips; `group` is the section header in the editor;
 * `description` is the sub-line under the label. Keep one entry per
 * member of the `Command` union — TypeScript enforces exhaustiveness.
 */
export interface CommandMeta {
  readonly label: string;
  readonly description: string;
  readonly group: string;
}

export const COMMAND_META: Record<Command, CommandMeta> = {
  "new-chat": {
    label: "New chat",
    description: "Start a new session in the selected project",
    group: "Application",
  },
  "open-project": {
    label: "Open project…",
    description: "Pick a folder to add to the workspace",
    group: "Application",
  },
  settings: {
    label: "Settings",
    description: "Open or close the settings page",
    group: "Application",
  },
  "close-tab": {
    label: "Close tab",
    description: "Close the active chat tab",
    group: "Application",
  },
  "toggle-left-sidebar": {
    label: "Toggle projects panel",
    description: "Show or hide the left projects sidebar",
    group: "Application",
  },
  "toggle-right-sidebar": {
    label: "Toggle files panel",
    description: "Show or hide the right files sidebar",
    group: "Application",
  },
  "toggle-terminal": {
    label: "Toggle terminal",
    description: "Open the right pane and switch to the terminal tab",
    group: "Application",
  },
  "focus-composer": {
    label: "Focus composer",
    description: "Move the cursor into the chat input",
    group: "Application",
  },
  "composer.submit": {
    label: "Submit message",
    description: "Send the current composer contents",
    group: "Composer",
  },
  "composer.newline": {
    label: "Insert newline",
    description: "Add a line break instead of submitting",
    group: "Composer",
  },
  "composer.forceSubmit": {
    label: "Force submit",
    description: "Submit regardless of mention/skill popover state",
    group: "Composer",
  },
  "composer.togglePlanMode": {
    label: "Toggle plan mode",
    description: "Switch between normal and plan-mode composer",
    group: "Composer",
  },
  "editor.save": {
    label: "Save file",
    description: "Write the open file to disk",
    group: "Editor",
  },
  "editor.annotate": {
    label: "Annotate selection",
    description: "Pin a comment on the selected code and add it to the composer",
    group: "Editor",
  },
};

export const COMMANDS_IN_ORDER: ReadonlyArray<Command> = Object.keys(
  COMMAND_META,
) as Command[];

/**
 * Default rules merged on top of (or under) the user's `keybindings.json`
 * overrides. The matcher walks rules last-first so a user rule with the
 * same `command` shadows the default; otherwise the default still applies
 * (multiple keys → same command is fine).
 *
 * Scoping is structural rather than expression-based:
 *   - `composer.*` bindings only live inside the composer's CodeMirror
 *     keymap (built in `composer-keymap.ts`).
 *   - `editor.*` bindings only live inside the file editor's keymap
 *     (built in `setup.ts`).
 *   - Everything else is global, dispatched by `useKeybindingDispatch`.
 *
 * The wire type still carries an optional `when` field for power users
 * who hand-edit `keybindings.json` — the dispatcher's evaluator is wired
 * up but the settings UI no longer exposes a builder. See
 * `packages/wire/src/keybindings-parse.ts` for the AST.
 */
export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+n", command: "new-chat" },
  { key: "mod+o", command: "open-project" },
  { key: "mod+,", command: "settings" },
  { key: "mod+w", command: "close-tab" },
  { key: "mod+b", command: "toggle-left-sidebar" },
  { key: "mod+alt+b", command: "toggle-right-sidebar" },
  { key: "mod+j", command: "toggle-terminal" },
  { key: "mod+l", command: "focus-composer" },
  { key: "enter", command: "composer.submit" },
  { key: "shift+enter", command: "composer.newline" },
  { key: "mod+enter", command: "composer.forceSubmit" },
  { key: "shift+tab", command: "composer.togglePlanMode" },
  { key: "mod+s", command: "editor.save" },
  { key: "mod+shift+a", command: "editor.annotate" },
];

/**
 * Merge user overrides on top of defaults. User rules win when they share
 * the same `command`. Other defaults stay — so a user can add a *new*
 * binding for an action without losing the existing one.
 */
export function mergeWithDefaults(
  userRules: ReadonlyArray<KeybindingRule>,
): ReadonlyArray<KeybindingRule> {
  const out: KeybindingRule[] = [];
  const overriddenCommands = new Set(userRules.map((r) => r.command));
  for (const def of DEFAULT_KEYBINDINGS) {
    if (!overriddenCommands.has(def.command)) out.push(def);
  }
  out.push(...userRules);
  return out;
}
