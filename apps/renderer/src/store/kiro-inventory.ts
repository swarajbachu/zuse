import type { KiroInventory } from "@zuse/contracts";
import { Effect } from "effect";

import { formatError } from "../lib/format-error.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { readStorageWithLegacy } from "../lib/storage-keys.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

/**
 * Renderer cache of Kiro's live model catalog (control-plane
 * ListAvailableModels / CLI list-models). Shown immediately from
 * localStorage so the picker doesn't flash the static seed.
 */
type State = {
	readonly inventory: KiroInventory | null;
	readonly loading: boolean;
	readonly error: string | null;
	readonly ensureLoaded: () => Promise<void>;
	readonly refresh: () => Promise<void>;
};

const STORAGE_KEY = "zuse.kiro.inventory.v1";

const readCache = (): KiroInventory | null => {
	if (typeof window === "undefined") return null;
	try {
		const raw = readStorageWithLegacy(window.localStorage, STORAGE_KEY, []);
		if (raw === null) return null;
		return JSON.parse(raw) as KiroInventory;
	} catch {
		return null;
	}
};

const writeCache = (inv: KiroInventory): void => {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(inv));
	} catch {
		// cache is best-effort
	}
};

const sameInventory = (a: KiroInventory | null, b: KiroInventory): boolean => {
	if (a === null) return false;
	return JSON.stringify(a) === JSON.stringify(b);
};

const fetchInventory = async (): Promise<KiroInventory> => {
	const client = await getRpcClient();
	return Effect.runPromise(client["provider.kiro.inventory"]({}));
};

export const useKiroInventory = create<State>((set, get) => ({
	inventory: readCache(),
	loading: false,
	error: null,
	ensureLoaded: async () => {
		if (get().loading) return;
		const cached = get().inventory;
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
			set({
				error: cached === null ? formatError(err) : null,
				loading: false,
			});
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
