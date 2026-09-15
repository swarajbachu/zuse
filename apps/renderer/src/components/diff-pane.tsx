import { formatDate as formatUiDate } from "@zuse/i18n";
import { isInputComposing } from "../lib/input-composition.ts";
import { openExternal } from "../lib/platform-capabilities.ts";
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
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowTurnDownIcon,
	Loading02Icon,
	MinusSignIcon,
	Tick02Icon,
	Upload01Icon,
} from "@zuse/icons/solid-rounded";
import {
	FileWarning,
	MessageSquareText,
	Pencil,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	dispatchGitWorkspaceCommand,
	refreshGitChanges,
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
import { useUiStore } from "../store/ui.ts";
import {
	REVIEW_VIEWED_STORAGE_KEY,
	reviewFingerprint,
} from "./changes-review.tsx";
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

const basename = (path: string): string => {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
};

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
			refreshGitChanges(executionRef),
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

	const toggleAll = () =>
		setExcluded(allSelected ? new Set(committablePaths) : new Set());

	const onAfterCommit = async () => {
		setExcluded(new Set());
		await refreshAll();
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-3">
				{(["files", "comments"] as const).map((tab) => (
					<button
						key={tab}
						type="button"
						onClick={() => setNavigatorTab(tab)}
						className={`flex h-7 items-center rounded-md px-2.5 text-[11px] capitalize transition-colors ${
							navigatorTab === tab
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						}`}
					>
						{tab}
						<span className="ml-1.5 tabular-nums text-[10px] text-muted-foreground">
							{tab === "comments"
								? comments.length + pullRequestFeedback.length
								: (review?.files.length ?? 0)}
						</span>
					</button>
				))}
				<button
					type="button"
					onClick={() =>
						openChanges(nextUnviewed?.path ?? review?.files[0]?.path ?? null)
					}
					className="ml-auto flex h-7 items-center rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
				>
					{nextUnviewed === undefined
						? uiMessage("projects:diff_pane_open_review")
						: uiMessage("projects:diff_pane_next_unviewed")}
				</button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden text-xs">
				{navigatorTab === "files" ? (
					<>
						<div className="border-b border-border/40 px-3 py-2.5">
							{review !== null ? (
								<div className="flex items-center justify-between text-[10px] text-muted-foreground">
									<span>
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
									<span className="tabular-nums">
										<span className="text-success">+{review.additions}</span>{" "}
										<span className="text-destructive">
											−{review.deletions}
										</span>
									</span>
								</div>
							) : null}
						</div>
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
							) : conflictFiles.length > 0 ? (
								<div className="min-h-0 flex-1 overflow-y-auto py-1">
									<NavigatorSection
										title={uiMessage("projects:diff_pane_merge_changes")}
										count={conflictFiles.length}
										files={conflictFiles}
										onSelect={openChanges}
										conflict
									/>
									<div className="my-1 h-px bg-border/50" />
									<NavigatorSection
										title={uiMessage("projects:diff_pane_changes")}
										count={changedFiles.length}
										files={changedFiles}
										onSelect={openChanges}
									/>
								</div>
							) : (
								<NavigatorSection
									title={uiMessage("projects:diff_pane_changes")}
									count={changedFiles.length}
									files={changedFiles}
									onSelect={openChanges}
									className="min-h-0 flex-1 overflow-y-auto py-1"
								/>
							)}
						</div>
						{committable.length > 0 ? (
							<div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
								<CheckBox
									checked={allSelected}
									indeterminate={someSelected}
									onClick={toggleAll}
									title={
										allSelected
											? uiMessage("projects:diff_pane_deselect_all")
											: uiMessage("projects:diff_pane_select_all")
									}
								/>
								<span className="text-muted-foreground">
									{uiMessage(
										"projects:diff_pane_of_selected_to_commit_sentence",
										{ selectedCount: selectedCount, value: committable.length },
									)}
								</span>
								<button
									type="button"
									onClick={requestRevertAll}
									className="ml-auto text-[11px] text-muted-foreground hover:text-destructive"
								>
									{uiMessage("projects:diff_pane_discard_all")}
								</button>
							</div>
						) : null}
					</>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto p-2">
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
							<div className="space-y-4">
								{comments.length > 0 ? (
									<section>
										<NavigatorLabel icon={Sparkles} count={comments.length}>
											{uiMessage("projects:diff_pane_annotations_for_ai")}
										</NavigatorLabel>
										<ul className="mt-1.5 space-y-1">
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
														className="w-full rounded-md border border-border/60 p-2 text-left hover:bg-foreground/5"
													>
														<span className="block truncate font-mono text-[11px] text-muted-foreground">
															{comment.relPath}:{comment.startLine}
														</span>
														<span className="mt-1 line-clamp-2 block">
															{comment.comment}
														</span>
													</button>
													<div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
														<button
															type="button"
															aria-label={uiMessage(
																"projects:diff_pane_edit_comment",
															)}
															title={uiMessage(
																"projects:diff_pane_edit_comment",
															)}
															className="rounded bg-background/90 p-1 text-muted-foreground hover:text-foreground"
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
															className="rounded bg-background/90 p-1 text-muted-foreground hover:text-destructive"
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
									</section>
								) : null}
								{pullRequestFeedback.length > 0 ? (
									<section>
										<NavigatorLabel
											icon={MessageSquareText}
											count={pullRequestFeedback.length}
										>
											{uiMessage("projects:diff_pane_pull_request_feedback")}
										</NavigatorLabel>
										<ul className="mt-1.5 space-y-1.5">
											{pullRequestFeedback.map((feedback, index) => (
												<ExternalFeedbackCard
													key={`${feedback.author}:${index}`}
													feedback={feedback}
												/>
											))}
										</ul>
									</section>
								) : null}
							</div>
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
			return {
				label: "A",
				className: "bg-emerald-500/10 text-emerald-500",
			};
		case "deleted":
			return { label: "D", className: "bg-rose-500/10 text-rose-500" };
		case "renamed":
			return { label: "R", className: "bg-sky-500/10 text-sky-500" };
		default:
			return { label: "M", className: "bg-amber-500/10 text-amber-500" };
	}
};

