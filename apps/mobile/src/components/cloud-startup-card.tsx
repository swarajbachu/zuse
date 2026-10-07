import { useAtomValue } from "@effect/atom-react";
import {
	cloudFailureRank,
	cloudPhaseLabel,
	cloudPhaseRank,
} from "@zuse/client-runtime/cloud-startup-presentation";
import { Effect } from "effect";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { cloudLifecycle } from "~/lib/cloud-lifecycle";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { cloudControlClient } from "~/rpc/api-client";
import { cloudCatalogAtom, refreshCloudCatalog } from "~/store/cloud-catalog";
import { colors } from "~/theme";

const STEPS = ["Workspace", "Runtime", "Repository", "Agent"] as const;

/**
 * Desktop-style cloud setup surface for a chat whose workspace is preparing,
 * resuming, sleeping or failed. The first message waits in the durable
 * outbox meanwhile and is delivered once the runtime is ready.
 */
export function CloudStartupCard({ workspaceId }: { workspaceId: string }) {
	const catalog = useAtomValue(cloudCatalogAtom);
	const summary = catalog.chats.find((row) => row.workspaceId === workspaceId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lifecycle = cloudLifecycle(summary);
	if (summary === undefined || lifecycle === null) return null;

	const resume = async () => {
		setBusy(true);
		setError(null);
		try {
			await Effect.runPromise(
				cloudControlClient["cloud.workspaces.resume"]({ workspaceId }),
			);
			await refreshCloudCatalog();
		} catch (cause) {
			setError(connectionErrorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	if (lifecycle === "paused" || lifecycle === "resuming") {
		return (
			<View className="mx-4 mt-2 flex-row items-center gap-3 rounded-2xl bg-card-elevated px-4 py-3">
				{lifecycle === "resuming" ? (
					<ActivityIndicator size="small" color={colors.accent} />
				) : (
					<SymbolView
						name="moon.zzz"
						size={16}
						tintColor={colors.secondaryFg}
					/>
				)}
				<Text className="flex-1 font-sans text-[13px] text-muted-foreground">
					{lifecycle === "resuming"
						? "Resuming cloud workspace…"
						: "Cloud workspace is sleeping. Your next message wakes it."}
				</Text>
				{lifecycle === "paused" ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onPress={() => void resume()}
					>
						Resume
					</Button>
				) : null}
			</View>
		);
	}

	const failed = lifecycle === "failed";
	const rank = failed
		? cloudFailureRank(summary.statusCode)
		: cloudPhaseRank[summary.startupPhase];
	return (
		<View
			accessibilityRole="summary"
			className="mx-4 mt-2 gap-3 rounded-2xl bg-card-elevated px-4 py-3"
		>
			<View className="flex-row items-center gap-2">
				{failed ? (
					<SymbolView
						name="exclamationmark.triangle.fill"
						size={15}
						tintColor={colors.danger}
					/>
				) : (
					<ActivityIndicator size="small" color={colors.accent} />
				)}
				<Text
					className={
						failed
							? "flex-1 font-sans text-[13px] text-danger"
							: "flex-1 font-sans-medium text-[13px] text-foreground"
					}
				>
					{cloudPhaseLabel(
						failed ? "failed" : summary.startupPhase,
						summary.statusCode,
					)}
				</Text>
			</View>
			<View className="flex-row gap-1.5">
				{STEPS.map((step, index) => {
					const state =
						failed && index === rank
							? "failed"
							: rank > index
								? "done"
								: rank === index
									? "active"
									: "pending";
					return (
						<View key={step} className="flex-1 gap-1">
							<View
								className={
									state === "failed"
										? "h-1 rounded-full bg-danger"
										: state === "pending"
											? "h-1 rounded-full bg-muted"
											: "h-1 rounded-full bg-primary"
								}
								style={state === "active" ? { opacity: 0.55 } : undefined}
							/>
							<Text className="font-sans text-[11px] text-muted-foreground">
								{step}
							</Text>
						</View>
					);
				})}
			</View>
			{failed ? (
				<Button
					size="sm"
					variant="secondary"
					className="self-start"
					disabled={busy}
					onPress={() => void resume()}
				>
					{busy ? "Retrying…" : "Retry"}
				</Button>
			) : null}
			{error ? (
				<Text className="font-sans text-[12px] text-danger">{error}</Text>
			) : null}
		</View>
	);
}
