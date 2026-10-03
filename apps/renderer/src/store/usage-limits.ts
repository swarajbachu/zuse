import type {
	EnvironmentId,
	ProviderUsageLimits,
	UsageLimitHistoryPoint,
} from "@zuse/contracts";
import {
	CommandId,
	EnvironmentId as EnvironmentIdSchema,
} from "@zuse/contracts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

let pendingLoad: Promise<void> | null = null;
const pendingRefreshes = new Map<string, Promise<void>>();
const latestByProvider = new Map<string, number>();
let requestSequence = 0;
let activeRequests = 0;
let historyVersion = 0;
const STALE_AFTER_MS = 60_000;
type UsageCommand = <Result>(
	environmentId: EnvironmentId,
	kind: string,
	payload: Readonly<Record<string, unknown>>,
) => Promise<Result>;
let runUsageCommand: UsageCommand = async <Result>(
	environmentId: EnvironmentId,
	kind: string,
	payload: Readonly<Record<string, unknown>>,
) => {
	return (
		await dispatchEnvironmentShellCommand<
			Readonly<Record<string, unknown>>,
			Result
		>({
			environmentId,
			kind,
			commandId: CommandId.make(`usage:${crypto.randomUUID()}`),
			payload,
		})
	).result;
};
export const setUsageCommandForTest = (command: UsageCommand): void => {
	runUsageCommand = command;
};

type State = {
	providers: ReadonlyArray<ProviderUsageLimits>;
	history: ReadonlyArray<UsageLimitHistoryPoint>;
	loading: boolean;
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
	error: null,
	lastLoadedAt: null,
	invalidate: (providerId) => {
		historyVersion++;
		latestByProvider.set(providerId, ++requestSequence);
		// In-flight results for the previous account must not repopulate the card.
		pendingRefreshes.delete(providerId);
		pendingRefreshes.delete("all");
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
		const key = providerId ?? "all";
		const existing = pendingRefreshes.get(key);
		if (existing) return existing;
		const sequence = ++requestSequence;
		const targets = providerId
			? [providerId]
			: ["claude", "codex", "grok", "gemini", "kiro"];
		for (const id of targets) latestByProvider.set(id, sequence);
		activeRequests++;
		set({ loading: true, error: null });
		const pending = (async () => {
			try {
				const response = await runUsageCommand<{
					readonly providers: ReadonlyArray<ProviderUsageLimits>;
				}>(EnvironmentIdSchema.make(getLocalEnvironmentId()), "usage.limits", {
					forceRefresh: force,
					providerId,
				});
				const accepted = response.providers.filter(
					(p) => latestByProvider.get(p.providerId) === sequence,
				);
				const acceptedIds = new Set(accepted.map((p) => p.providerId));
				const stillCurrent = targets.some(
					(id) => latestByProvider.get(id) === sequence,
				);
				if (stillCurrent)
					set({
						providers: [
							...get().providers.filter((p) => !acceptedIds.has(p.providerId)),
							...accepted,
						],
						lastLoadedAt:
							providerId === undefined ? Date.now() : get().lastLoadedAt,
						...(sequence === requestSequence ? { error: null } : {}),
					});
			} catch (error) {
				if (sequence === requestSequence)
					set({
						error: error instanceof Error ? error.message : String(error),
					});
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
