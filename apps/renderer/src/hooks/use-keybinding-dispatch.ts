import { useEffect } from "react";

import {
  type Command,
  evaluateWhen,
  matchesShortcut,
  normalizeEventKey,
} from "@zuse/wire";

import { APPLICATION_COMMANDS, dispatchCommand } from "../lib/commands";
import { useKeybindingsStore } from "../store/keybindings";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPod|iPad/.test(navigator.userAgent);

/**
 * Document-level keybinding dispatcher. Walks the live keybindings store
 * last-first on every keydown and fires the matched application command.
 * Composer / editor commands are NOT dispatched here — those live inside
 * the corresponding CodeMirror keymaps so they only fire when the user is
 * actually focused in that surface.
 *
 * The dispatcher still consults a rule's `when` AST if one is present
 * (hand-edits to `keybindings.json` can add them), but the settings UI no
 * longer exposes a builder — defaults never carry a when-clause, so for
 * the typical user the evaluator is a no-op and every matching binding
 * just fires unconditionally.
 */
export function useKeybindingDispatch(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const base = normalizeEventKey(event.key);
      if (base === "shift" || base === "ctrl" || base === "meta" || base === "alt") {
        return;
      }

      const rules = useKeybindingsStore.getState().resolvedRules;

      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (r === undefined) continue;
        const command: Command = r.rule.command;
        if (!APPLICATION_COMMANDS.has(command)) continue;
        if (!matchesShortcut(event, r.shortcut, IS_MAC)) continue;
        // Hand-edited when-clauses evaluate against an empty context — any
        // identifier resolves to false, so a rule like `when: composerFocus`
        // simply won't fire from here. (composer/editor commands are
        // excluded above and handled inside their CodeMirror keymap, where
        // focus is implicit.)
        if (r.whenAst !== null && !evaluateWhen(r.whenAst, {})) continue;

        event.preventDefault();
        event.stopPropagation();
        dispatchCommand(command);
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
