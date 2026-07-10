import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import {
  type Command,
  keyToElectronAccelerator,
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MAX_KEYBINDING_RULES,
  parseKey,
  parseWhen,
} from "@zuse/contracts";

import { mergeWithDefaults } from "../lib/default-keybindings";
import { getRpcClient } from "../lib/rpc-client";

/**
 * A keybinding rule augmented with its parsed binary form. Building this
 * once at load (and on every change) keeps the keydown dispatcher's hot
 * path free of parsing work.
 */
export interface ResolvedRule {
  readonly rule: KeybindingRule;
  /** `null` when the rule's key string is malformed — surfaced as a warning in the editor. */
  readonly shortcut: KeybindingShortcut;
  /** `null` when the rule has no `when` clause or it failed to parse. */
  readonly whenAst: KeybindingWhenNode | null;
  /** `true` when the rule came from `default-keybindings.ts` rather than the user's file. */
  readonly isDefault: boolean;
}

interface KeybindingsState {
  /** All resolved rules — defaults overlaid with user overrides. */
  readonly resolvedRules: ReadonlyArray<ResolvedRule>;
  /** User-only rules — what the editor lets the user mutate. */
  readonly userRules: ReadonlyArray<KeybindingRule>;
  /** Set to true once we've hydrated from the RPC at least once. */
  readonly loaded: boolean;
  /** RPC-error surface for the editor toast. */
  readonly error: string | null;
  readonly hydrate: () => Promise<void>;
  readonly setUserRules: (
    rules: ReadonlyArray<KeybindingRule>,
  ) => Promise<void>;
  readonly resetAll: () => Promise<void>;
  /** Reset every user override that targets `command`. */
  readonly resetCommand: (command: Command) => Promise<void>;
  /** Add a new user rule at the end of the list. */
  readonly addRule: (rule: KeybindingRule) => Promise<void>;
  /** Replace user rule at index. Indices count over `userRules`. */
  readonly replaceUserRuleAt: (
    index: number,
    rule: KeybindingRule,
  ) => Promise<void>;
  /** Remove the user rule at index. */
  readonly removeUserRuleAt: (index: number) => Promise<void>;
}

const formatError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    return String((err as { _tag: unknown })._tag);
  }
  return String(err);
};

const resolveRules = (
  userRules: ReadonlyArray<KeybindingRule>,
): {
  readonly resolved: ReadonlyArray<ResolvedRule>;
  readonly userRules: ReadonlyArray<KeybindingRule>;
} => {
  const merged = mergeWithDefaults(userRules);
  const resolved: ResolvedRule[] = [];
  for (const rule of merged) {
    const shortcut = parseKey(rule.key);
    if (shortcut === null) continue; // malformed — drop silently; editor warns
    let whenAst: KeybindingWhenNode | null = null;
    if (rule.when !== undefined && rule.when.length > 0) {
      const parsed = parseWhen(rule.when);
      // parseWhen returns `KeybindingWhenNode | null | WhenParseError`. We
      // care only about the node case; null (no clause) and error (bad
      // syntax) both fall through to `whenAst = null`, which the dispatcher
      // treats as "fire unconditionally" — so a typo in the when input can't
      // permanently lock the user out of the binding.
      if (parsed !== null && "type" in parsed) {
        whenAst = parsed;
      }
    }
    const isDefault = !userRules.includes(rule);
    resolved.push({ rule, shortcut, whenAst, isDefault });
  }
  return { resolved, userRules };
};

/**
 * Resolve the current ruleset to the `MenuAccelerators` map the main
 * process wants — one accelerator per menu command, or `null` if every
 * matching rule is malformed / has a when-clause (menus can't represent
 * conditional bindings, so those stay out of the accelerator).
 */
