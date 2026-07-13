import type { FolderId, UsageOverview } from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";

import { getRpcClient } from "../lib/rpc-client.ts";

let getUsageRpcClient: typeof getRpcClient = getRpcClient;

export const setUsageRpcClientForTest = (fn: typeof getRpcClient): void => {
	getUsageRpcClient = fn;
};

export type UsagePeriod = "7d" | "30d" | "90d";

const PERIOD_DAYS: Record<UsagePeriod, number> = {
	"7d": 7,
	"30d": 30,
	"90d": 90,
};

const cacheKey = (period: UsagePeriod, projectId: FolderId | null): string =>
	`${projectId ?? "global"}:${period}`;

const sinceFor = (period: UsagePeriod): Date =>
	new Date(Date.now() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1_000);

type UsageState = {
	readonly report: UsageOverview | null;
	readonly loading: boolean;
	readonly refreshing: boolean;
	readonly error: string | null;
	readonly period: UsagePeriod;
	readonly requestId: number;
	readonly cache: Readonly<Record<string, UsageOverview>>;
	readonly refresh: (
		projectId: FolderId | null,
		opts?: { readonly forceRefresh?: boolean },
	) => Promise<void>;
	readonly prefetch: (projectId: FolderId | null) => Promise<void>;
	readonly setPeriod: (
		period: UsagePeriod,
		projectId: FolderId | null,
	) => Promise<void>;
};

export const useUsageStore = create<UsageState>((set, get) => ({
	report: null,
	loading: false,
	refreshing: false,
	error: null,
	period: "7d",
	requestId: 0,
	cache: {},
	refresh: async (projectId, opts) => {
		const period = get().period;
		const key = cacheKey(period, projectId);
		const cached = get().cache[key];
		const visible = cached ?? get().report;
		const requestId = get().requestId + 1;
		set({
			report: cached ?? get().report,
			loading: visible === null,
			refreshing: visible !== null,
			error: null,
			requestId,
		});
		try {
			const client = await getUsageRpcClient();
			const report = await Effect.runPromise(
				client["usage.overview"]({
					since: sinceFor(period),
					projectId: projectId ?? undefined,
					forceRefresh: opts?.forceRefresh,
				}),
			);
			if (get().requestId !== requestId) return;
			set((state) => ({
				report,
				loading: false,
				refreshing: false,
				cache: { ...state.cache, [key]: report },
			}));
		} catch (error) {
			if (get().requestId !== requestId) return;
			set({
				loading: false,
				refreshing: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},
	prefetch: async (projectId) => {
		const key = cacheKey(get().period, projectId);
		if (get().cache[key] !== undefined || get().loading || get().refreshing)
			return;
		await get().refresh(projectId);
	},
	setPeriod: async (period, projectId) => {
		const cached = get().cache[cacheKey(period, projectId)];
		set({ period, report: cached ?? get().report });
		await get().refresh(projectId);
	},
}));
