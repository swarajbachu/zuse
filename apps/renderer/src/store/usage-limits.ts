import type {
	EnvironmentId,
	ProviderUsageLimits,
	UsageLimitHistoryPoint,
} from "@zuse/contracts";
import { EnvironmentId as EnvironmentIdSchema } from "@zuse/contracts";
import { readEnvironmentUsage } from "../lib/environment-shell-client-bus.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

let pendingLoad: Promise<void> | null = null;
const pendingRefreshes = new Map<string, Promise<void>>();
const latestByProvider = new Map<string, number>();
let requestSequence = 0;
let activeRequests = 0;
const activeProviders = new Map<string, number>();
let historyVersion = 0;
const STALE_AFTER_MS = 60_000;
type UsageCommand = <Result>(
	environmentId: EnvironmentId,
	kind: "usage.limits" | "usage.limits.history",
	payload: Readonly<Record<string, unknown>>,
) => Promise<Result>;
let runUsageCommand: UsageCommand = readEnvironmentUsage;
export const setUsageCommandForTest = (command: UsageCommand): void => {
	runUsageCommand = command;
};

type State = {
	providers: ReadonlyArray<ProviderUsageLimits>;
	history: ReadonlyArray<UsageLimitHistoryPoint>;
	loading: boolean;
	loadingProviders: ReadonlyArray<string>;
	error: string | null;
	lastLoadedAt: number | null;
	load: () => Promise<void>;
	invalidate: (providerId: import("@zuse/contracts").ProviderId) => void;
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
	loadingProviders: [],
	error: null,
	lastLoadedAt: null,
	invalidate: (providerId) => {
		historyVersion++;
		latestByProvider.set(providerId, ++requestSequence);
		// In-flight results for the previous account must not repopulate the card.
		for (const target of [providerId, "all"]) {
			pendingRefreshes.delete(`${target}:true`);
			pendingRefreshes.delete(`${target}:false`);
		}
		pendingLoad = null;
		set({
			providers: get().providers.filter((p) => p.providerId !== providerId),
			history: get().history.filter((p) => p.providerId !== providerId),
			lastLoadedAt: null,
		});
	},
	load: async () => {
		const lastLoadedAt = get().lastLoadedAt;
		const retry =
			get().error !== null ||
			get().providers.some(
				(p) =>
					p.unavailableReason !== undefined &&
					p.unavailableReason !== "unsupported",
			);
		if (
			lastLoadedAt !== null &&
			Date.now() - lastLoadedAt < (retry ? 5_000 : STALE_AFTER_MS)
		)
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
		const version = historyVersion;
		try {
			const response = await runUsageCommand<{
				readonly points: ReadonlyArray<UsageLimitHistoryPoint>;
			}>(
				EnvironmentIdSchema.make(getLocalEnvironmentId()),
				"usage.limits.history",
				{},
			);
			if (version === historyVersion) set({ history: response.points });
		} catch {
			// History is supplementary; live limit cards remain useful without it.
		}
	},
	refresh: (force = false, providerId) => {
		const key = `${providerId ?? "all"}:${force}`;
		const accountVersion = historyVersion;
		const existing =
			pendingRefreshes.get(key) ??
			(!force
				? pendingRefreshes.get(`${providerId ?? "all"}:true`)
				: undefined);
		if (existing) return existing;
		const sequence = ++requestSequence;
		const targets = providerId
			? [providerId]
			: ["claude", "codex", "grok", "gemini", "kiro"];
		for (const id of targets) latestByProvider.set(id, sequence);
		activeRequests++;
		set({ loading: true, error: null });
		for (const id of targets)
			activeProviders.set(id, (activeProviders.get(id) ?? 0) + 1);
		set({ loadingProviders: [...activeProviders.keys()] });
		const pending = (async () => {
			let failed = false;
			try {
				// Publish each provider as it answers. One slow CLI must not hold
				// every other card behind the all-provider RPC's response barrier.
				await Promise.all(
					targets.map(async (id) => {
						try {
							const response = await runUsageCommand<{
								readonly providers: ReadonlyArray<ProviderUsageLimits>;
							}>(
								EnvironmentIdSchema.make(getLocalEnvironmentId()),
								"usage.limits",
								{
									forceRefresh: force,
									providerId: id,
								},
							);
							if (latestByProvider.get(id) !== sequence) return;
							const accepted = response.providers.filter(
								(p) => p.providerId === id,
							);
							const acceptedIds = new Set(accepted.map((p) => p.providerId));
							set({
								providers: [
									...get().providers.filter(
										(p) => !acceptedIds.has(p.providerId),
									),
									...accepted,
								],
							});
						} catch (error) {
							failed = true;
							if (latestByProvider.get(id) === sequence)
								set({
									error: error instanceof Error ? error.message : String(error),
								});
						} finally {
							const remaining = (activeProviders.get(id) ?? 1) - 1;
							if (remaining) activeProviders.set(id, remaining);
							else activeProviders.delete(id);
							set({ loadingProviders: [...activeProviders.keys()] });
						}
					}),
				);
				if (
					!failed &&
					providerId === undefined &&
					accountVersion === historyVersion &&
					targets.some((id) => latestByProvider.get(id) === sequence)
				)
					set({ lastLoadedAt: Date.now() });
			} finally {
				activeRequests--;
				set({ loading: activeRequests > 0 });
			}
		})();
		pendingRefreshes.set(key, pending);
		void pending.then(() => {
			if (pendingRefreshes.get(key) === pending) pendingRefreshes.delete(key);
		});
		return pending;
	},
}));
