import { useAtomValue } from "@effect/atom-react";
import {
	cloudPhaseLabel,
	cloudPhaseRank,
} from "@zuse/client-runtime/cloud-startup-presentation";
import { Effect } from "effect";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { cloudLifecycle } from "~/lib/cloud-lifecycle";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	cloudCatalogAtom,
	cloudControlForChat,
	refreshCloudCatalog,
} from "~/store/cloud-catalog";
import { colors } from "~/theme";

const STEP_COUNT = 4;

const elapsedLabel = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Seconds since the workspace entered its current lifecycle stage. */
const useElapsed = (key: string | null): number => {
	const [startedAt, setStartedAt] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setStartedAt(Date.now());
		setNow(Date.now());
		if (key === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [key]);
	return now - startedAt;
};

/**
 * One quiet line above the composer for a cloud workspace that is preparing,
 * resuming, asleep or failed — the mobile counterpart of desktop's composer
 * connection tray. The first message waits in the durable outbox meanwhile.
 */
export function CloudLifecycleBar({ workspaceId }: { workspaceId: string }) {
	const catalog = useAtomValue(cloudCatalogAtom);
	const summary = catalog.chats.find((row) => row.workspaceId === workspaceId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lifecycle = cloudLifecycle(summary);
	const waiting = lifecycle === "starting" || lifecycle === "resuming";
	// A visible clock tells a slow boot apart from a hang.
	const elapsed = useElapsed(
		waiting ? `${lifecycle}:${summary?.startupPhase ?? ""}` : null,
	);
	if (summary === undefined || lifecycle === null) return null;

	const resume = async () => {
		setBusy(true);
		setError(null);
		try {
			const cloudControlClient = await cloudControlForChat(workspaceId);
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

	const failed = lifecycle === "failed";
	const label =
		error ??
		(lifecycle === "starting"
			? cloudPhaseLabel(summary.startupPhase, summary.statusCode)
			: lifecycle === "resuming"
				? "Resuming cloud workspace…"
				: lifecycle === "paused"
					? "Asleep · your next message wakes it"
					: cloudPhaseLabel("failed", summary.statusCode));
	const action = lifecycle === "paused" ? "Resume" : failed ? "Retry" : null;

	return (
		<View
			role="status"
			aria-live="polite"
			// Same inset as the collapsed composer capsule beneath it.
			className="mx-6 mb-2 min-h-9 flex-row items-center gap-2 rounded-full bg-card-elevated px-3"
		>
			{waiting || busy ? (
				<ActivityIndicator size="small" color={colors.secondaryFg} />
			) : (
				<SymbolView
					name={failed ? "exclamationmark.circle.fill" : "moon.zzz.fill"}
					size={14}
					tintColor={failed ? colors.danger : colors.secondaryFg}
				/>
			)}
			<Text
				numberOfLines={failed || error !== null ? 2 : 1}
				className={
					failed || error !== null
						? "flex-1 py-2 font-sans text-[13px] text-danger"
						: "flex-1 font-sans text-[13px] text-muted-foreground"
				}
			>
				{label}
			</Text>
			{waiting ? (
				<Text
					className="font-sans text-[12px] text-muted-foreground"
					style={{ fontVariant: ["tabular-nums"] }}
				>
					{lifecycle === "starting"
						? `${Math.max(1, cloudPhaseRank[summary.startupPhase] + 1)} of ${STEP_COUNT} · ${elapsedLabel(elapsed)}`
						: elapsedLabel(elapsed)}
				</Text>
			) : null}
			{action !== null ? (
				<Pressable
					accessibilityRole="button"
					disabled={busy}
					hitSlop={8}
					onPress={() => void resume()}
				>
					<Text className="font-sans-medium text-[13px] text-accent">
						{action}
					</Text>
				</Pressable>
			) : null}
		</View>
	);
}
