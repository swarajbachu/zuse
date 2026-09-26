import type { ProviderId, ResolvedModelCatalog } from "@zuse/contracts";
import {
	bundledResolvedModelCatalog,
	CommandId,
	EnvironmentId,
	modelsForProvider,
	ResolvedModelCatalog as ResolvedModelCatalogSchema,
} from "@zuse/contracts";
import { Schema } from "effect";

import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { removeStorageKeys } from "../lib/storage-keys.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";

/**
 * Renderer copy of the resolved model catalog (curated seed merged with
 * live provider inventories by the server).
 *
 * Three tiers, each instant:
 *   1. the bundled snapshot compiled into the app (first paint, always),
 *   2. the last server answer persisted to localStorage (survives restarts),
 *   3. the server's `model.catalog` RPC, warmed once after app startup.
 *
 * The server is loaded once per renderer lifetime. The persisted snapshot
 * keeps first paint instant, while an explicit refresh remains available for
 * provider mutations. Replaces the per-provider inventory stores.
 */
export type ModelCatalogSource = "bundled" | "storage" | "server";

type State = {
	readonly catalog: ResolvedModelCatalog;
	readonly source: ModelCatalogSource;
	readonly loadedAt: number | null;
	readonly loadedEnvironmentId: string | null;
	readonly loading: boolean;
	readonly error: string | null;
	/** Load once from the server during this renderer lifetime. */
	readonly ensureLoaded: () => Promise<void>;
	/** Force the server to re-fetch the remote document and live listings. */
	readonly refresh: () => Promise<void>;
};

const STORAGE_KEY = "zuse.model-catalog.v1";
const LEGACY_INVENTORY_KEYS = [
	"zuse.kiro.inventory.v1",
	"zuse.opencode.inventory.v4",
	"zuse.opencode.inventory.v3",
	"zuse.opencode.inventory.v2",
	"memoize.opencode.inventory.v2",
] as const;

const activeEnvironmentId = (): EnvironmentId =>
	EnvironmentId.make(useEnvironmentCatalogStore.getState().activeEnvironmentId);

const readStorage = (): {
	catalog: ResolvedModelCatalog;
	storedAt: number;
} | null => {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as { storedAt?: unknown; catalog?: unknown };
		const catalog = Schema.decodeUnknownSync(ResolvedModelCatalogSchema)(
			parsed.catalog,
		);
		return {
			catalog,
			storedAt: typeof parsed.storedAt === "number" ? parsed.storedAt : 0,
		};
	} catch {
		try {
			window.localStorage.removeItem(STORAGE_KEY);
		} catch {
			// best-effort
		}
		return null;
	}
};

const writeStorage = (catalog: ResolvedModelCatalog): void => {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				storedAt: Date.now(),
				catalog: Schema.encodeSync(ResolvedModelCatalogSchema)(catalog),
			}),
		);
	} catch {
		// cache is best-effort
	}
};

const dropLegacyInventoryCaches = (): void => {
	if (typeof window === "undefined") return;
	try {
		removeStorageKeys(window.localStorage, LEGACY_INVENTORY_KEYS[0], [
			...LEGACY_INVENTORY_KEYS.slice(1),
		]);
	} catch {
		// best-effort
	}
};

const fetchCatalog = async (
	environmentId: EnvironmentId,
	refresh: boolean,
): Promise<ResolvedModelCatalog> => {
	const receipt = await dispatchEnvironmentShellCommand<
		{ readonly refresh?: boolean },
		ResolvedModelCatalog
	>({
		environmentId,
		kind: "model.catalog",
		commandId: CommandId.make(`model-catalog:${crypto.randomUUID()}`),
		payload: refresh ? { refresh: true } : {},
	});
	return receipt.result;
};

const sameCatalog = (
	a: ResolvedModelCatalog,
	b: ResolvedModelCatalog,
): boolean => JSON.stringify(a) === JSON.stringify(b);

const pendingLoads = new Map<string, Promise<void>>();

const initial = (() => {
	dropLegacyInventoryCaches();
	const stored = readStorage();
	return stored === null
		? { catalog: bundledResolvedModelCatalog(), source: "bundled" as const }
		: { catalog: stored.catalog, source: "storage" as const };
})();

export const useModelCatalogStore = create<State>((set, get) => {
	const load = async (refresh: boolean): Promise<void> => {
		const environmentId = activeEnvironmentId();
		const pendingLoad = pendingLoads.get(environmentId);
		if (pendingLoad !== undefined) {
			await pendingLoad;
			return;
		}
		set({ loading: true, error: null });
		const run = (async () => {
			try {
				const next = await fetchCatalog(environmentId, refresh);
				if (environmentId !== activeEnvironmentId()) {
					return;
				}
				const current = get().catalog;
				if (sameCatalog(current, next)) {
					set({
						loading: false,
						loadedAt: Date.now(),
						loadedEnvironmentId: environmentId,
						source: "server",
						error: null,
					});
				} else {
					set({
						catalog: next,
						source: "server",
						loadedAt: Date.now(),
						loadedEnvironmentId: environmentId,
						loading: false,
						error: null,
					});
				}
				writeStorage(next);
			} catch (err) {
				// Old server without the RPC, or a transport blip: keep showing
				// whatever we have (bundled or the last good answer).
				if (environmentId === activeEnvironmentId()) {
					set({
						loading: false,
						error: formatError(err),
						loadedAt: null,
						loadedEnvironmentId: null,
					});
				}
			}
		})().finally(() => {
			if (pendingLoads.get(environmentId) === run) {
				pendingLoads.delete(environmentId);
			}
		});
		pendingLoads.set(environmentId, run);
		await run;
	};

	return {
		catalog: initial.catalog,
		source: initial.source,
		loadedAt: null,
		loadedEnvironmentId: null,
		loading: false,
		error: null,
		ensureLoaded: async () => {
			if (get().loadedEnvironmentId === activeEnvironmentId()) return;
			await load(false);
		},
		refresh: () => load(true),
	};
});

/** Current catalog outside React (commands, tab close, settings seeds). */
export const currentModelCatalog = (): ResolvedModelCatalog =>
	useModelCatalogStore.getState().catalog;

/** Live models for one provider, in picker order. */
export const useProviderModels = (providerId: ProviderId) =>
	useModelCatalogStore((s) => modelsForProvider(s.catalog, providerId));

/** Drop the renderer copy (environment switch / sign-out). */
export const resetModelCatalogForEnvironment = (): void => {
	useModelCatalogStore.setState({
		catalog: bundledResolvedModelCatalog(),
		source: "bundled",
		loadedAt: null,
		loadedEnvironmentId: null,
		loading: false,
		error: null,
	});
};

/**
 * OpenCode provider-manager mutations (connect / disconnect / custom
 * providers). After any of them the server invalidates its OpenCode live
 * listing, so callers follow up with `refresh()`.
 */
export const dispatchOpencodeProviderCommand = async <Payload>(
	kind:
		| "provider.opencode.setAuth"
		| "provider.opencode.removeAuth"
		| "provider.opencode.addCustom"
		| "provider.opencode.removeCustom"
		| "provider.opencode2.setAuth"
		| "provider.opencode2.removeAuth"
		| "provider.opencode2.addCustom"
		| "provider.opencode2.removeCustom",
	payload: Payload,
): Promise<void> => {
	const environmentId = activeEnvironmentId();
	await dispatchEnvironmentShellCommand<Payload, unknown>({
		environmentId,
		kind,
		commandId: CommandId.make(`opencode-provider:${crypto.randomUUID()}`),
		payload,
	});
};
