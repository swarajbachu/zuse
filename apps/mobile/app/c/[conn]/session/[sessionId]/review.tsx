import type { FolderId, SessionId } from "@zuse/contracts";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { X } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import { ReviewDiffList } from "~/components/diff/review-diff-list";
import { useWorkspaceReview } from "~/hooks/use-workspace-review";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

export default function WorkspaceReviewScreen() {
	const { conn, sessionId } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore(
		(state) => state.bundlesByConnection[connKey] ?? [],
	);
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const folderId = detail?.project.id as FolderId | undefined;
	const worktreeId = detail?.session.worktreeId ?? null;
	const connection = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const review = useWorkspaceReview({ connection, folderId, worktreeId });

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
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
					headerTitle: () => (
						<View className="items-center">
							<Text className="font-sans-medium text-[15px] text-foreground">
								{review.summary === null
									? "Review changes"
									: `${review.summary.files.length} ${review.summary.files.length === 1 ? "file" : "files"} changed`}
							</Text>
							{review.summary === null ? null : (
								<Text
									className="font-mono text-[11px]"
									style={{ fontVariant: ["tabular-nums"] }}
								>
									<Text style={{ color: colors.diffAdded }}>
										+{review.summary.additions}
									</Text>
									<Text style={{ color: colors.secondaryFg }}> </Text>
									<Text style={{ color: colors.diffRemoved }}>
										−{review.summary.deletions}
									</Text>
								</Text>
							)}
						</View>
					),
				}}
			/>
			<ReviewDiffList
				summary={review.summary}
				patches={review.patches}
				loading={review.loading}
				error={review.error}
				refreshing={review.refreshing}
				onRefresh={review.refresh}
			/>
		</View>
	);
}
