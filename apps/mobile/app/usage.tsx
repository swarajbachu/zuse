import { useAtomValue } from "@effect/atom-react";
import type { ProviderUsageLimits, UsageOverview } from "@zuse/contracts";
import { Effect } from "effect";
import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	RefreshControl,
	ScrollView,
	Text,
	View,
} from "react-native";

import { connectionErrorMessage } from "~/lib/connection-error-message";
import { optionsForConnection } from "~/lib/connection-params";
import { loadUsageLimits, loadUsageOverview } from "~/rpc/actions";
import { connectionsAtom } from "~/store/connections";

const tokens = (value: number): string =>
	new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);

export default function UsageScreen() {
	const connections = useAtomValue(connectionsAtom);
	const [overview, setOverview] = useState<UsageOverview | null>(null);
	const [limits, setLimits] = useState<readonly ProviderUsageLimits[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(
		async (forceRefresh = false) => {
			const record = connections[0];
			if (record === undefined) {
				setLoading(false);
				setError("Connect a computer to view usage.");
				return;
			}
			const connection = optionsForConnection(record.key, connections);
			if (connection === null) return;
			setLoading(true);
			setError(null);
			try {
				const [nextOverview, nextLimits] = await Promise.all([
					Effect.runPromise(loadUsageOverview({ connection, forceRefresh })),
					Effect.runPromise(loadUsageLimits({ connection, forceRefresh })),
				]);
				setOverview(nextOverview);
				setLimits(nextLimits.providers);
			} catch (cause) {
				setError(connectionErrorMessage(cause));
			} finally {
				setLoading(false);
			}
		},
		[connections],
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<>
			<Stack.Screen options={{ title: "Usage" }} />
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				refreshControl={
					<RefreshControl
						refreshing={loading}
						onRefresh={() => void refresh(true)}
					/>
				}
				contentContainerClassName="gap-5 px-5 pb-12 pt-4"
			>
				{loading && overview === null ? <ActivityIndicator /> : null}
				{error === null ? null : (
					<Text selectable className="text-danger">
						{error}
					</Text>
				)}
				{overview === null ? null : (
					<>
						<View className="flex-row gap-3">
							<Metric
								label="Input"
								value={tokens(overview.summary.inputTokens)}
							/>
							<Metric
								label="Output"
								value={tokens(overview.summary.outputTokens)}
							/>
						</View>
						<View className="flex-row gap-3">
							<Metric label="Sessions" value={String(overview.sessionCount)} />
							<Metric
								label="Cost"
								value={
									overview.summary.costUsd === null
										? "—"
										: `$${overview.summary.costUsd.toFixed(2)}`
								}
							/>
						</View>
					</>
				)}
				{limits.map((provider) => (
					<View
						key={provider.providerId}
						className="gap-3 rounded-2xl border border-border bg-card p-4"
					>
						<Text className="font-sans-medium text-[17px] text-foreground">
							{provider.providerId}
							{provider.planLabel === null ? "" : ` · ${provider.planLabel}`}
						</Text>
						{provider.windows.map((window) => (
							<View key={window.id} className="gap-1.5">
								<View className="flex-row justify-between">
									<Text className="font-sans text-[14px] text-muted-foreground">
										{window.label}
									</Text>
									<Text className="font-mono text-[13px] text-foreground">
										{window.usedPercent === null
											? "Unavailable"
											: `${Math.round(window.usedPercent)}%`}
									</Text>
								</View>
								<View className="h-2 overflow-hidden rounded-full bg-muted">
									<View
										className="h-full rounded-full bg-primary"
										style={{
											width: `${Math.max(0, Math.min(100, window.usedPercent ?? 0))}%`,
										}}
									/>
								</View>
							</View>
						))}
					</View>
				))}
			</ScrollView>
		</>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<View className="min-h-24 flex-1 justify-between rounded-2xl border border-border bg-card p-4">
			<Text className="font-sans text-[13px] text-muted-foreground">
				{label}
			</Text>
			<Text className="font-mono text-[24px] text-foreground">{value}</Text>
		</View>
	);
}
