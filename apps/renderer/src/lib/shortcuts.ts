import { formatKeyForDisplay } from "@zuse/contracts";

import type { MenuAction } from "./bridge";
import { useKeybindingsStore } from "../store/keybindings";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPod|iPad/.test(navigator.userAgent);

/**
 * Tooltip helper: return the formatted key chord currently bound to `id`,
 * or an empty string if the command has no resolvable binding. Synchronous
 * read against the keybindings store — components calling this don't
 * subscribe, so the tooltip refreshes on the next render (good enough for
 * tooltips that mount on hover anyway).
 *
 * Why this lives outside the store: it's a leaf formatter used in JSX
 * `<TooltipShortcut shortcut={…}>`, and React expects a string. Wrapping
 * it in a hook would require every caller to subscribe.
 */
export function formatShortcut(id: MenuAction): string {
  const rules = useKeybindingsStore.getState().resolvedRules;
  // Prefer an unconditional rule (matches menu accelerator semantics).
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r === undefined) continue;
    if (r.rule.command !== id) continue;
    if (r.rule.when !== undefined && r.rule.when.length > 0) continue;
    return formatKeyForDisplay(r.rule.key, IS_MAC);
  }
  return "";
}

