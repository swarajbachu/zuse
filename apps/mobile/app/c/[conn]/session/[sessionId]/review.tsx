import { useAtomValue } from "@effect/atom-react";
import { groupTimelineTurns } from "@zuse/client-runtime/timeline";
import type {
	FolderId,
	GitBranchInfo,
	GitPrInfo,
	GitReviewScope,
	GitStatusSummary,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";

import { ReviewDiffList } from "~/components/diff/review-diff-list";
import { useWorkspaceReview } from "~/hooks/use-workspace-review";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { connectionSupports } from "~/lib/connection-records";
import { buildLastTurnReview } from "~/lib/last-turn-review";
import {
	type MobileReviewScope,
	REVIEW_SCOPES,
	reviewScopeLabel,
} from "~/lib/review-scope";
import { connectionSessionKey } from "~/lib/session-key";
import {
	applyGitResetRemote,
	commitGitChanges,
	loadGitBranches,
	loadGitPrState,
	loadGitStatus,
	markGitPrReady,
	mergeGitPr,
	popGitStash,
	previewGitResetRemote,
	pullGitChanges,
	pushGitChanges,
	revertAllGitChanges,
	revertGitFile,
	stashGitChanges,
	switchGitBranch,
} from "~/rpc/actions";
import { allConnectionsAtom as connectionsAtom } from "~/store/connections";
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
	const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
	const [branches, setBranches] = useState<readonly GitBranchInfo[]>([]);
	const [prInfo, setPrInfo] = useState<GitPrInfo | null>(null);
	const [mutation, setMutation] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const connections = useAtomValue(connectionsAtom);
	const connectionRecord = connections.find((record) => record.key === connKey);
	const supportsRemoteGitActions = connectionSupports(
		connectionRecord,
		"git-remote-actions-v1",
	);
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
	const target = useMemo(
		() =>
			connection === null || folderId === undefined
				? null
				: { connection, folderId, worktreeId },
		[connection, folderId, worktreeId],
	);

	const refreshGit = useCallback(async () => {
		if (target === null) return;
		const [status, nextBranches, nextPrInfo] = await Promise.all([
			Effect.runPromise(loadGitStatus(target)),
			Effect.runPromise(loadGitBranches(target)),
			Effect.runPromise(loadGitPrState(target)).catch(() => null),
		]);
		setGitStatus(status);
		setBranches(nextBranches);
		setPrInfo(nextPrInfo);
	}, [target]);

	useEffect(() => {
		void refreshGit().catch((cause) =>
			setActionError(connectionErrorMessage(cause)),
		);
	}, [refreshGit]);

	useEffect(() => {
		if (summary === null) return;
		setSelectedPaths(new Set(summary.files.map((file) => file.path)));
	}, [summary]);

	const runMutation = async (
		label: string,
		operation: () => Promise<unknown>,
	) => {
		if (mutation !== null) return;
		setMutation(label);
		setActionError(null);
		try {
			await operation();
			await refreshGit();
			review.refresh();
		} catch (cause) {
			setActionError(connectionErrorMessage(cause));
		} finally {
			setMutation(null);
		}
	};

	const promptCommit = () => {
		if (target === null) return;
		if (selectedPaths.size === 0) {
			Alert.alert("Select files", "Choose at least one file to commit.");
			return;
		}
		Alert.prompt(
			"Commit selected files",
			`${selectedPaths.size} file${selectedPaths.size === 1 ? "" : "s"} selected`,
			(message) => {
				const trimmed = message?.trim() ?? "";
				if (trimmed.length === 0) return;
				void runMutation("Committing", () =>
					Effect.runPromise(
						commitGitChanges({
							...target,
							message: trimmed,
							paths: [...selectedPaths],
						}),
					),
				);
			},
			"plain-text",
		);
	};

	const promptResetRemote = () => {
		if (target === null) return;
		void Effect.runPromise(previewGitResetRemote(target))
			.then((preview) => {
				Alert.prompt(
					"Reset to remote?",
					`${preview.changedPaths.length} paths and ${preview.commitsToDiscard.length} local commits will be discarded. Type ${preview.branch} to continue.`,
					(value) => {
						if (value !== preview.branch) {
							Alert.alert("Branch name did not match", "Nothing was changed.");
							return;
						}
						void runMutation("Resetting", () =>
							Effect.runPromise(
								applyGitResetRemote({
									...target,
									preview,
									confirmationBranch: value,
								}),
							),
						);
					},
					"plain-text",
				);
			})
			.catch((cause) => setActionError(connectionErrorMessage(cause)));
	};

	const promptRevertAll = () => {
		if (target === null) return;
		Alert.prompt(
			"Revert every change?",
			"Uncommitted work will be permanently removed. Type REVERT to continue.",
			(value) => {
				if (value !== "REVERT") return;
				void runMutation("Reverting", () =>
					Effect.runPromise(revertAllGitChanges(target)),
				);
			},
			"plain-text",
		);
	};

	const promptRevertSelected = () => {
		if (target === null || summary === null || selectedPaths.size !== 1) return;
		const path = [...selectedPaths][0];
		const file = summary.files.find((candidate) => candidate.path === path);
		if (file === undefined || !file.hasUncommittedChanges) return;
		Alert.alert("Revert this file?", file.path, [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Revert",
				style: "destructive",
				onPress: () =>
					void runMutation("Reverting", () =>
						Effect.runPromise(
							revertGitFile({
								...target,
								change: {
									path: file.path,
									oldPath: file.oldPath,
									kind: file.kind,
								},
							}),
						),
					),
			},
		]);
	};

	const mergePullRequest = () => {
		if (target === null || prInfo === null || prInfo.state !== "open") return;
		if (prInfo.isDraft) {
			Alert.alert("Draft pull request", "Mark it ready before merging.");
			return;
		}
		if (prInfo.mergeable !== "clean") {
			Alert.alert(
				"Merge is blocked",
				prInfo.mergeable === "conflicting"
					? "Resolve merge conflicts first."
					: "The host has not confirmed this pull request is mergeable yet.",
			);
			return;
		}
		if (prInfo.checks === "failure") {
			Alert.alert("Checks are failing", "Fix failing checks before merging.");
			return;
		}
		const auto = prInfo.checks === "pending";
		Alert.alert(
			auto ? "Enable auto-merge?" : "Merge pull request?",
			auto
				? "Required checks are still running. The pull request will merge after they pass."
				: "This uses squash merge and keeps the branch.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: auto ? "Enable auto-merge" : "Merge",
					onPress: () =>
						void runMutation(auto ? "Enabling auto-merge" : "Merging", () =>
							Effect.runPromise(
								mergeGitPr({
									...target,
									action: auto ? "enable-auto" : "merge",
									method: "squash",
								}),
							),
						),
				},
			],
		);
	};

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
				<Stack.Toolbar.Menu
					icon="arrow.triangle.branch"
					disabled={mutation !== null}
				>
					{branches.map((branch) => (
						<Stack.Toolbar.MenuAction
							key={`${branch.kind}:${branch.name}`}
							isOn={branch.current}
							onPress={() => {
								if (target === null || branch.current) return;
								void runMutation("Switching branch", () =>
									Effect.runPromise(
										switchGitBranch({
											...target,
											branch: branch.name,
											remote: branch.remote,
										}),
									),
								);
							}}
						>
							{branch.name}
						</Stack.Toolbar.MenuAction>
					))}
				</Stack.Toolbar.Menu>
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
				<Stack.Toolbar.Menu icon="ellipsis">
					{supportsRemoteGitActions ? (
						<>
							<Stack.Toolbar.MenuAction
								disabled={mutation !== null}
								onPress={() =>
									target === null
										? undefined
										: void runMutation("Stashing", () =>
												Effect.runPromise(stashGitChanges(target)),
											)
								}
							>
								Stash changes
							</Stack.Toolbar.MenuAction>
							<Stack.Toolbar.MenuAction
								disabled={mutation !== null}
								onPress={() =>
									target === null
										? undefined
										: void runMutation("Applying stash", () =>
												Effect.runPromise(popGitStash(target)),
											)
								}
							>
								Stash pop
							</Stack.Toolbar.MenuAction>
						</>
					) : null}
					<Stack.Toolbar.MenuAction
						disabled={selectedPaths.size !== 1 || mutation !== null}
						onPress={promptRevertSelected}
					>
						Revert selected file
					</Stack.Toolbar.MenuAction>
					{supportsRemoteGitActions ? (
						<Stack.Toolbar.MenuAction
							disabled={mutation !== null}
							onPress={promptResetRemote}
						>
							Reset to remote…
						</Stack.Toolbar.MenuAction>
					) : null}
					<Stack.Toolbar.MenuAction
						disabled={mutation !== null}
						onPress={promptRevertAll}
					>
						Revert all…
					</Stack.Toolbar.MenuAction>
				</Stack.Toolbar.Menu>
			</Stack.Toolbar>
			<View
				collapsable={false}
				className="flex-1"
				style={{ paddingTop: headerHeight }}
			>
				<View className="border-b border-border bg-card px-3 py-2">
					<View className="flex-row items-center gap-2">
						<View className="min-w-0 flex-1">
							<Text
								className="font-sans-medium text-sm text-foreground"
								numberOfLines={1}
							>
								{gitStatus?.branch ?? "Detached HEAD"}
							</Text>
							<Text className="font-mono text-[11px] text-muted-foreground">
								{gitStatus?.dirtyFiles ?? 0} changed · ↑{gitStatus?.ahead ?? 0}{" "}
								↓{gitStatus?.behind ?? 0}
							</Text>
						</View>
						{mutation === null ? null : (
							<ActivityIndicator size="small" color={colors.accent} />
						)}
					</View>
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						contentContainerStyle={{ gap: 8, paddingTop: 8 }}
					>
						<GitAction
							label="Commit"
							disabled={mutation !== null}
							onPress={promptCommit}
						/>
						{prInfo?.state === "open" && prInfo.isDraft ? (
							<GitAction
								label="Mark ready"
								disabled={mutation !== null}
								onPress={() =>
									target === null
										? undefined
										: void runMutation("Marking ready", () =>
												Effect.runPromise(markGitPrReady(target)),
											)
								}
							/>
						) : null}
						{prInfo?.state === "open" ? (
							<GitAction
								label={
									prInfo.autoMergeEnabled
										? "Auto-merge on"
										: prInfo.checks === "pending"
											? "Auto-merge"
											: "Merge PR"
								}
								disabled={mutation !== null || prInfo.autoMergeEnabled}
								onPress={mergePullRequest}
							/>
						) : null}
						{supportsRemoteGitActions ? (
							<GitAction
								label="Pull"
								disabled={mutation !== null}
								onPress={() =>
									target === null
										? undefined
										: void runMutation("Pulling", () =>
												Effect.runPromise(pullGitChanges(target)),
											)
								}
							/>
						) : null}
						<GitAction
							label="Push"
							disabled={mutation !== null}
							onPress={() =>
								target === null
									? undefined
									: void runMutation("Pushing", () =>
											Effect.runPromise(pushGitChanges(target)),
										)
							}
						/>
						<GitAction
							label={`${selectedPaths.size}/${summary?.files.length ?? 0} selected`}
							disabled={false}
							onPress={() =>
								setSelectedPaths(
									selectedPaths.size === (summary?.files.length ?? 0)
										? new Set()
										: new Set(summary?.files.map((file) => file.path) ?? []),
								)
							}
						/>
					</ScrollView>
					{prInfo !== null && prInfo.state !== "none" ? (
						<Text className="pt-2 font-sans text-[12px] text-muted-foreground">
							PR #{prInfo.number ?? "—"} · {prInfo.state} · checks{" "}
							{prInfo.checks}
						</Text>
					) : null}
					{actionError === null ? null : (
						<Text selectable className="pt-2 font-sans text-xs text-danger">
							{actionError}
						</Text>
					)}
					{summary?.files.some((file) => file.conflict) ? (
						<ScrollView
							horizontal
							showsHorizontalScrollIndicator={false}
							contentContainerStyle={{ gap: 8, paddingTop: 8 }}
						>
							{summary.files
								.filter((file) => file.conflict)
								.map((file) => (
									<GitAction
										key={file.path}
										label={`Resolve ${file.path}`}
										disabled={mutation !== null}
										onPress={() =>
											router.push({
												pathname:
													"/c/[conn]/session/[sessionId]/resolve-conflict",
												params: {
													conn: connKey,
													sessionId: normalizedSessionId,
													path: file.path,
													oldPath: file.oldPath ?? "",
												},
											})
										}
									/>
								))}
						</ScrollView>
					) : null}
				</View>
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
					selectedPaths={selectedPaths}
					onToggleSelection={(path) =>
						setSelectedPaths((current) => {
							const next = new Set(current);
							if (next.has(path)) next.delete(path);
							else next.add(path);
							return next;
						})
					}
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

function GitAction({
	label,
	disabled,
	onPress,
}: {
	label: string;
	disabled: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			disabled={disabled}
			onPress={onPress}
			className="min-h-11 justify-center rounded-xl border border-border bg-background px-3 disabled:opacity-50"
		>
			<Text className="font-sans-medium text-xs text-foreground">{label}</Text>
		</Pressable>
	);
}
