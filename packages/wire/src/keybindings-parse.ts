/**
 * Pure parsing + evaluation for keybindings. No platform/IO imports — safe to
 * run in main, renderer, or a worker.
 */

/* ────────────────────────── Key tokens ──────────────────────────────── */

/**
 * Parsed binary form of a `KeybindingRule.key` string. `modKey` is the
 * platform-agnostic mod (⌘ on macOS, Ctrl elsewhere); `metaKey` and `ctrlKey`
 * are the literal forms (`"meta+n"`, `"ctrl+n"`) for users who want to target
 * a specific physical modifier regardless of platform.
 */
export interface KeybindingShortcut {
  readonly key: string;
  readonly modKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const MODIFIER_TOKENS = new Set([
  "mod",
  "cmd",
  "meta",
  "command",
  "ctrl",
  "control",
  "alt",
  "option",
  "opt",
  "shift",
]);

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  ins: "insert",
  del: "delete",
  pgup: "pageup",
  pgdn: "pagedown",
  pagedn: "pagedown",
  spc: "space",
  space: " ",
  plus: "+",
};

/** Lower-case a token and resolve aliases. */
export function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * Parse a key string like `"mod+shift+n"` into its components. Returns
 * `null` on any kind of malformed input — empty pieces, unknown bare key,
 * modifier-only (`"shift"` alone). The settings UI uses the null return to
 * mark a row as invalid.
 */
export function parseKey(input: string): KeybindingShortcut | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // `+` as the bare key is allowed but its splitter is also `+`; preserve a
  // trailing `+` as the literal key by splitting on the *internal* `+` only.
  // Walk char-by-char: every `+` that's not the last char is a separator.
  const tokens: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "+" && i > 0 && i < trimmed.length - 1) {
      tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  tokens.push(current);

  let modKey = false;
  let metaKey = false;
  let ctrlKey = false;
  let altKey = false;
  let shiftKey = false;
  let baseKey: string | null = null;

  for (const raw of tokens) {
    const tok = normalizeKey(raw);
    if (tok.length === 0) return null;
    if (MODIFIER_TOKENS.has(tok)) {
      switch (tok) {
        case "mod":
          modKey = true;
          break;
        case "cmd":
        case "meta":
        case "command":
          metaKey = true;
          break;
        case "ctrl":
        case "control":
          ctrlKey = true;
          break;
        case "alt":
        case "option":
        case "opt":
          altKey = true;
          break;
        case "shift":
          shiftKey = true;
          break;
      }
      continue;
    }
    if (baseKey !== null) {
      // Two non-modifier tokens — not supported in v1.
      return null;
    }
    baseKey = tok;
  }

  if (baseKey === null) return null;
  return { key: baseKey, modKey, metaKey, ctrlKey, altKey, shiftKey };
}

/* ────────────────────────── Event matching ──────────────────────────── */

export interface KeyEventLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Does this keyboard event satisfy `shortcut`? `isMac` resolves the `mod`
 * abstraction — passing it in (rather than reading `navigator`) keeps this
 * function pure and unit-testable.
 *
 * Match rule:
 *   - Modifiers that the shortcut requires must be pressed.
 *   - Modifiers that the shortcut does NOT require must not be pressed —
 *     otherwise `Cmd+N` and `Cmd+Shift+N` would both fire on `Cmd+Shift+N`.
 *   - The base key matches case-insensitively against `event.key`. We
 *     also match common aliases (Space → " ", arrow names, etc.).
 */
export function matchesShortcut(
  event: KeyEventLike,
  shortcut: KeybindingShortcut,
  isMac: boolean,
): boolean {
  // Resolve `mod` to the platform's physical modifier.
  const wantMeta = shortcut.metaKey || (shortcut.modKey && isMac);
  const wantCtrl = shortcut.ctrlKey || (shortcut.modKey && !isMac);

  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== shortcut.altKey) return false;
  if (event.shiftKey !== shortcut.shiftKey) return false;

  return normalizeEventKey(event.key) === shortcut.key;
}

/** Map DOM `KeyboardEvent.key` values onto the same vocabulary as `parseKey`. */
export function normalizeEventKey(key: string): string {
  if (key.length === 1) {
    // Single-char keys: lower-case for letters; preserve punctuation as-is.
    return key.toLowerCase();
  }
  const lower = key.toLowerCase();
  switch (lower) {
    case "arrowup":
      return "up";
    case "arrowdown":
      return "down";
    case "arrowleft":
      return "left";
    case "arrowright":
      return "right";
    case "control":
      return "ctrl";
    case "meta":
    case "os":
      return "meta";
    case "altgraph":
      return "alt";
    default:
      return lower;
  }
}

/**
 * Inverse of `parseKey` — turn a DOM keydown event into the canonical
 * `"mod+shift+n"` form used in `KeybindingRule.key`. Returns `null` when
 * the event has no usable base key (e.g. user pressed Shift alone).
 *
 * On macOS we emit `mod` for Cmd; elsewhere `mod` for Ctrl. That matches the
 * way users naturally write a cross-platform shortcut.
 */
