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
import { GitBranch } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";

import { ReviewDiffList } from "~/components/diff/review-diff-list";
import { BranchStateBadge } from "~/components/home/branch-state-badge";
import { useWorkspaceReview } from "~/hooks/use-workspace-review";
import { cn } from "~/lib/cn";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { connectionSupports } from "~/lib/connection-records";
import { buildLastTurnReview } from "~/lib/last-turn-review";
import { useHeaderContentInset } from "~/lib/native-header";
import { branchStatePresentation } from "~/lib/pr-state-presentation";
import {
	type MobileReviewScope,
	REVIEW_SCOPES,
	reviewScopeLabel,
} from "~/lib/review-scope";
import { connectionSessionKey } from "~/lib/session-key";
import { promptText } from "~/lib/text-prompt";
import { useToolbarIcons } from "~/lib/toolbar-icons";
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
	const toolbarIcon = useToolbarIcons();
	const headerHeight = useHeaderContentInset();
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
	const fileCount = summary?.files.length ?? 0;
	const allSelected = fileCount > 0 && selectedPaths.size === fileCount;
	const headBranch = gitStatus?.branch ?? summary?.headRef ?? "Detached HEAD";
	const baseBranch =
		summary?.baseRef === headBranch ? null : (summary?.baseRef ?? null);
	const syncLabel = branchSyncLabel(
		gitStatus?.ahead ?? 0,
		gitStatus?.behind ?? 0,
	);
	const target = useMemo(
		() =>
			connection === null || folderId === undefined
				? null
				: { connection, folderId, worktreeId },
		[connection, folderId, worktreeId],
	);

	useEffect(() => {
		if (!target) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout>;
		const refresh = async () => {
			try {
				const value = await Effect.runPromise(loadGitPrState(target));
				if (active) setPrInfo(value);
			} catch {
				/* Keep the last successful observation during transient failures. */
			}
			if (active) timer = setTimeout(refresh, 60_000);
		};
		void refresh();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [target]);
	const refreshGit = useCallback(async () => {
		if (target === null) return;
		const [status, nextBranches] = await Promise.all([
			Effect.runPromise(loadGitStatus(target)),
			Effect.runPromise(loadGitBranches(target)),
		]);
		setGitStatus(status);
		setBranches(nextBranches);
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
		promptText({
			title: "Commit selected files",
			message: `${selectedPaths.size} file${selectedPaths.size === 1 ? "" : "s"} selected`,
			placeholder: "Commit message",
			confirmLabel: "Commit",
			onSubmit: (message) => {
				const trimmed = message.trim();
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
		});
	};

	const promptResetRemote = () => {
		if (target === null) return;
		void Effect.runPromise(previewGitResetRemote(target))
			.then((preview) => {
				promptText({
					title: "Reset to remote?",
					message: `${preview.changedPaths.length} paths and ${preview.commitsToDiscard.length} local commits will be discarded. Type ${preview.branch} to continue.`,
					placeholder: preview.branch,
					confirmLabel: "Reset",
					destructive: true,
					onSubmit: (value) => {
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
				});
			})
			.catch((cause) => setActionError(connectionErrorMessage(cause)));
	};

	const promptRevertAll = () => {
		if (target === null) return;
		promptText({
			title: "Revert every change?",
			message:
				"Uncommitted work will be permanently removed. Type REVERT to continue.",
			placeholder: "REVERT",
			confirmLabel: "Revert",
			destructive: true,
			onSubmit: (value) => {
				if (value !== "REVERT") return;
				void runMutation("Reverting", () =>
					Effect.runPromise(revertAllGitChanges(target)),
				);
			},
		});
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
					// The summary below names the branch and scope; a centered title
					// cannot fit beside the toolbar on phone-width sheets.
					headerTitle: "",
				}}
			/>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button
					icon={toolbarIcon("xmark")}
					separateBackground
					onPress={() => router.back()}
				/>
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Menu
					icon={toolbarIcon("arrow.triangle.branch")}
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
				<Stack.Toolbar.Menu icon={toolbarIcon("line.3.horizontal.decrease")}>
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
					icon={toolbarIcon(
						allFilesExpanded
							? "arrow.down.right.and.arrow.up.left"
							: "arrow.up.left.and.arrow.down.right",
					)}
					onPress={() => {
						setAllFilesExpanded((current) => !current);
						setAccordionKey((current) => current + 1);
					}}
				/>
				<Stack.Toolbar.Menu icon={toolbarIcon("ellipsis")}>
					{/* Menus only accept action elements, so no fragments here. */}
					{supportsRemoteGitActions ? (
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
					) : null}
					{supportsRemoteGitActions ? (
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
				<View className="gap-3 px-4 pb-3 pt-2">
					<View className="flex-row items-center gap-2">
						<GitBranch size={15} color={colors.secondaryFg} />
						<Text
							className="shrink font-sans-medium text-[15px] text-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{headBranch}
						</Text>
						{scope === "branch" && baseBranch !== null ? (
							<Text
								className="max-w-[40%] shrink font-sans text-[15px] text-muted-foreground"
								numberOfLines={1}
							>
								→ {baseBranch}
							</Text>
						) : null}
						<View className="flex-1" />
						{mutation === null ? (
							<BranchStateBadge state={branchStatePresentation(prInfo)} />
						) : (
							<View className="flex-row items-center gap-1.5">
								<ActivityIndicator size="small" color={colors.secondaryFg} />
								<Text className="font-sans text-[13px] text-muted-foreground">
									{mutation}…
								</Text>
							</View>
						)}
					</View>
					<View className="flex-row items-center gap-2">
						<Text
							className="min-w-0 flex-1 font-sans text-[13px] text-muted-foreground"
							numberOfLines={1}
							style={{ fontVariant: ["tabular-nums"] }}
						>
							{reviewScopeLabel(scope)} · {fileCount}{" "}
							{fileCount === 1 ? "file" : "files"}
							{summary === null ? null : (
								<>
									{"  "}
									<Text style={{ color: colors.diffAdded }}>
										+{summary.additions}
									</Text>{" "}
									<Text style={{ color: colors.diffRemoved }}>
										−{summary.deletions}
									</Text>
								</>
							)}
							{syncLabel === null ? null : `  ·  ${syncLabel}`}
						</Text>
						{fileCount > 0 ? (
							<Pressable
								accessibilityRole="button"
								hitSlop={10}
								onPress={() =>
									setSelectedPaths(
										allSelected
											? new Set()
											: new Set(summary?.files.map((file) => file.path) ?? []),
									)
								}
							>
								<Text className="font-sans-medium text-[13px] text-accent">
									{allSelected ? "Deselect all" : "Select all"}
								</Text>
							</Pressable>
						) : null}
					</View>
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						contentContainerStyle={{ gap: 8 }}
					>
						<GitAction
							label={
								selectedPaths.size === 0 || allSelected
									? "Commit"
									: `Commit ${selectedPaths.size}`
							}
							primary
							disabled={mutation !== null || selectedPaths.size === 0}
							onPress={promptCommit}
						/>
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
											: `Merge #${prInfo.number ?? ""}`.trim()
								}
								disabled={mutation !== null || prInfo.autoMergeEnabled}
								onPress={mergePullRequest}
							/>
						) : null}
					</ScrollView>
					{actionError === null ? null : (
						<Text selectable className="font-sans text-[13px] text-danger">
							{actionError}
						</Text>
					)}
					{summary?.files.some((file) => file.conflict) ? (
						<ScrollView
							horizontal
							showsHorizontalScrollIndicator={false}
							contentContainerStyle={{ gap: 8 }}
						>
							{summary.files
								.filter((file) => file.conflict)
								.map((file) => (
									<GitAction
										key={file.path}
										label={`Resolve ${file.path}`}
										tone="danger"
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
				<View
					className="bg-border"
					style={{ height: StyleSheet.hairlineWidth }}
				/>
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
			</View>
		</View>
	);
}

function branchSyncLabel(ahead: number, behind: number): string | null {
	if (ahead === 0 && behind === 0) return null;
	return [ahead > 0 ? `↑${ahead}` : null, behind > 0 ? `↓${behind}` : null]
		.filter((part) => part !== null)
		.join(" ");
}

function GitAction({
	label,
	disabled,
	onPress,
	primary = false,
	tone,
}: {
	label: string;
	disabled: boolean;
	onPress: () => void;
	primary?: boolean;
	tone?: "danger";
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled }}
			disabled={disabled}
			hitSlop={{ top: 6, bottom: 6 }}
			onPress={onPress}
			className={cn(
				"h-8 justify-center rounded-full px-3.5 active:opacity-70 disabled:opacity-40",
				primary
					? "bg-primary"
					: tone === "danger"
						? "bg-danger/12"
						: "bg-foreground/[0.06]",
			)}
		>
			<Text
				className={cn(
					"font-sans-medium text-[13px]",
					primary
						? "text-primary-foreground"
						: tone === "danger"
							? "text-danger"
							: "text-foreground",
				)}
				numberOfLines={1}
			>
				{label}
			</Text>
		</Pressable>
	);
}
