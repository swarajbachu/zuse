import type { FolderId, UsageOverview } from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";

import { getRpcClient } from "../lib/rpc-client.ts";
import { sinceForUsagePeriod, type UsagePeriod } from "../lib/usage-period.ts";

export type { UsagePeriod } from "../lib/usage-period.ts";

let getUsageRpcClient: typeof getRpcClient = getRpcClient;

export const setUsageRpcClientForTest = (fn: typeof getRpcClient): void => {
	getUsageRpcClient = fn;
};

const cacheKey = (period: UsagePeriod, projectId: FolderId | null): string =>
	`${projectId ?? "global"}:${period}`;

export type UsageRange = {
	readonly since: Date;
	readonly until: Date;
	readonly label: string;
};

type UsageState = {
	readonly report: UsageOverview | null;
	readonly loading: boolean;
	readonly refreshing: boolean;
	readonly error: string | null;
	readonly period: UsagePeriod;
	readonly selectedRange: UsageRange | null;
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
	readonly setRange: (
		range: UsageRange | null,
		projectId: FolderId | null,
	) => Promise<void>;
};

export const useUsageStore = create<UsageState>((set, get) => ({
	report: null,
	loading: false,
	refreshing: false,
	error: null,
	period: "7d",
	selectedRange: null,
	requestId: 0,
	cache: {},
	refresh: async (projectId, opts) => {
		const period = get().period;
		const selectedRange = get().selectedRange;
		const key = selectedRange
			? `${cacheKey(period, projectId)}:${selectedRange.since.toISOString()}:${selectedRange.until.toISOString()}`
			: cacheKey(period, projectId);
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
					since: selectedRange?.since ?? sinceForUsagePeriod(period),
					until: selectedRange?.until,
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
		set({ period, selectedRange: null, report: cached ?? get().report });
		await get().refresh(projectId);
	},
	setRange: async (range, projectId) => {
		set({ selectedRange: range });
		await get().refresh(projectId);
	},
}));