const computeMenuAccelerators = (
  resolved: ReadonlyArray<ResolvedRule>,
): Readonly<Record<string, string | null>> => {
  const menuCommands: ReadonlyArray<Command> = [
    "new-chat",
    "open-project",
    "settings",
    "close-tab",
    "toggle-left-sidebar",
    "toggle-right-sidebar",
    "toggle-terminal",
    "focus-composer",
  ];
  const out: Record<string, string | null> = {};
  for (const cmd of menuCommands) {
    // Pick the *last* unconditional rule for the command (user > default;
    // unconditional only, since menus can't gate on focus context).
    let chosen: string | null = null;
    for (let i = resolved.length - 1; i >= 0; i--) {
      const r = resolved[i];
      if (r === undefined) continue;
      if (r.rule.command !== cmd) continue;
      if (r.rule.when !== undefined && r.rule.when.length > 0) continue;
      chosen = keyToElectronAccelerator(r.rule.key);
      break;
    }
    out[cmd] = chosen;
  }
  return out;
};

let streamFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;

const stopStream = async (): Promise<void> => {
  if (streamFiber !== null) {
    const f = streamFiber;
    streamFiber = null;
    await Effect.runPromise(Fiber.interrupt(f));
  }
};

/**
 * Push the resolved accelerator map up to the native menu. No-op outside
 * Electron. We dedupe by serialising — repeated identical writes (from
 * stream re-emits triggered by our own file write) are cheap.
 */
let lastAccelJson = "";
const pushMenuAccelerators = (resolved: ReadonlyArray<ResolvedRule>): void => {
  const map = computeMenuAccelerators(resolved);
  const json = JSON.stringify(map);
  if (json === lastAccelJson) return;
  lastAccelJson = json;
  const menu = window.zuse?.menu;
  menu?.setAccelerators?.(map);
};

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  resolvedRules: resolveRules([]).resolved,
  userRules: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const client = await getRpcClient();
      // Initial fetch — fills the cache before any keypress can race.
      const file = await Effect.runPromise(client.keybindings.get());
      const userRules = [...file.rules];
      const { resolved } = resolveRules(userRules);
      set({ resolvedRules: resolved, userRules, loaded: true, error: null });
      pushMenuAccelerators(resolved);

      // Subscribe for live updates (external hand-edits, follow-up writes
      // from other surfaces). One fiber per renderer, replaced on hot-reload.
      await stopStream();
      streamFiber = Effect.runFork(
        Stream.runForEach(client.keybindings.stream(), (next) =>
          Effect.sync(() => {
            const nextRules = [...next.rules];
            const r = resolveRules(nextRules);
            set({
              resolvedRules: r.resolved,
              userRules: nextRules,
              loaded: true,
              error: null,
            });
            pushMenuAccelerators(r.resolved);
          }),
        ),
      );
    } catch (err) {
      set({ error: formatError(err), loaded: true });
    }
  },

  setUserRules: async (rules) => {
    const clamped =
      rules.length > MAX_KEYBINDING_RULES
        ? rules.slice(rules.length - MAX_KEYBINDING_RULES)
        : rules;
    try {
      const client = await getRpcClient();
      const file = await Effect.runPromise(
        client.keybindings.replace({ rules: clamped }),
      );
      const nextRules = [...file.rules];
      const r = resolveRules(nextRules);
      set({ resolvedRules: r.resolved, userRules: nextRules, error: null });
      pushMenuAccelerators(r.resolved);
    } catch (err) {
      set({ error: formatError(err) });
    }
  },

  resetAll: async () => {
    await get().setUserRules([]);
  },

  resetCommand: async (command) => {
    const next = get().userRules.filter((r) => r.command !== command);
    await get().setUserRules(next);
  },

  addRule: async (rule) => {
    await get().setUserRules([...get().userRules, rule]);
  },

  replaceUserRuleAt: async (index, rule) => {
    const cur = get().userRules;
    if (index < 0 || index >= cur.length) return;
    const next = cur.slice();
    next[index] = rule;
    await get().setUserRules(next);
  },

  removeUserRuleAt: async (index) => {
    const cur = get().userRules;
    if (index < 0 || index >= cur.length) return;
    const next = cur.slice();
    next.splice(index, 1);
    await get().setUserRules(next);
  },
}));
