import { useAtomValue } from "@effect/atom-react";
import { groupTimelineTurns } from "@zuse/client-runtime/timeline";
import type { FolderId, GitReviewScope, SessionId } from "@zuse/contracts";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";

import { ReviewDiffList } from "~/components/diff/review-diff-list";
import { useWorkspaceReview } from "~/hooks/use-workspace-review";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { buildLastTurnReview } from "~/lib/last-turn-review";
import {
	type MobileReviewScope,
	REVIEW_SCOPES,
	reviewScopeLabel,
} from "~/lib/review-scope";
import { connectionSessionKey } from "~/lib/session-key";
import { connectionsAtom } from "~/store/connections";
import { sessionMessagesAtom } from "~/store/messages";
import { connectionBundlesAtom, selectSessionChat } from "~/store/sessions";
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
	const [accordionKey, setAccordionKey] = useState(0);
	const [allFilesExpanded, setAllFilesExpanded] = useState(true);
	const connections = useAtomValue(connectionsAtom);
	const bundles = useAtomValue(connectionBundlesAtom(connKey));
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const folderId = detail?.project.id as FolderId | undefined;
	const worktreeId = detail?.session.worktreeId ?? null;
	// Plain derivation — see the React Compiler note in threads.tsx.
	const connection = optionsForConnection(connKey, connections);
	const messages = useAtomValue(
		sessionMessagesAtom(connectionSessionKey(connKey, normalizedSessionId)),
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
					headerBackVisible: false,
					headerLargeTitle: false,
					headerTitleStyle: { color: colors.fg },
				}}
			/>
			<Stack.Screen.Title>{reviewScopeLabel(scope)}</Stack.Screen.Title>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button
					icon="xmark"
					separateBackground
					onPress={() => router.back()}
				/>
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Menu icon="line.3.horizontal.decrease">
					{REVIEW_SCOPES.map((candidate) => (
						<Stack.Toolbar.MenuAction
							key={candidate}
							isOn={candidate === scope}
							onPress={() => setScope(candidate)}
						>
							{reviewScopeLabel(candidate)}
						</Stack.Toolbar.MenuAction>
					))}
				</Stack.Toolbar.Menu>
				<Stack.Toolbar.Button
					icon={
						allFilesExpanded
							? "arrow.down.right.and.arrow.up.left"
							: "arrow.up.left.and.arrow.down.right"
					}
					onPress={() => {
						setAllFilesExpanded((current) => !current);
						setAccordionKey((current) => current + 1);
					}}
				/>
			</Stack.Toolbar>
			<View
				collapsable={false}
				className="flex-1"
				style={{ paddingTop: headerHeight }}
			>
				{summary === null ? null : (
					<View className="h-8 items-center justify-center border-b border-border">
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
					</View>
				)}
				<ReviewDiffList
					summary={summary}
					patches={patches}
					loading={scope === "last_turn" ? false : review.loading}
					error={scope === "last_turn" ? null : review.error}
					refreshing={scope === "last_turn" ? false : review.refreshing}
					onRefresh={scope === "last_turn" ? undefined : review.refresh}
					accordionKey={accordionKey}
					allFilesExpanded={allFilesExpanded}
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
