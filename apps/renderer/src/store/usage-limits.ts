import type {
	ProviderUsageLimits,
	UsageLimitHistoryPoint,
} from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";
import { getRpcClient } from "../lib/rpc-client.ts";

let rpcClient = getRpcClient;
let pendingLoad: Promise<void> | null = null;
const STALE_AFTER_MS = 60_000;
export const setUsageLimitsRpcClientForTest = (value: typeof getRpcClient) => {
	rpcClient = value;
};

type State = {
	providers: ReadonlyArray<ProviderUsageLimits>;
	history: ReadonlyArray<UsageLimitHistoryPoint>;
	loading: boolean;
	error: string | null;
	lastLoadedAt: number | null;
	load: () => Promise<void>;
	loadHistory: () => Promise<void>;
	refresh: (
		force?: boolean,
		providerId?: import("@zuse/contracts").ProviderId,
	) => Promise<void>;
};
export const useUsageLimitsStore = create<State>((set, get) => ({
	providers: [],
	history: [],
	loading: false,
	error: null,
	lastLoadedAt: null,
	load: async () => {
		const lastLoadedAt = get().lastLoadedAt;
		if (lastLoadedAt !== null && Date.now() - lastLoadedAt < STALE_AFTER_MS)
			return;
		if (pendingLoad !== null) {
			await pendingLoad;
			return;
		}
		const load = get()
			.refresh(false)
			.finally(() => {
				if (pendingLoad === load) pendingLoad = null;
			});
		pendingLoad = load;
		await load;
	},
	loadHistory: async () => {
		try {
			const client = await rpcClient();
			const response = await Effect.runPromise(
				client["usage.limits.history"]({}),
			);
			set({ history: response.points });
		} catch {
			// History is supplementary; live limit cards remain useful without it.
		}
	},
	refresh: async (force = false, providerId) => {
		set({ loading: true, error: null });
		try {
			const client = await rpcClient();
			const response = await Effect.runPromise(
				client["usage.limits"]({ forceRefresh: force, providerId }),
			);
			set({
				providers: providerId
					? [
							...get().providers.filter(
								(item) => item.providerId !== providerId,
							),
							...response.providers,
						]
					: response.providers,
				loading: false,
				lastLoadedAt: Date.now(),
			});
		} catch (error) {
			set({
				loading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},
}));
