import type { FolderId, UsageSessionsPage } from "@zuse/contracts";
import { Effect } from "effect";
import { useEffect, useState } from "react";

import { getRpcClient } from "~/lib/rpc-client";
import type { UsagePeriod } from "~/store/usage";

export type UsageSessionSort = "tokens" | "cost" | "last-active";

export function useUsageSessions(options: {
	readonly enabled: boolean;
	readonly projectId: FolderId | null;
	readonly period: UsagePeriod;
	readonly query: string;
	readonly providerId: string | null;
	readonly sort: UsageSessionSort;
	readonly offset: number;
	readonly limit: number;
}) {
	const [page, setPage] = useState<UsageSessionsPage | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!options.enabled) return;
		let active = true;
		const timeout = window.setTimeout(() => {
			setLoading(true);
			setError(null);
			void getRpcClient()
				.then((client) =>
					Effect.runPromise(
						client["usage.sessions"]({
							since: new Date(
								Date.now() - Number.parseInt(options.period, 10) * 86_400_000,
							),
							projectId: options.projectId ?? undefined,
							query: options.query.trim() || undefined,
							providerId: options.providerId ?? undefined,
							sort: options.sort,
							offset: options.offset,
							limit: options.limit,
						}),
					),
				)
				.then((value) => {
					if (active) setPage(value);
				})
				.catch((cause: unknown) => {
					if (active)
						setError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					if (active) setLoading(false);
				});
		}, 150);

		return () => {
			active = false;
			window.clearTimeout(timeout);
		};
	}, [
		options.enabled,
		options.limit,
		options.offset,
		options.period,
		options.projectId,
		options.query,
		options.providerId,
		options.sort,
	]);

	return { page, loading, error } as const;
}