export function keyStringFromEvent(
  event: KeyEventLike,
  isMac: boolean,
): string | null {
  const base = normalizeEventKey(event.key);
  // Reject events that are just a modifier press.
  if (
    base === "shift" ||
    base === "ctrl" ||
    base === "meta" ||
    base === "alt" ||
    base === ""
  ) {
    return null;
  }

  const parts: string[] = [];
  // Emit `mod` when the platform's mod modifier is held; emit the literal
  // form for the *other* physical modifier when the user crossed platforms
  // (e.g. holding Ctrl on macOS).
  if (isMac) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(base);
  return parts.join("+");
}

/* ────────────────────────── When-clause AST ─────────────────────────── */

export type KeybindingWhenNode =
  | { readonly type: "identifier"; readonly name: string }
  | { readonly type: "not"; readonly node: KeybindingWhenNode }
  | {
      readonly type: "and";
      readonly left: KeybindingWhenNode;
      readonly right: KeybindingWhenNode;
    }
  | {
      readonly type: "or";
      readonly left: KeybindingWhenNode;
      readonly right: KeybindingWhenNode;
    };

export interface WhenParseError {
  readonly message: string;
  readonly position: number;
}

const MAX_WHEN_DEPTH = 64;

/**
 * Recursive descent parser. Precedence: `!` > `&&` > `||`. Identifiers must
 * match `[A-Za-z_][A-Za-z0-9_]*`. Empty input parses to `null` (treated as
 * "no when clause"). Returns `WhenParseError` on syntax errors so the
 * settings UI can show a precise message.
 */
export function parseWhen(
  input: string,
): KeybindingWhenNode | null | WhenParseError {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let pos = 0;

  const peek = (): string => trimmed[pos] ?? "";
  const eof = () => pos >= trimmed.length;
  const skipWs = () => {
    while (!eof() && /\s/.test(peek())) pos++;
  };

  const fail = (message: string): WhenParseError => ({ message, position: pos });

  const parseIdentifier = (): KeybindingWhenNode | WhenParseError => {
    const start = pos;
    while (!eof() && /[A-Za-z0-9_]/.test(peek())) pos++;
    if (start === pos) return fail("expected identifier");
    return { type: "identifier", name: trimmed.slice(start, pos) };
  };

  const parseAtom = (
    depth: number,
  ): KeybindingWhenNode | WhenParseError => {
    if (depth > MAX_WHEN_DEPTH) return fail("expression nested too deep");
    skipWs();
    if (eof()) return fail("unexpected end of input");
    const ch = peek();
    if (ch === "!") {
      pos++;
      const inner = parseAtom(depth + 1);
      if ("type" in inner) return { type: "not", node: inner };
      return inner;
    }
    if (ch === "(") {
      pos++;
      const inner = parseOr(depth + 1);
      if (!("type" in inner)) return inner;
      skipWs();
      if (peek() !== ")") return fail("expected ')'");
      pos++;
      return inner;
    }
    if (/[A-Za-z_]/.test(ch)) return parseIdentifier();
    return fail(`unexpected character '${ch}'`);
  };

  const parseAnd = (
    depth: number,
  ): KeybindingWhenNode | WhenParseError => {
    let left = parseAtom(depth);
    if (!("type" in left)) return left;
    while (true) {
      skipWs();
      if (eof()) return left;
      if (trimmed.startsWith("&&", pos)) {
        pos += 2;
        const right = parseAtom(depth + 1);
        if (!("type" in right)) return right;
        left = { type: "and", left, right };
      } else {
        return left;
      }
    }
  };

  const parseOr = (
    depth: number,
  ): KeybindingWhenNode | WhenParseError => {
    let left = parseAnd(depth);
    if (!("type" in left)) return left;
    while (true) {
      skipWs();
      if (eof()) return left;
      if (trimmed.startsWith("||", pos)) {
        pos += 2;
        const right = parseAnd(depth + 1);
        if (!("type" in right)) return right;
        left = { type: "or", left, right };
      } else {
        return left;
      }
    }
  };

  const result = parseOr(0);
  if (!("type" in result)) return result;
  skipWs();
  if (!eof()) return fail("unexpected trailing input");
  return result;
}

/** Boolean-eval a parsed when-clause against a context map. Unknown ids → false. */
export function evaluateWhen(
  node: KeybindingWhenNode | null | undefined,
  context: Readonly<Record<string, boolean>>,
): boolean {
  if (!node) return true;
  switch (node.type) {
    case "identifier":
      return context[node.name] === true;
    case "not":
      return !evaluateWhen(node.node, context);
    case "and":
      return (
        evaluateWhen(node.left, context) && evaluateWhen(node.right, context)
      );
    case "or":
      return (
        evaluateWhen(node.left, context) || evaluateWhen(node.right, context)
      );
  }
}