function NavigatorLabel({
	icon: Icon,
	count,
	children,
}: {
	readonly icon: React.ComponentType<{ className?: string }>;
	readonly count: number;
	readonly children: React.ReactNode;
}) {
	return (
		<div className="flex h-6 items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
			<Icon className="size-3" />
			<span>{children}</span>
			<span className="ml-auto tabular-nums">{count}</span>
		</div>
	);
}

function NavigatorSection({
	title,
	count,
	files,
	onSelect,
	conflict = false,
	className = "",
}: {
	readonly title: string;
	readonly count: number;
	readonly files: readonly GitReviewFile[];
	readonly onSelect: (path: string) => void;
	readonly conflict?: boolean;
	readonly className?: string;
}) {
	if (files.length === 0) {
		return (
			<section className={`flex min-h-0 flex-col ${className}`}>
				<div className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
					<span>{title}</span>
					<span className="tabular-nums">{count}</span>
				</div>
			</section>
		);
	}
	return (
		<section className={`flex min-h-0 flex-col ${className}`}>
			<div className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
				{conflict ? <FileWarning className="size-3 text-rose-400" /> : null}
				<span className={conflict ? "text-foreground" : ""}>{title}</span>
				<span className="tabular-nums">{count}</span>
			</div>
			<ChangedFilesList files={files} onSelect={onSelect} conflict={conflict} />
		</section>
	);
}

function ExternalFeedbackCard({
	feedback,
}: {
	readonly feedback: GitPrComment | GitPrReview;
}) {
	const timestamp =
		"createdAt" in feedback ? feedback.createdAt : feedback.submittedAt;
	return (
		<li className="rounded-lg border border-border/60 bg-foreground/[0.02] p-2.5">
			<div className="flex items-center gap-2">
				<GitHubAvatar name={feedback.author} url={feedback.authorAvatarUrl} />
				<span className="min-w-0 truncate text-[11px] font-medium text-foreground">
					{feedback.author || uiMessage("projects:diff_pane_unknown_author")}
				</span>
				{timestamp !== null ? (
					<time className="ml-auto shrink-0 text-[10px] text-muted-foreground">
						{formatUiDate(timestamp, {
							month: "short",
							day: "numeric",
						})}
					</time>
				) : null}
			</div>
			<div className="mt-2">
				{"path" in feedback && feedback.path ? (
					<div className="mb-2 text-xs font-mono text-muted-foreground">
						{feedback.path}
						{feedback.line ? `:${feedback.line}` : ""}
					</div>
				) : null}
				<MarkdownBody githubHtml className="text-xs">
					{feedback.body}
				</MarkdownBody>
				{feedback.url ? (
					<button
						type="button"
						className="mt-2 h-7 text-xs text-muted-foreground hover:text-foreground"
						onClick={() => {
							if (feedback.url) void openExternal(feedback.url);
						}}
					>
						Open in GitHub ↗
					</button>
				) : null}
			</div>
		</li>
	);
}

