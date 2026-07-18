import { groupTimelineTurns } from "@zuse/client-runtime/timeline";
import type { FolderId, GitReviewScope, SessionId } from "@zuse/contracts";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Minimize2, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ReviewDiffList } from "~/components/diff/review-diff-list";
import { ReviewScopeMenu } from "~/components/review-scope-menu";
import { useWorkspaceReview } from "~/hooks/use-workspace-review";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { buildLastTurnReview } from "~/lib/last-turn-review";
import { translucentNativeHeaderOptions } from "~/lib/native-header";
import type { MobileReviewScope } from "~/lib/review-scope";
import { selectConnectionBundles } from "~/lib/session-bundles";
import { connectionSessionKey } from "~/lib/session-key";
import { selectSessionMessages } from "~/lib/session-messages";
import { useConnectionsStore } from "~/store/connections";
import { useMobileMessagesStore } from "~/store/messages";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

export default function WorkspaceReviewScreen() {
	const headerHeight = useHeaderHeight();
	const { conn, sessionId } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const [scope, setScope] = useState<MobileReviewScope>("branch");
	const [collapseAllKey, setCollapseAllKey] = useState(0);
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore((state) =>
		selectConnectionBundles(state.bundlesByConnection, connKey),
	);
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const folderId = detail?.project.id as FolderId | undefined;
	const worktreeId = detail?.session.worktreeId ?? null;
	const connection = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const messages = useMobileMessagesStore((state) =>
		selectSessionMessages(
			state.messagesBySession,
			connectionSessionKey(connKey, normalizedSessionId),
		),
	);
	const turns = useMemo(() => groupTimelineTurns(messages), [messages]);
	const lastTurnReview = useMemo(
		() => buildLastTurnReview(turns.at(-1)),
		[turns],
	);
	const serverScope = scope === "last_turn" ? "branch" : scope;
	const review = useWorkspaceReview({
		connection,
		folderId,
		worktreeId,
		scope: serverScope as GitReviewScope,
		enabled: scope !== "last_turn",
	});
	const summary =
		scope === "last_turn" ? lastTurnReview.summary : review.summary;
	const patches =
		scope === "last_turn" ? lastTurnReview.patches : review.patches;

	return (
		<View collapsable={false} className="flex-1 bg-background/95">
			<Stack.Screen
				options={{
					...translucentNativeHeaderOptions,
					headerBackVisible: false,
					headerLargeTitle: false,
					headerTitleAlign: "center",
					headerLeft: () => (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Close review"
							hitSlop={10}
							onPress={() => router.back()}
							className="h-9 w-9 items-center justify-center rounded-full bg-card"
							style={{ borderCurve: "continuous" }}
						>
							<X size={19} color={colors.fg} />
						</Pressable>
					),
					headerRight: () => (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Collapse all file changes"
							hitSlop={10}
							onPress={() => setCollapseAllKey((current) => current + 1)}
							className="h-9 w-9 items-center justify-center rounded-full bg-card"
							style={{ borderCurve: "continuous" }}
						>
							<Minimize2 size={18} color={colors.fg} />
						</Pressable>
					),
					headerTitle: () => (
						<View className="items-center">
							<ReviewScopeMenu value={scope} onChange={setScope} />
							{summary === null ? null : (
								<Text
									className="font-mono text-[11px]"
									style={{ fontVariant: ["tabular-nums"] }}
								>
									<Text style={{ color: colors.diffAdded }}>
										+{summary.additions}
									</Text>
									<Text style={{ color: colors.secondaryFg }}> </Text>
									<Text style={{ color: colors.diffRemoved }}>
										−{summary.deletions}
									</Text>
								</Text>
							)}
						</View>
					),
				}}
			/>
			<View
				collapsable={false}
				className="flex-1"
				style={{ paddingTop: headerHeight }}
			>
				<ReviewDiffList
					summary={summary}
					patches={patches}
					loading={scope === "last_turn" ? false : review.loading}
					error={scope === "last_turn" ? null : review.error}
					refreshing={scope === "last_turn" ? false : review.refreshing}
					onRefresh={scope === "last_turn" ? undefined : review.refresh}
					collapseAllKey={collapseAllKey}
				/>
				{scope === "branch" && summary?.baseRef !== null ? (
					<View className="border-t border-border bg-card/95 px-4 py-3">
						<Text
							selectable
							className="text-center font-mono text-[12px] text-muted-foreground"
						>
							{summary?.headRef ?? "Current branch"} → {summary?.baseRef}
						</Text>
					</View>
				) : null}
			</View>
		</View>
	);
}
