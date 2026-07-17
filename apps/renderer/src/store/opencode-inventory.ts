import { Effect } from "effect";
import { createAtomStore as create } from "../state/atom-store.ts";

import type { OpencodeInventory } from "@zuse/contracts";

import { formatError } from "../lib/format-error.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { readStorageWithLegacy } from "../lib/storage-keys.ts";

/**
 * Renderer-side cache of opencode's locally-connected providers + agents.
 *
 * Cached to `localStorage` so the picker shows the user's actual model
 * list on first paint instead of flashing the static seed for a few
 * hundred ms while `opencode serve` boots. The cached snapshot is shown
 * immediately; a background refresh runs on `ensureLoaded()` and quietly
 * updates the store if the result differs. Errors during refresh are
 * swallowed so a transient failure doesn't blank out a working cache.
 */
type State = {
  readonly inventory: OpencodeInventory | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly ensureLoaded: () => Promise<void>;
  readonly refresh: () => Promise<void>;
};

// Bumped when the inventory shape changes — old payloads (e.g. providers
// without the `connected`/`custom` flags added for the provider manager)
// would misrender the picker if we read them back as the new type.
const STORAGE_KEY = "zuse.opencode.inventory.v4";
const LEGACY_STORAGE_KEYS = [
  "zuse.opencode.inventory.v3",
  "zuse.opencode.inventory.v2",
  "memoize.opencode.inventory.v2",
] as const;

const readCache = (): OpencodeInventory | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = readStorageWithLegacy(
      window.localStorage,
      STORAGE_KEY,
      LEGACY_STORAGE_KEYS,
    );
    if (raw === null) return null;
    return JSON.parse(raw) as OpencodeInventory;
  } catch {
    return null;
  }
};

const writeCache = (inv: OpencodeInventory): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(inv));
  } catch {
    // ignore — cache is best-effort
  }
};

const sameInventory = (
  a: OpencodeInventory | null,
  b: OpencodeInventory,
): boolean => {
  if (a === null) return false;
  // Cheap deep-equal: the shape is small (providers + agents arrays).
  // Avoids re-rendering the picker when the live result matches cache.
  return JSON.stringify(a) === JSON.stringify(b);
};

const fetchInventory = async (): Promise<OpencodeInventory> => {
  const client = await getRpcClient();
  return Effect.runPromise(client["provider.opencode.inventory"]({}));
};

export const useOpencodeInventory = create<State>((set, get) => ({
  inventory: readCache(),
  loading: false,
  error: null,
  ensureLoaded: async () => {
    if (get().loading) return;
    const cached = get().inventory;
    // Background-refresh whenever called. If we have a cached value the
    // user sees it instantly and we silently update on success; if not,
    // the picker shows the static seed for the boot interval. We don't
    // set `loading: true` when cache is present so the UI doesn't
    // pulse.
    if (cached === null) set({ loading: true, error: null });
    try {
      const next = await fetchInventory();
      if (!sameInventory(get().inventory, next)) {
        set({ inventory: next, loading: false, error: null });
        writeCache(next);
      } else {
        set({ loading: false });
      }
    } catch (err) {
      // Keep the cached value visible on failure.
      set({ error: cached === null ? formatError(err) : null, loading: false });
    }
  },
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const next = await fetchInventory();
      set({ inventory: next, loading: false });
      writeCache(next);
    } catch (err) {
      set({ error: formatError(err), loading: false });
    }
  },
}));