function ChangedFilesList({
	files,
	onSelect,
	conflict,
}: {
	readonly files: readonly GitReviewFile[];
	readonly onSelect: (path: string) => void;
	readonly conflict: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	return (
		<ul
			aria-label={
				conflict
					? uiMessage("projects:diff_pane_files_with_merge_conflicts")
					: uiMessage("projects:diff_pane_changed_files")
			}
		>
			{files.map((file) => {
				const name = basename(file.path);
				const directory = file.path.slice(
					0,
					Math.max(0, file.path.length - name.length - 1),
				);
				const status = fileStatusFor(file.kind);
				return (
					<li key={file.path}>
						<button
							type="button"
							onClick={() => onSelect(file.path)}
							aria-label={
								conflict
									? uiMessage("projects:diff_pane_resolve_merge_conflict_in", {
											value1: String(file.path),
										})
									: uiMessage("projects:diff_pane_open_changes_for", {
											value1: String(file.path),
										})
							}
							className="group flex h-8 w-full items-center gap-2 px-3 text-left outline-none hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.06] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
						>
							<span
								className={`grid size-5 shrink-0 place-items-center rounded text-[10px] font-semibold ${
									conflict ? "bg-rose-500/10 text-rose-400" : status.className
								}`}
								aria-hidden="true"
							>
								{conflict ? "!" : status.label}
							</span>
							<FileIcon name={name} kind="file" className="size-4 shrink-0" />
							<span className="min-w-0 truncate text-xs text-foreground">
								{name}
							</span>
							{directory.length > 0 ? (
								<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
									{directory}
								</span>
							) : (
								<span className="flex-1" />
							)}
							<span className="shrink-0 font-mono text-[10px] tabular-nums">
								<span className="text-emerald-500">+{file.additions}</span>{" "}
								<span className="text-rose-500">−{file.deletions}</span>
							</span>
						</button>
					</li>
				);
			})}
		</ul>
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
 * Commit composer modeled on GitHub Desktop's bottom-of-pane control: branch
 * indicator, an upstream/Push button, the message input, and a "Commit" CTA.
 * Only the files checked in the list (`paths`) are staged + committed, so the
 * user controls exactly what goes into each commit.
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
		[environmentId, folderId, rootPath, worktreeId, uiMessage],
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
		<div className="shrink-0 border-t border-border/50 bg-background p-3">
			<div className="overflow-hidden rounded-lg bg-muted/35 shadow-[0_0_0_1px_color-mix(in_oklab,var(--border)_65%,transparent)]">
				<div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
					<span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="truncate font-mono text-foreground">
							{branch ?? uiMessage("projects:diff_pane_detached")}
						</span>
						{ahead > 0 ? (
							<span className="font-mono text-[10px] text-info">↑{ahead}</span>
						) : null}
					</span>
					<button
						type="button"
						onClick={onPush}
						disabled={!canPush || busy !== null}
						className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
				<div>
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
						rows={2}
						disabled={!canCommit || busy === "commit"}
						className="block min-h-16 w-full resize-none bg-transparent px-3 py-2.5 text-xs leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:bg-background/40 disabled:cursor-not-allowed disabled:opacity-60"
					/>
				</div>
				<div className="flex flex-row items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
					<span className="min-w-0 truncate text-[10px] text-muted-foreground">
						{error !== null ? (
							<span className="text-destructive">{error}</span>
						) : totalCount === 0 ? (
							uiMessage("projects:diff_pane_nothing_to_commit")
						) : (
							uiMessage("projects:diff_pane_selection_summary", {
								selected: selectedCount,
								total: totalCount,
							})
						)}
					</span>
					<button
						type="button"
						onClick={onCommit}
						disabled={
							!canCommit || message.trim().length === 0 || busy === "commit"
						}
						className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[11px] font-medium text-background transition-colors hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-30"
					>
						{busy === "commit" ? (
							<HugeiconsIcon
								icon={Loading02Icon}
								className="size-3 animate-spin"
							/>
						) : (
							<HugeiconsIcon icon={ArrowTurnDownIcon} className="size-3" />
						)}
						{selectedCount > 0
							? uiMessage("projects:diff_pane_commit_2", {
									selectedCount: String(selectedCount),
								})
							: uiMessage("projects:diff_pane_commit")}
					</button>
				</div>
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
			<div className="flex max-w-64 flex-col items-center gap-1.5">
				{loading ? (
					<HugeiconsIcon
						icon={Loading02Icon}
						className="mb-1 size-4 animate-spin text-muted-foreground"
						aria-hidden="true"
					/>
				) : null}
				<span className="text-xs font-medium text-foreground">{title}</span>
				{body !== undefined ? (
					<span className="text-[11px] leading-4 text-muted-foreground">
						{body}
					</span>
				) : null}
			</div>
		</div>
	);
}
