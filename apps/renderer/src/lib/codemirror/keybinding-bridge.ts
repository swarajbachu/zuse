import type { KeybindingShortcut } from "@zuse/contracts";

/**
 * Convert a parsed `KeybindingShortcut` into the CodeMirror keymap `key`
 * string format. CodeMirror uses dash-joined tokens (`"Mod-Enter"`,
 * `"Shift-Tab"`); modifiers come before the base key. We emit `Mod-` for
 * the platform-agnostic mod modifier — CodeMirror resolves it to ⌘ on
 * macOS and Ctrl elsewhere, same convention as our `mod` token.
 *
 * Returns `null` if the base key is something CodeMirror can't represent
 * (e.g. an Electron-only function key); the editor warns about it.
 */
export function keyToCodeMirrorKey(
  shortcut: KeybindingShortcut,
): string | null {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("Mod");
  if (shortcut.metaKey) parts.push("Cmd");
  if (shortcut.ctrlKey) parts.push("Ctrl");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  const base = baseKeyForCodeMirror(shortcut.key);
  if (base === null) return null;
  parts.push(base);
  return parts.join("-");
}

function baseKeyForCodeMirror(key: string): string | null {
  if (key.length === 1) {
    return /[a-z]/.test(key) ? key : key;
  }
  switch (key) {
    case " ":
      return "Space";
    case "enter":
      return "Enter";
    case "tab":
      return "Tab";
    case "backspace":
      return "Backspace";
    case "delete":
      return "Delete";
    case "escape":
      return "Escape";
    case "up":
      return "ArrowUp";
    case "down":
      return "ArrowDown";
    case "left":
      return "ArrowLeft";
    case "right":
      return "ArrowRight";
    case "home":
      return "Home";
    case "end":
      return "End";
    case "pageup":
      return "PageUp";
    case "pagedown":
      return "PageDown";
    default:
      return null;
  }
}
