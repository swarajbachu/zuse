import { formatDate as formatUiDate } from "@zuse/i18n";
import { isInputComposing } from "../lib/input-composition.ts";
import { openExternal } from "../lib/platform-capabilities.ts";
import { feedbackDestination } from "../lib/pr-feedback-navigation.ts";
import { GitHubAvatar } from "./github-avatar.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type {
	CodeAnnotation,
	FolderId,
	GitChangeKind,
	GitPrComment,
	GitPrReview,
	GitReviewFile,
	GitReviewPatch,
	WorktreeId,
} from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowDown01Icon,
	ArrowUpRight01Icon,
	FolderTreeIcon,
	GitBranchIcon,
	ListViewIcon,
	Loading02Icon,
	MinusSignIcon,
	Search01Icon,
	Tick02Icon,
	Upload01Icon,
} from "@zuse/icons/solid-rounded";
import { FileWarning, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import {
	buildChangesTree,
	filterChangedFiles,
	flattenChangesTree,
} from "../lib/changes-tree.ts";
import {
	dispatchGitWorkspaceCommand,
	refreshGitPrDetails,
	refreshGitReview,
	refreshGitWorkspace,
	useGitChangesResource,
	useGitPrDetailsResource,
	useGitReviewResource,
	useGitWorkspaceResource,
} from "../lib/git-workspace-client-bus.ts";
import { useAnnotationsStore } from "../store/annotations.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { type ChangesListMode, useUiStore } from "../store/ui.ts";
import {
	REVIEW_VIEWED_STORAGE_KEY,
	reviewFingerprint,
} from "./changes-review.tsx";
import { DiffStat } from "./dock-panel/diff-stat.tsx";
import { DockDisclosureSection } from "./dock-panel/section.tsx";
import {
	DOCK_HOVER_REVEAL_CLASS,
	DOCK_ICON_BUTTON_CLASS,
	DOCK_META_CLASS,
} from "./dock-panel/text.ts";
import { FileIcon } from "./file-icon.tsx";
import { GitInitCta } from "./git-init-cta.tsx";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { SegmentedTabs } from "./ui/segmented-tabs.tsx";

const basename = (path: string): string => {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
};

/** Long change lists get a permanent filter instead of a toggle. */
const FILTER_ALWAYS_VISIBLE_AT = 20;
const EMPTY_REVIEW_PATCHES: Readonly<Record<string, GitReviewPatch>> = {};
type RevertRequest =
	| { readonly type: "all" }
	| {
			readonly type: "file";
			readonly path: string;
			readonly kind: GitChangeKind;
			readonly oldPath: string | null;
	  };

/**
 * Right-pane "Changes" tab. Combines the working-tree change list (with a
 * real commit composer at the bottom) and, when a PR is open, the PR's
 * files-changed list. Clicking any file opens it in the main file editor —
 * same flow as the file tree. Worktree-aware: every store lookup and RPC
 * call is keyed by `(folderId, worktreeId)` so a session running inside a
 * worktree sees its own branch's changes, not the main checkout.
 */
export function DiffPane({
	executionRef,
}: {
	executionRef: ExecutionRef | null;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const workspaceView = useGitWorkspaceResource(executionRef, "connect");
	const workspace = workspaceView.data;
	const changesView = useGitChangesResource(executionRef, "connect");
	const reviewView = useGitReviewResource(executionRef, "connect");
	const prDetailsView = useGitPrDetailsResource(executionRef, "connect");
	const status = workspace?.status ?? null;
	const changes = changesView.data?.changes ?? null;
	const changesErrorTag = changesView.data?.error?.tag ?? null;
	const review = reviewView.data?.summary ?? null;
	const reviewLoading = reviewView.sync === "synchronizing";
	const reviewPatches = reviewView.data?.patches ?? EMPTY_REVIEW_PATCHES;
	const prDetails = prDetailsView.data?.details ?? null;
	const folderId = executionRef?.folderId ?? null;
	const worktreeId = executionRef?.worktreeId ?? null;
	const openChanges = useUiStore((s) => s.openChanges);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const annotationsBySession = useAnnotationsStore((s) => s.bySession);
	const comments = useMemo(
		() =>
			selectedSessionId === null
				? []
				: (annotationsBySession[selectedSessionId] ?? []).filter(
						(entry): entry is CodeAnnotation => !("_tag" in entry),
					),
		[annotationsBySession, selectedSessionId, uiMessage],
	);
	const updateComment = useAnnotationsStore((s) => s.updateComment);
	const removeComment = useAnnotationsStore((s) => s.remove);

	// Paths the user has unchecked for the next commit (see `committable` below).
	const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
	const [revertRequest, setRevertRequest] = useState<RevertRequest | null>(
		null,
	);
	const [revertBusy, setRevertBusy] = useState(false);
	const [navigatorTab, setNavigatorTab] = useState<"files" | "comments">(
		"files",
	);
	const [filterOpen, setFilterOpen] = useState(false);
	const [filterQuery, setFilterQuery] = useState("");
	const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const listMode = useUiStore((s) => s.changesListMode);
	const setListMode = useUiStore((s) => s.setChangesListMode);
	const [viewedRevision, setViewedRevision] = useState(0);
	useEffect(() => {
		const refreshViewed = () => setViewedRevision((value) => value + 1);
		window.addEventListener("zuse-review-viewed", refreshViewed);
		return () =>
			window.removeEventListener("zuse-review-viewed", refreshViewed);
	}, []);

	if (executionRef === null || folderId === null) {
		return (
			<Indicator
				title={uiMessage("projects:diff_pane_no_project_selected")}
				body="Select a project to view its changed files."
			/>
		);
	}

	const refreshAll = () =>
		Promise.all([
			refreshGitWorkspace(executionRef),
			refreshGitReview(executionRef),
			refreshGitPrDetails(executionRef),
		]).then(() => undefined);

	const tracked = (changes ?? []).filter(
		(c) =>
			c.kind !== "untracked" && c.kind !== "ignored" && c.kind !== "unmerged",
	);
	const untracked = (changes ?? []).filter((c) => c.kind === "untracked");

	const requestRevertAll = () => setRevertRequest({ type: "all" });

	const confirmRevert = async () => {
		const request = revertRequest;
		if (request === null || revertBusy) return;
		setRevertBusy(true);
		try {
			if (request.type === "all") {
				await dispatchGitWorkspaceCommand({
					ref: executionRef,
					kind: "git.revertAll",
					commandId: CommandId.make(`git-revert-all:${crypto.randomUUID()}`),
					payload: { folderId, worktreeId },
				});
			} else {
				await dispatchGitWorkspaceCommand({
					ref: executionRef,
					kind: "git.revertFile",
					commandId: CommandId.make(`git-revert:${crypto.randomUUID()}`),
					payload: {
						folderId,
						worktreeId,
						path: request.path,
						oldPath: request.oldPath,
						kind: request.kind,
					},
				});
			}
			setRevertRequest(null);
			await refreshAll();
		} catch (err) {
			window.alert(`Couldn't revert: ${formatErr(err)}`);
		} finally {
			setRevertBusy(false);
		}
	};

	// Which files are included in the next commit. We track an *exclude* set
	// (paths the user unchecked) so newly-appeared files default to selected and
	// the selection survives resource invalidations without re-adding every path.
	const committable = [...tracked, ...untracked];
	const committablePaths = committable.map((c) => c.path);
	const selectedEntries = committable.filter((c) => !excluded.has(c.path));
	const selectedCount = selectedEntries.length;
	// The pathspec handed to `git commit` — renames need their old path too so
	// the deletion side of the move lands in the same commit.
	const commitPaths = selectedEntries.flatMap((c) =>
		c.oldPath !== null && c.oldPath !== c.path ? [c.path, c.oldPath] : [c.path],
	);
	const allSelected =
		committablePaths.length > 0 && selectedCount === committablePaths.length;
	const someSelected = selectedCount > 0 && !allSelected;
	const reviewFiles = review?.files ?? [];
	const conflictFiles = reviewFiles.filter((file) => file.conflict);
	const changedFiles = reviewFiles.filter((file) => !file.conflict);
	const pullRequestFeedback = [
		...(prDetails?.reviews ?? []).filter(
			(review) => review.body.trim().length > 0,
		),
		...(prDetails?.comments ?? []),
	];
	const viewedEntries = (() => {
		void viewedRevision;
		try {
			return JSON.parse(
				localStorage.getItem(REVIEW_VIEWED_STORAGE_KEY) ?? "{}",
			) as Record<string, string>;
		} catch {
			return {};
		}
	})();
	const reviewKey = `${executionRef.environmentId}:${folderId}:${worktreeId ?? "main"}`;
	const viewedPaths = new Set(
		(review?.files ?? [])
			.filter((file) => {
				const patch = reviewPatches[file.path]?.result.patch ?? "";
				return (
					viewedEntries[`${reviewKey}:${file.path}`] ===
					reviewFingerprint(patch)
				);
			})
			.map((file) => file.path),
	);
	const nextUnviewed = (review?.files ?? []).find(
		(file) => !viewedPaths.has(file.path),
	);

	const alwaysShowFilter = reviewFiles.length > FILTER_ALWAYS_VISIBLE_AT;
	const showFilter = alwaysShowFilter || filterOpen;
	const visibleConflicts = filterChangedFiles(conflictFiles, filterQuery);
	const visibleChanges = filterChangedFiles(changedFiles, filterQuery);
	const toggleFolder = (path: string) =>
		setCollapsedFolders((previous) => {
			const next = new Set(previous);
			if (!next.delete(path)) next.add(path);
			return next;
		});

	const toggleAll = () =>
		setExcluded(allSelected ? new Set(committablePaths) : new Set());

	const onAfterCommit = async () => {
		setExcluded(new Set());
		await refreshAll();
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-11 shrink-0 items-center gap-1 px-3">
				<SegmentedTabs
					value={navigatorTab}
					onValueChange={setNavigatorTab}
					ariaLabel={uiMessage("projects:diff_pane_changed_files")}
					equalWidth={false}
					options={[
						{
							value: "files",
							label: (
								<>
									{uiMessage("projects:diff_pane_files")}
									<span className="tabular-nums text-muted-foreground">
										{review?.files.length ?? 0}
									</span>
								</>
							),
						},
						{
							value: "comments",
							label: (
								<>
									{uiMessage("projects:github_comments")}
									<span className="tabular-nums text-muted-foreground">
										{comments.length + pullRequestFeedback.length}
									</span>
								</>
							),
						},
					]}
				/>
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					{navigatorTab === "files" && reviewFiles.length > 0 ? (
						<>
							<button
								type="button"
								aria-pressed={listMode === "tree"}
								aria-label={
									listMode === "tree"
										? uiMessage("projects:diff_pane_list_view")
										: uiMessage("projects:diff_pane_tree_view")
								}
								title={
									listMode === "tree"
										? uiMessage("projects:diff_pane_list_view")
										: uiMessage("projects:diff_pane_tree_view")
								}
								onClick={() =>
									setListMode(listMode === "tree" ? "list" : "tree")
								}
								className={DOCK_ICON_BUTTON_CLASS}
							>
								<HugeiconsIcon
									icon={listMode === "tree" ? ListViewIcon : FolderTreeIcon}
									className="size-4"
								/>
							</button>
							{alwaysShowFilter ? null : (
								<button
									type="button"
									aria-pressed={filterOpen}
									aria-label={uiMessage("projects:diff_pane_filter_files")}
									title={uiMessage("projects:diff_pane_filter_files")}
									onClick={() => {
										if (filterOpen) setFilterQuery("");
										setFilterOpen(!filterOpen);
									}}
									className={cn(
										DOCK_ICON_BUTTON_CLASS,
										filterOpen && "bg-muted text-foreground",
									)}
								>
									<HugeiconsIcon icon={Search01Icon} className="size-4" />
								</button>
							)}
						</>
					) : null}
					<button
						type="button"
						onClick={() =>
							openChanges(nextUnviewed?.path ?? review?.files[0]?.path ?? null)
						}
						className="flex h-7 items-center rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					>
						{nextUnviewed === undefined
							? uiMessage("projects:diff_pane_open_review")
							: uiMessage("projects:diff_pane_next_unviewed")}
					</button>
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden text-xs">
				{navigatorTab === "files" ? (
					<>
						{review !== null && reviewFiles.length > 0 ? (
							<div
								className={cn(
									"flex h-6 shrink-0 items-center gap-2 px-3.5",
									DOCK_META_CLASS,
								)}
							>
								<span className="min-w-0 truncate">
									{review.baseRef === null
										? uiMessage("projects:diff_pane_compared_with_head")
										: uiMessage("projects:diff_pane_base", {
												value1: String(review.baseRef),
											})}
									{uiMessage("projects:diff_pane_viewed", {
										value1: String(viewedPaths.size),
										value2: String(review.files.length),
									})}
								</span>
								<DiffStat
									additions={review.additions}
									deletions={review.deletions}
									className="ml-auto"
								/>
							</div>
						) : null}
						{showFilter && reviewFiles.length > 0 ? (
							<div className="shrink-0 px-3 pb-1 pt-1.5">
								<input
									// biome-ignore lint/a11y/noAutofocus: the filter only mounts on explicit request.
									autoFocus={filterOpen}
									value={filterQuery}
									onChange={(event) => setFilterQuery(event.target.value)}
									onKeyDown={(event) => {
										if (event.key !== "Escape") return;
										setFilterQuery("");
										setFilterOpen(false);
									}}
									placeholder={uiMessage("projects:diff_pane_filter_files")}
									aria-label={uiMessage("projects:diff_pane_filter_files")}
									className="h-7 w-full rounded-md bg-muted/50 px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/60"
								/>
							</div>
						) : null}
						<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
							{changesErrorTag === "GitNotARepoError" ? (
								<div className="py-3">
									<GitInitCta executionRef={executionRef} />
								</div>
							) : reviewLoading && review === null ? (
								<Indicator
									title={uiMessage("projects:diff_pane_loading_changes")}
									loading
								/>
							) : reviewFiles.length === 0 ? (
								<Indicator
									title={uiMessage("projects:diff_pane_no_changes")}
									body="Your branch is up to date with its base."
								/>
							) : visibleConflicts.length + visibleChanges.length === 0 ? (
								<Indicator
									title={uiMessage("projects:diff_pane_no_matching_files")}
								/>
							) : (
								<div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-0.5">
									{visibleConflicts.length > 0 ? (
										<>
											<NavigatorHeader
												title={uiMessage("projects:diff_pane_merge_changes")}
												count={visibleConflicts.length}
												conflict
											/>
											<ChangedFilesList
												files={visibleConflicts}
												mode={listMode}
												viewed={viewedPaths}
												collapsed={collapsedFolders}
												onToggleFolder={toggleFolder}
												onSelect={openChanges}
												conflict
											/>
											{visibleChanges.length > 0 ? (
												<NavigatorHeader
													title={uiMessage("projects:diff_pane_changes")}
													count={visibleChanges.length}
												/>
											) : null}
										</>
									) : null}
									<ChangedFilesList
										files={visibleChanges}
										mode={listMode}
										viewed={viewedPaths}
										collapsed={collapsedFolders}
										onToggleFolder={toggleFolder}
										onSelect={openChanges}
										conflict={false}
									/>
								</div>
							)}
						</div>
					</>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto">
						{selectedSessionId === null && pullRequestFeedback.length === 0 ? (
							<Indicator
								title={uiMessage("projects:diff_pane_no_active_chat")}
								body="Open a chat session to create and manage review comments."
							/>
						) : comments.length === 0 && pullRequestFeedback.length === 0 ? (
							<Indicator
								title={uiMessage("projects:diff_pane_no_comments_yet")}
								body="Select lines in All changes to add one."
							/>
						) : (
							<>
								{comments.length > 0 ? (
									<DockDisclosureSection
										label={uiMessage("projects:diff_pane_annotations_for_ai")}
										count={comments.length}
										className="first:border-t-0"
									>
										<ul className="flex flex-col gap-0.5">
											{comments.map((comment) => (
												<li key={comment.id} className="group relative">
													<button
														type="button"
														onClick={() =>
															openChanges(
																comment.relPath,
																comment.diffAnchorLine ?? comment.startLine,
																comment.diffSide ?? null,
															)
														}
														className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
													>
														<span className="block truncate pr-12 font-mono text-[11px] text-muted-foreground">
															{comment.relPath}:{comment.startLine}
														</span>
														<span className="mt-0.5 line-clamp-2 block text-foreground/90">
															{comment.comment}
														</span>
													</button>
													<div
														className={cn(
															"absolute -right-1 top-1 flex gap-0.5",
															DOCK_HOVER_REVEAL_CLASS,
														)}
													>
														<button
															type="button"
															aria-label={uiMessage(
																"projects:diff_pane_edit_comment",
															)}
															title={uiMessage(
																"projects:diff_pane_edit_comment",
															)}
															className={cn(DOCK_ICON_BUTTON_CLASS, "size-6")}
															onClick={() => {
																if (selectedSessionId === null) return;
																const next = window.prompt(
																	"Edit review comment",
																	comment.comment,
																);
																if (next !== null)
																	updateComment(
																		selectedSessionId,
																		comment.id,
																		next,
																	);
															}}
														>
															<Pencil className="size-3" />
														</button>
														<button
															type="button"
															aria-label={uiMessage(
																"projects:diff_pane_delete_comment",
															)}
															title={uiMessage(
																"projects:diff_pane_delete_comment",
															)}
															className={cn(
																DOCK_ICON_BUTTON_CLASS,
																"size-6 hover:text-destructive",
															)}
															onClick={() => {
																if (selectedSessionId === null) return;
																if (
																	window.confirm("Delete this review comment?")
																)
																	removeComment(selectedSessionId, comment.id);
															}}
														>
															<Trash2 className="size-3" />
														</button>
													</div>
												</li>
											))}
										</ul>
									</DockDisclosureSection>
								) : null}
								{pullRequestFeedback.length > 0 ? (
									<DockDisclosureSection
										label={uiMessage(
											"projects:diff_pane_pull_request_feedback",
										)}
										count={pullRequestFeedback.length}
										className="first:border-t-0"
									>
										<ul className="flex flex-col gap-0.5">
											{pullRequestFeedback.map((feedback, index) => (
												<ExternalFeedbackCard
													key={`${feedback.author}:${index}`}
													feedback={feedback}
												/>
											))}
										</ul>
									</DockDisclosureSection>
								) : null}
							</>
						)}
					</div>
				)}
			</div>

			<CommitComposer
				environmentId={executionRef.environmentId}
				folderId={folderId}
				worktreeId={worktreeId}
				rootPath={executionRef.rootPath}
				branch={status?.branch ?? null}
				ahead={status?.ahead ?? 0}
				paths={commitPaths}
				selectedCount={selectedCount}
				totalCount={committablePaths.length}
				allSelected={allSelected}
				someSelected={someSelected}
				onToggleAll={toggleAll}
				onDiscardAll={requestRevertAll}
				canPush={(status?.ahead ?? 0) > 0}
				onAfterCommit={onAfterCommit}
				onAfterPush={refreshAll}
			/>
			<RevertChangesDialog
				request={revertRequest}
				busy={revertBusy}
				onOpenChange={(open) => {
					if (!open && !revertBusy) setRevertRequest(null);
				}}
				onConfirm={() => void confirmRevert()}
			/>
		</div>
	);
}

function RevertChangesDialog({
	request,
	busy,
	onOpenChange,
	onConfirm,
}: {
	request: RevertRequest | null;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const isFile = request?.type === "file";
	const isUntracked = isFile && request.kind === "untracked";
	const title =
		request?.type === "all"
			? "Revert all changes?"
			: isUntracked
				? "Delete untracked file?"
				: "Revert file changes?";
	const description =
		request?.type === "all"
			? "This discards every uncommitted change and deletes untracked files. This cannot be undone."
			: isUntracked
				? `"${basename(request.path)}" will be removed from disk. This cannot be undone.`
				: request !== null
					? `Uncommitted changes in "${basename(request.path)}" will be discarded. This cannot be undone.`
					: "";
	const actionLabel =
		request?.type === "all"
			? "Revert all"
			: isUntracked
				? "Delete file"
				: "Revert file";

	return (
		<AlertDialog open={request !== null} onOpenChange={onOpenChange}>
			<AlertDialogPopup className="max-w-sm">
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={
							<Button type="button" variant="ghost" disabled={busy}>
								{uiMessage("common:cancel")}
							</Button>
						}
					/>
					<Button
						type="button"
						variant="destructive"
						disabled={busy}
						onClick={onConfirm}
					>
						{busy ? uiMessage("projects:diff_pane_reverting") : actionLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}

const fileStatusFor = (
	kind: GitChangeKind,
): { readonly label: string; readonly className: string } => {
	switch (kind) {
		case "added":
		case "copied":
		case "untracked":
			return { label: "A", className: "text-[var(--accent-green)]" };
		case "deleted":
			return { label: "D", className: "text-[var(--accent-red)]" };
		case "renamed":
			return { label: "R", className: "text-sky-500" };
		default:
			return { label: "M", className: "text-[var(--accent-amber)]" };
	}
};

function NavigatorHeader({
	title,
	count,
	conflict = false,
}: {
	readonly title: string;
	readonly count: number;
	readonly conflict?: boolean;
}) {
	return (
		<div className="flex h-8 items-center gap-1.5 px-3.5 pt-1">
			{conflict ? (
				<FileWarning className="size-3.5 text-[var(--accent-red)]" />
			) : null}
			<span
				className={cn(
					"text-xs font-medium",
					conflict ? "text-foreground" : "text-muted-foreground",
				)}
			>
				{title}
			</span>
			<span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
				{count}
			</span>
		</div>
	);
}

/** Feedback from GitHub reviewers, as a quiet row that jumps to its source. */
export function ExternalFeedbackCard({
	feedback,
}: {
	readonly feedback: GitPrComment | GitPrReview;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const openChanges = useUiStore((s) => s.openChanges);
	const destination = feedbackDestination(feedback);
	const navigate = () => {
		if (destination?.kind === "file")
			openChanges(destination.path, destination.line);
		else if (destination?.kind === "thread") void openExternal(destination.url);
	};
	const timestamp =
		"createdAt" in feedback ? feedback.createdAt : feedback.submittedAt;
	return (
		<li className="group -mx-2 rounded-md px-2 py-2 transition-colors hover:bg-muted/40">
			{/* biome-ignore lint/a11y/useSemanticElements: this card contains links and buttons, which cannot be nested in an anchor. */}
			<div
				role="link"
				aria-disabled={!destination}
				tabIndex={destination ? 0 : -1}
				className={
					destination
						? "cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						: undefined
				}
				onClick={(event) => {
					if (
						(event.target as Element).closest(
							"a,button,input,textarea,summary,[role=button]",
						)
					)
						return;
					if (window.getSelection()?.toString()) return;
					navigate();
				}}
				onKeyDown={(event) => {
					if (
						event.target !== event.currentTarget ||
						(event.key !== "Enter" && event.key !== " ")
					)
						return;
					event.preventDefault();
					navigate();
				}}
			>
				<div className="flex h-6 items-center gap-1.5">
					<GitHubAvatar
						name={feedback.author}
						url={feedback.authorAvatarUrl}
						className="size-4"
					/>
					<span className="min-w-0 truncate text-xs font-medium text-foreground">
						{feedback.author || uiMessage("projects:diff_pane_unknown_author")}
					</span>
					{timestamp !== null ? (
						<time className={cn("shrink-0", DOCK_META_CLASS)}>
							{formatUiDate(timestamp, {
								month: "short",
								day: "numeric",
							})}
						</time>
					) : null}
					{feedback.url ? (
						<button
							type="button"
							aria-label={uiMessage("projects:github_open_github")}
							title={uiMessage("projects:github_open_github")}
							className={cn(
								DOCK_ICON_BUTTON_CLASS,
								"ml-auto size-6",
								DOCK_HOVER_REVEAL_CLASS,
							)}
							onClick={() => {
								if (feedback.url) void openExternal(feedback.url);
							}}
						>
							<HugeiconsIcon icon={ArrowUpRight01Icon} className="size-3.5" />
						</button>
					) : null}
				</div>
				{"path" in feedback && feedback.path ? (
					<div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
						{feedback.path}
						{feedback.line ? `:${feedback.line}` : ""}
					</div>
				) : null}
				<MarkdownBody githubHtml className="mt-1 text-xs leading-5">
					{feedback.body}
				</MarkdownBody>
			</div>
		</li>
	);
}

const ROW_BASE_PADDING_PX = 8;
const TREE_INDENT_PX = 12;
/** Chevron width + gap, so file icons line up under their folder's icon. */
const TREE_CHEVRON_SPACE_PX = 18;

function ChangedFilesList({
	files,
	mode,
	viewed,
	collapsed,
	onToggleFolder,
	onSelect,
	conflict,
}: {
	readonly files: readonly GitReviewFile[];
	readonly mode: ChangesListMode;
	readonly viewed: ReadonlySet<string>;
	readonly collapsed: ReadonlySet<string>;
	readonly onToggleFolder: (path: string) => void;
	readonly onSelect: (path: string) => void;
	readonly conflict: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const tree = useMemo(
		() => (mode === "tree" ? buildChangesTree(files) : null),
		[files, mode],
	);
	if (files.length === 0) return null;
	const label = conflict
		? uiMessage("projects:diff_pane_files_with_merge_conflicts")
		: uiMessage("projects:diff_pane_changed_files");
	if (tree === null) {
		return (
			<ul aria-label={label} className="px-1.5">
				{files.map((file) => (
					<li key={file.path}>
						<ChangedFileRow
							file={file}
							name={basename(file.path)}
							showDirectory
							indent={ROW_BASE_PADDING_PX}
							viewed={viewed.has(file.path)}
							conflict={conflict}
							onSelect={onSelect}
						/>
					</li>
				))}
			</ul>
		);
	}
	return (
		<ul aria-label={label} className="px-1.5">
			{flattenChangesTree(tree, collapsed).map((node) => {
				const indent = ROW_BASE_PADDING_PX + node.depth * TREE_INDENT_PX;
				if (node.type === "file") {
					return (
						<li key={node.path}>
							<ChangedFileRow
								file={node.file}
								name={node.name}
								showDirectory={false}
								indent={indent + TREE_CHEVRON_SPACE_PX}
								viewed={viewed.has(node.path)}
								conflict={conflict}
								onSelect={onSelect}
							/>
						</li>
					);
				}
				const open = !collapsed.has(node.path);
				return (
					<li key={`folder:${node.path}`}>
						<button
							type="button"
							aria-expanded={open}
							onClick={() => onToggleFolder(node.path)}
							style={{ paddingLeft: indent }}
							className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
						>
							<HugeiconsIcon
								icon={ArrowDown01Icon}
								className={cn(
									"size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150",
									!open && "-rotate-90",
								)}
							/>
							<FileIcon name={node.name} kind="directory" expanded={open} />
							<span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
								{node.name}
							</span>
							{open ? null : (
								<DiffStat
									additions={node.additions}
									deletions={node.deletions}
									className="text-[10px]"
								/>
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function ChangedFileRow({
	file,
	name,
	showDirectory,
	indent,
	viewed,
	conflict,
	onSelect,
}: {
	readonly file: GitReviewFile;
	readonly name: string;
	readonly showDirectory: boolean;
	readonly indent: number;
	readonly viewed: boolean;
	readonly conflict: boolean;
	readonly onSelect: (path: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const directory = showDirectory
		? file.path.slice(0, Math.max(0, file.path.length - name.length - 1))
		: "";
	const status = conflict
		? { label: "!", className: "text-[var(--accent-red)]" }
		: fileStatusFor(file.kind);
	return (
		<button
			type="button"
			onClick={() => onSelect(file.path)}
			title={file.path}
			aria-label={
				conflict
					? uiMessage("projects:diff_pane_resolve_merge_conflict_in", {
							value1: String(file.path),
						})
					: uiMessage("projects:diff_pane_open_changes_for", {
							value1: String(file.path),
						})
			}
			style={{ paddingLeft: indent }}
			className="flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
		>
			<FileIcon name={name} kind="file" />
			<span
				className={cn(
					"min-w-0 shrink truncate text-xs",
					viewed ? "text-muted-foreground" : "text-foreground",
				)}
			>
				{name}
			</span>
			<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
				{directory}
			</span>
			<DiffStat
				additions={file.additions}
				deletions={file.deletions}
				className="text-[10px]"
			/>
			<span
				aria-hidden="true"
				className={cn(
					"w-2.5 shrink-0 text-center font-mono text-[10px] font-semibold",
					status.className,
				)}
			>
				{status.label}
			</span>
		</button>
	);
}

/**
 * Small square checkbox used to pick which files go into the commit. Filled
 * monochrome (foreground) when checked, a dash when the header box is in the
 * "some selected" indeterminate state.
 */
function CheckBox({
	checked,
	indeterminate,
	onClick,
	title,
}: {
	checked: boolean;
	indeterminate?: boolean;
	onClick: () => void;
	title?: string;
}) {
	const on = checked || indeterminate === true;
	return (
		// biome-ignore lint/a11y/useSemanticElements: custom tri-state control requires a mixed aria state.
		<button
			type="button"
			role="checkbox"
			aria-checked={indeterminate ? "mixed" : checked}
			title={title}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={`flex size-[13px] shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
				on
					? "border-foreground bg-foreground text-background"
					: "border-muted-foreground/50 text-transparent hover:border-foreground"
			}`}
		>
			{indeterminate ? (
				<HugeiconsIcon
					icon={MinusSignIcon}
					className="size-2"
					strokeWidth={3.5}
				/>
			) : (
				<HugeiconsIcon icon={Tick02Icon} className="size-2" strokeWidth={3.5} />
			)}
		</button>
	);
}

/**
 * Commit composer at the bottom of the Changes tab: message, selection, and a
 * single Commit action, with the branch and Push underneath. Only the checked
 * files (`paths`) are staged + committed.
 */
function CommitComposer({
	environmentId,
	folderId,
	worktreeId,
	rootPath,
	branch,
	ahead,
	paths,
	selectedCount,
	totalCount,
	allSelected,
	someSelected,
	onToggleAll,
	onDiscardAll,
	canPush,
	onAfterCommit,
	onAfterPush,
}: {
	environmentId: ExecutionRef["environmentId"];
	folderId: FolderId;
	worktreeId: WorktreeId | null;
	rootPath: string;
	branch: string | null;
	ahead: number;
	paths: ReadonlyArray<string>;
	selectedCount: number;
	totalCount: number;
	allSelected: boolean;
	someSelected: boolean;
	onToggleAll: () => void;
	onDiscardAll: () => void;
	canPush: boolean;
	onAfterCommit: () => Promise<void>;
	onAfterPush: () => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState<null | "commit" | "push">(null);
	const [error, setError] = useState<string | null>(null);

	const canCommit = selectedCount > 0;
	const executionRef = useMemo(
		() => ({ environmentId, folderId, worktreeId, rootPath }),
		[environmentId, folderId, rootPath, worktreeId],
	);

	const onCommit = async () => {
		const trimmed = message.trim();
		if (trimmed.length === 0 || !canCommit || busy !== null) return;
		setBusy("commit");
		setError(null);
		try {
			await dispatchGitWorkspaceCommand({
				ref: executionRef,
				kind: "git.commit",
				commandId: CommandId.make(`git-commit:${crypto.randomUUID()}`),
				payload: { folderId, worktreeId, message: trimmed, paths },
			});
			setMessage("");
			await onAfterCommit();
		} catch (err) {
			setError(formatErr(err));
		} finally {
			setBusy(null);
		}
	};

	const onPush = async () => {
		if (busy !== null) return;
		setBusy("push");
		setError(null);
		try {
			await dispatchGitWorkspaceCommand({
				ref: executionRef,
				kind: "git.push",
				commandId: CommandId.make(`git-push:${crypto.randomUUID()}`),
				payload: { folderId, worktreeId },
			});
			await onAfterPush();
		} catch (err) {
			setError(formatErr(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="shrink-0 px-3 pb-2 pt-1.5">
			{totalCount > 0 ? (
				<div className="rounded-lg bg-muted/40 focus-within:bg-muted/55">
					<textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						onKeyDown={(e) => {
							if (isInputComposing(e)) return;

							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								void onCommit();
							}
						}}
						placeholder={uiMessage("projects:diff_pane_commit_message")}
						aria-label={uiMessage("projects:diff_pane_commit_message")}
						rows={1}
						disabled={!canCommit || busy === "commit"}
						className="field-sizing-content block max-h-28 min-h-8 w-full resize-none bg-transparent px-2.5 pb-0.5 pt-2 text-xs leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
					/>
					<div className="flex h-8 items-center gap-1.5 pl-2.5 pr-1">
						<CheckBox
							checked={allSelected}
							indeterminate={someSelected}
							onClick={onToggleAll}
							title={
								allSelected
									? uiMessage("projects:diff_pane_deselect_all")
									: uiMessage("projects:diff_pane_select_all")
							}
						/>
						<span
							className={cn(
								"min-w-0 flex-1 truncate",
								DOCK_META_CLASS,
								error !== null && "text-destructive",
							)}
						>
							{error ??
								uiMessage("projects:diff_pane_selection_summary", {
									selected: selectedCount,
									total: totalCount,
								})}
						</span>
						<button
							type="button"
							onClick={onDiscardAll}
							aria-label={uiMessage("projects:diff_pane_discard_all")}
							title={uiMessage("projects:diff_pane_discard_all")}
							className={cn(
								DOCK_ICON_BUTTON_CLASS,
								"size-6 hover:text-destructive",
							)}
						>
							<Trash2 className="size-3.5" />
						</button>
						<button
							type="button"
							onClick={onCommit}
							disabled={
								!canCommit || message.trim().length === 0 || busy === "commit"
							}
							className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2 text-[11px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-30"
						>
							{busy === "commit" ? (
								<HugeiconsIcon
									icon={Loading02Icon}
									className="size-3 animate-spin"
								/>
							) : null}
							{uiMessage("projects:diff_pane_commit")}
						</button>
					</div>
				</div>
			) : null}
			<div
				className={cn(
					"flex h-7 items-center gap-1.5 px-1",
					totalCount > 0 && "mt-0.5",
					DOCK_META_CLASS,
				)}
			>
				<HugeiconsIcon icon={GitBranchIcon} className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate font-mono text-foreground/80">
					{branch ?? uiMessage("projects:diff_pane_detached")}
				</span>
				{ahead > 0 ? (
					<span className="shrink-0 font-mono tabular-nums text-info">
						↑{ahead}
					</span>
				) : null}
				{totalCount === 0 ? (
					<span
						className={cn(
							"min-w-0 truncate",
							error !== null && "text-destructive",
						)}
					>
						· {error ?? uiMessage("projects:diff_pane_nothing_to_commit")}
					</span>
				) : null}
				<button
					type="button"
					onClick={onPush}
					disabled={!canPush || busy !== null}
					className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
					title={
						canPush
							? uiMessage("projects:diff_pane_push_commits_to_origin")
							: uiMessage("projects:diff_pane_no_commits_ahead_of_upstream")
					}
				>
					{busy === "push" ? (
						<HugeiconsIcon
							icon={Loading02Icon}
							className="size-3 animate-spin"
						/>
					) : (
						<HugeiconsIcon icon={Upload01Icon} className="size-3" />
					)}
					{uiMessage("projects:diff_pane_push")}
				</button>
			</div>
		</div>
	);
}

const formatErr = (err: unknown): string => {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && "reason" in err) {
		return String((err as { reason: unknown }).reason);
	}
	if (typeof err === "object" && err !== null && "_tag" in err) {
		return String((err as { _tag: unknown })._tag);
	}
	return String(err);
};

function Indicator({
	title,
	body,
	loading = false,
}: {
	title: string;
	body?: string;
	loading?: boolean;
}) {
	return (
		<div className="grid min-h-32 flex-1 place-items-center px-6 py-10 text-center">
			<div className="flex max-w-64 flex-col items-center gap-1">
				{loading ? (
					<HugeiconsIcon
						icon={Loading02Icon}
						className="mb-1 size-4 animate-spin text-muted-foreground"
						aria-hidden="true"
					/>
				) : null}
				<span className="text-xs font-medium text-foreground">{title}</span>
				{body !== undefined ? (
					<span className={cn("leading-4", DOCK_META_CLASS)}>{body}</span>
				) : null}
			</div>
		</div>
	);
}
