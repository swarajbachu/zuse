import type { Command, KeybindingRule } from "@zuse/contracts";

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
  "next-tab": {
    label: "Next tab",
    description: "Switch to the next tab in the active chat",
    group: "Navigation",
  },
  "prev-tab": {
    label: "Previous tab",
    description: "Switch to the previous tab in the active chat",
    group: "Navigation",
  },
  "select-tab-1": {
    label: "Go to tab 1",
    description: "Jump to the first tab",
    group: "Navigation",
  },
  "select-tab-2": {
    label: "Go to tab 2",
    description: "Jump to the second tab",
    group: "Navigation",
  },
  "select-tab-3": {
    label: "Go to tab 3",
    description: "Jump to the third tab",
    group: "Navigation",
  },
  "select-tab-4": {
    label: "Go to tab 4",
    description: "Jump to the fourth tab",
    group: "Navigation",
  },
  "select-tab-5": {
    label: "Go to tab 5",
    description: "Jump to the fifth tab",
    group: "Navigation",
  },
  "select-tab-6": {
    label: "Go to tab 6",
    description: "Jump to the sixth tab",
    group: "Navigation",
  },
  "select-tab-7": {
    label: "Go to tab 7",
    description: "Jump to the seventh tab",
    group: "Navigation",
  },
  "select-tab-8": {
    label: "Go to tab 8",
    description: "Jump to the eighth tab",
    group: "Navigation",
  },
  "select-last-tab": {
    label: "Go to last tab",
    description: "Jump to the last tab in the active chat",
    group: "Navigation",
  },
  "new-tab": {
    label: "New tab",
    description: "Open a new session in the active chat",
    group: "Navigation",
  },
  "next-chat": {
    label: "Next chat",
    description: "Switch to the next chat in the sidebar",
    group: "Navigation",
  },
  "prev-chat": {
    label: "Previous chat",
    description: "Switch to the previous chat in the sidebar",
    group: "Navigation",
  },
  "next-panel": {
    label: "Next panel",
    description: "Switch to the next panel in the right pane",
    group: "Navigation",
  },
  "prev-panel": {
    label: "Previous panel",
    description: "Switch to the previous panel in the right pane",
    group: "Navigation",
  },
  "focus-next-pane": {
    label: "Focus next pane",
    description:
      "Move keyboard focus to the next region (sidebar → chat → composer → right pane)",
    group: "Navigation",
  },
  "focus-prev-pane": {
    label: "Focus previous pane",
    description: "Move keyboard focus to the previous region",
    group: "Navigation",
  },
  "open-chat-switcher": {
    label: "Switch chat…",
    description: "Open the quick-switcher to jump to any chat in any project",
    group: "Navigation",
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
    description:
      "Pin a comment on the selected code and add it to the composer",
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
 * `packages/contracts/src/keybindings-parse.ts` for the AST.
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
  // Navigation — terminal/browser-familiar tab & chat switching, all rebindable.
  { key: "mod+shift+]", command: "next-tab" },
  { key: "mod+shift+[", command: "prev-tab" },
  { key: "mod+1", command: "select-tab-1" },
  { key: "mod+2", command: "select-tab-2" },
  { key: "mod+3", command: "select-tab-3" },
  { key: "mod+4", command: "select-tab-4" },
  { key: "mod+5", command: "select-tab-5" },
  { key: "mod+6", command: "select-tab-6" },
  { key: "mod+7", command: "select-tab-7" },
  { key: "mod+8", command: "select-tab-8" },
  { key: "mod+9", command: "select-last-tab" },
  { key: "mod+t", command: "new-tab" },
  { key: "ctrl+tab", command: "next-chat" },
  { key: "ctrl+shift+tab", command: "prev-chat" },
  { key: "mod+alt+]", command: "next-panel" },
  { key: "mod+alt+[", command: "prev-panel" },
  { key: "ctrl+`", command: "focus-next-pane" },
  { key: "ctrl+shift+`", command: "focus-prev-pane" },
  { key: "mod+k", command: "open-chat-switcher" },
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
