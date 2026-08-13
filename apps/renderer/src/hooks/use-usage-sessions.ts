import type {
	EnvironmentId,
	FolderId,
	ProviderId,
	UsageSessionsPage,
} from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { useEffect, useState } from "react";

import { dispatchEnvironmentShellCommand } from "~/lib/environment-shell-client-bus";
import { sinceForUsagePeriod } from "~/lib/usage-period";
import type { UsagePeriod } from "~/store/usage";

export type UsageSessionSort = "tokens" | "cost" | "last-active";

export function useUsageSessions(options: {
	readonly enabled: boolean;
	readonly environmentId: EnvironmentId;
	readonly projectId: FolderId | null;
	readonly period: UsagePeriod;
	readonly since?: Date;
	readonly until?: Date;
	readonly query: string;
	readonly providerId: ProviderId | null;
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
			void dispatchEnvironmentShellCommand<
				{
					readonly since: Date;
					readonly until: Date | undefined;
					readonly projectId: FolderId | undefined;
					readonly query: string | undefined;
					readonly providerId: ProviderId | undefined;
					readonly sort: UsageSessionSort;
					readonly offset: number;
					readonly limit: number;
				},
				UsageSessionsPage
			>({
				environmentId: options.environmentId,
				kind: "usage.sessions",
				commandId: CommandId.make(`usage-sessions:${crypto.randomUUID()}`),
				payload: {
					since: options.since ?? sinceForUsagePeriod(options.period),
					until: options.until,
					projectId: options.projectId ?? undefined,
					query: options.query.trim() || undefined,
					providerId: options.providerId ?? undefined,
					sort: options.sort,
					offset: options.offset,
					limit: options.limit,
				},
				retry: "never",
			})
				.then((receipt) => {
					if (active) setPage(receipt.result);
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
		options.environmentId,
		options.limit,
		options.offset,
		options.period,
		options.projectId,
		options.query,
		options.providerId,
		options.sort,
		options.since,
		options.until,
	]);

	return { page, loading, error } as const;
}
