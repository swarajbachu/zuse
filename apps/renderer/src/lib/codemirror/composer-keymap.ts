import { insertNewlineAndIndent } from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";

import type { Command } from "@zuse/contracts";

import { useKeybindingsStore } from "../../store/keybindings";
import type { ComposerCallbacks } from "./composer.ts";
import { keyToCodeMirrorKey } from "./keybinding-bridge.ts";

/**
 * Build the composer's CodeMirror keymap from the live keybindings store.
 * Rules whose `command` lives in the `composer.*` namespace win over the
 * defaults; rules with malformed keys are skipped (the editor warns about
 * them separately).
 *
 * When the user edits keybindings, the host component reconfigures the
 * composer's keymap compartment with a freshly-built keymap — that's how
 * a rebind takes effect without re-mounting the editor.
 */
export const buildComposerKeymap = (
  callbacks: ComposerCallbacks,
): KeyBinding[] => {
  const rules = useKeybindingsStore.getState().resolvedRules;
  const bindings: KeyBinding[] = [];
  // Walk in declaration order; CodeMirror tries bindings top-down and stops
  // at the first that returns true, so put later (user) overrides first
  // when they share a chord with a default.
  const ordered = [...rules].reverse();
  const seenKeys = new Set<string>();

  for (const r of ordered) {
    const command = r.rule.command as Command;
    if (!command.startsWith("composer.")) continue;
    const key = keyToCodeMirrorKey(r.shortcut);
    if (key === null) continue;
    // Dedupe on key — once the user's binding wins for a chord, drop the
    // default(s) for the same chord so CodeMirror doesn't double-fire.
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const binding = makeComposerBinding(command, key, callbacks);
    if (binding !== null) bindings.push(binding);
  }
  return bindings;
};

const makeComposerBinding = (
  command: Command,
  key: string,
  callbacks: ComposerCallbacks,
): KeyBinding | null => {
  switch (command) {
    case "composer.submit":
      return {
        key,
        preventDefault: true,
        run: () => callbacks.onSubmit(),
      };
    case "composer.newline":
      return { key, run: insertNewlineAndIndent };
    case "composer.forceSubmit":
      return {
        key,
        preventDefault: true,
        run: () => {
          // Force-submit ignores submit guards (popover open, etc.) since
          // users pressing this chord explicitly want to send.
          callbacks.onSubmit();
          return true;
        },
      };
    case "composer.togglePlanMode":
      return {
        key,
        preventDefault: true,
        run: () => {
          const cb = callbacks.onTogglePlanMode;
          if (cb === undefined) return false;
          cb();
          return true;
        },
      };
    default:
      return null;
  }
};

/**
 * Stable export name kept so `composer.ts` doesn't need to change its
 * import shape. Returns the same array `buildComposerKeymap` produces —
 * the legacy fixed list is now built once from the live store at
 * construction; reconfigure on change happens via the compartment in
 * `composer.ts`.
 */
export const composerKeymap = (
  callbacks: ComposerCallbacks,
): readonly KeyBinding[] => buildComposerKeymap(callbacks);