/** Collect identifier names referenced by the AST — used to warn about typos. */
export function collectWhenIdentifiers(
  node: KeybindingWhenNode | null | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  const walk = (n: KeybindingWhenNode) => {
    switch (n.type) {
      case "identifier":
        out.add(n.name);
        return;
      case "not":
        walk(n.node);
        return;
      case "and":
      case "or":
        walk(n.left);
        walk(n.right);
        return;
    }
  };
  if (node) walk(node);
  return out;
}

/**
 * Inverse of `parseWhen` — render a `KeybindingWhenNode` AST back to the
 * canonical text form. Parens are inserted only where needed for clarity
 * given precedence (`!` > `&&` > `||`); the result re-parses back into an
 * equivalent AST so the visual builder and text input stay in sync.
 */
export function whenAstToString(
  node: KeybindingWhenNode | null | undefined,
): string {
  if (!node) return "";
  return renderNode(node, 0);
}

const PRECEDENCE: Record<KeybindingWhenNode["type"], number> = {
  identifier: 3,
  not: 2,
  and: 1,
  or: 0,
};

function renderNode(node: KeybindingWhenNode, parentPrecedence: number): string {
  const own = PRECEDENCE[node.type];
  let text: string;
  switch (node.type) {
    case "identifier":
      text = node.name;
      break;
    case "not":
      text = `!${renderNode(node.node, PRECEDENCE.not)}`;
      break;
    case "and":
      text = `${renderNode(node.left, PRECEDENCE.and)} && ${renderNode(node.right, PRECEDENCE.and)}`;
      break;
    case "or":
      text = `${renderNode(node.left, PRECEDENCE.or)} || ${renderNode(node.right, PRECEDENCE.or)}`;
      break;
  }
  return own < parentPrecedence ? `(${text})` : text;
}

/* ────────────────────────── Display formatting ──────────────────────── */

/**
 * Format a key string for on-screen display. Mirrors `formatAccelerator` in
 * `apps/renderer/src/lib/shortcuts.ts`, but operates on the new `mod+...`
 * vocabulary instead of Electron's `CmdOrCtrl+...` accelerator strings.
 *
 * The thin space (` `) on macOS gives a hair of breathing room between
 * the modifier glyph (⌘) and the letter (N) so they don't run together.
 */
export function formatKeyForDisplay(key: string, isMac: boolean): string {
  const parsed = parseKey(key);
  if (parsed === null) return key;
  const parts: string[] = [];
  if (parsed.modKey) parts.push(isMac ? "⌘" : "Ctrl");
  if (parsed.metaKey) parts.push(isMac ? "⌘" : "Win");
  if (parsed.ctrlKey) parts.push(isMac ? "⌃" : "Ctrl");
  if (parsed.altKey) parts.push(isMac ? "⌥" : "Alt");
  if (parsed.shiftKey) parts.push(isMac ? "⇧" : "Shift");
  parts.push(formatBaseKeyForDisplay(parsed.key));
  return parts.join(isMac ? " " : "+");
}

function formatBaseKeyForDisplay(key: string): string {
  switch (key) {
    case " ":
      return "Space";
    case "enter":
      return "↵";
    case "tab":
      return "⇥";
    case "backspace":
      return "⌫";
    case "delete":
      return "⌦";
    case "escape":
      return "Esc";
    case "up":
      return "↑";
    case "down":
      return "↓";
    case "left":
      return "←";
    case "right":
      return "→";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * Translate a `KeybindingRule.key` to an Electron `accelerator` string used
 * by `MenuItem.accelerator`. Returns `null` when the binding has no
 * representable accelerator (e.g. the base key is unsupported by Electron).
 *
 * Electron uses `CmdOrCtrl` for the platform mod, separate `Cmd`/`Ctrl`
 * literals, and `Plus`/`Space`/`Tab`/etc. for special keys. See
 * https://www.electronjs.org/docs/latest/api/accelerator
 */
export function keyToElectronAccelerator(key: string): string | null {
  const parsed = parseKey(key);
  if (parsed === null) return null;
  const parts: string[] = [];
  if (parsed.modKey) parts.push("CmdOrCtrl");
  if (parsed.metaKey) parts.push("Cmd");
  if (parsed.ctrlKey) parts.push("Ctrl");
  if (parsed.altKey) parts.push("Alt");
  if (parsed.shiftKey) parts.push("Shift");
  const base = keyToElectronBase(parsed.key);
  if (base === null) return null;
  parts.push(base);
  return parts.join("+");
}

function keyToElectronBase(key: string): string | null {
  if (key.length === 1) {
    // Letters/digits → uppercase for letters, themselves for everything else.
    return /[a-z]/.test(key) ? key.toUpperCase() : key;
  }
  switch (key) {
    case " ":
      return "Space";
    case "enter":
      return "Return";
    case "tab":
      return "Tab";
    case "backspace":
      return "Backspace";
    case "delete":
      return "Delete";
    case "escape":
      return "Escape";
    case "up":
      return "Up";
    case "down":
      return "Down";
    case "left":
      return "Left";
    case "right":
      return "Right";
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
