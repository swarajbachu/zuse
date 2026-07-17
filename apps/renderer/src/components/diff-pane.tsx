import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowTurnDownIcon,
	Loading02Icon,
	MinusSignIcon,
	Tick02Icon,
	Upload01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import {
	FileTree as StructuredFileTree,
	useFileTree,
} from "@pierre/trees/react";
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
import { Effect } from "effect";
import {
	CircleAlert,
	MessageSquareText,
	Pencil,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getRpcClient } from "../lib/rpc-client.ts";
import { useAnnotationsStore } from "../store/annotations.ts";
import { gitChangesKey, useGitChangesStore } from "../store/git-changes.ts";
import { gitReviewKey, useGitReviewStore } from "../store/git-review.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { prDetailsKey, usePrDetailsStore } from "../store/pr-details.ts";
import { usePrStateStore } from "../store/pr-state.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import {
	REVIEW_VIEWED_STORAGE_KEY,
	reviewFingerprint,
} from "./changes-review.tsx";
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
import { Frame, FrameFooter, FrameHeader, FramePanel } from "./ui/frame.tsx";

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
	folderId,
	worktreeId,
}: {
	folderId: FolderId | null;
	worktreeId: WorktreeId | null;
}) {
	const status = useGitStatusStore((s) =>
		folderId ? (s.byKey[gitStatusKey(folderId, worktreeId)] ?? null) : null,
	);
	const changes = useGitChangesStore((s) =>
		folderId ? (s.byKey[gitChangesKey(folderId, worktreeId)] ?? null) : null,
	);
	const changesErrorTag = useGitChangesStore((s) =>
		folderId
			? (s.errorTagByKey[gitChangesKey(folderId, worktreeId)] ?? null)
			: null,
	);
	const review = useGitReviewStore((s) =>
		folderId ? (s.summaries[gitReviewKey(folderId, worktreeId)] ?? null) : null,
	);
	const reviewLoading = useGitReviewStore((s) =>
		folderId ? s.loading[gitReviewKey(folderId, worktreeId)] === true : false,
	);
	const reviewPatchesByKey = useGitReviewStore((s) => s.patches);
	const reviewPatches = folderId
		? (reviewPatchesByKey[gitReviewKey(folderId, worktreeId)] ??
			EMPTY_REVIEW_PATCHES)
		: EMPTY_REVIEW_PATCHES;
	const refreshReview = useGitReviewStore((s) => s.refresh);
	const refreshChanges = useGitChangesStore((s) => s.refresh);
	const refreshStatus = useGitStatusStore((s) => s.refresh);
	const refreshPrState = usePrStateStore((s) => s.refresh);
	const prDetails = usePrDetailsStore((s) =>
		folderId ? (s.byKey[prDetailsKey(folderId, worktreeId)] ?? null) : null,
	);
	const hydratePrDetails = usePrDetailsStore((s) => s.hydrate);
	const refreshPrDetails = usePrDetailsStore((s) => s.refresh);
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
		[annotationsBySession, selectedSessionId],
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

	// Poll the working tree on the same 5s cadence the top bar uses for
	// `git status`, so the Changes tab stays in sync with the dirty-count badge.
	useEffect(() => {
		if (folderId === null) return;
		void refreshChanges(folderId, worktreeId);
		void refreshReview(folderId, worktreeId);
		void hydratePrDetails(folderId, worktreeId);
		const id = window.setInterval(() => {
			void refreshChanges(folderId, worktreeId);
		}, 5000);
		return () => window.clearInterval(id);
	}, [folderId, worktreeId, hydratePrDetails, refreshChanges, refreshReview]);

	if (folderId === null) {
		return <Empty>Select a project to see its changes.</Empty>;
	}

	const refreshAll = async () => {
		await Promise.all([
			refreshChanges(folderId, worktreeId),
			refreshStatus(folderId, worktreeId),
			refreshPrState(folderId, worktreeId),
			refreshPrDetails(folderId, worktreeId),
			refreshReview(folderId, worktreeId),
		]);
	};

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
			const client = await getRpcClient();
			if (request.type === "all") {
				await Effect.runPromise(
					client["git.revertAll"]({ folderId, worktreeId }),
				);
			} else {
				await Effect.runPromise(
					client["git.revertFile"]({
						folderId,
						worktreeId,
						path: request.path,
						oldPath: request.oldPath,
						kind: request.kind,
					}),
				);
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
	// the selection survives the 5s poll without re-adding every path.
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
	const reviewKey = gitReviewKey(folderId, worktreeId);
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
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center border-b border-border px-2 pt-2">
				{(["files", "comments"] as const).map((tab) => (
					<button
						key={tab}
						type="button"
						onClick={() => setNavigatorTab(tab)}
						className={`border-b-2 px-2 pb-2 text-xs capitalize transition-colors ${
							navigatorTab === tab
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
					>
						{tab}{" "}
						{tab === "comments"
							? comments.length + pullRequestFeedback.length
							: (review?.files.length ?? 0)}
					</button>
				))}
				<button
					type="button"
					onClick={() =>
						openChanges(nextUnviewed?.path ?? review?.files[0]?.path ?? null)
					}
					className="ml-auto rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
				>
					{nextUnviewed === undefined ? "Open review" : "Next unviewed"}
				</button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden text-xs">
				{navigatorTab === "files" ? (
					<>
						<div className="border-b border-border/60 px-3 py-2">
							{review !== null ? (
								<div className="flex items-center justify-between text-[11px] text-muted-foreground">
									<span>
										{review.baseRef === null
											? "Compared with HEAD"
											: `Base ${review.baseRef}`}
										{` · ${viewedPaths.size}/${review.files.length} viewed`}
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
									<GitInitCta folderId={folderId} worktreeId={worktreeId} />
								</div>
							) : reviewLoading && review === null ? (
								<Indicator title="Loading branch changes…" />
							) : reviewFiles.length === 0 ? (
								<Indicator title="No branch changes" />
							) : (
								<>
									{conflictFiles.length > 0 ? (
										<NavigatorSection
											title="Conflicts"
											count={conflictFiles.length}
											files={conflictFiles}
											onSelect={openChanges}
											conflict
										/>
									) : null}
									<NavigatorSection
										title="Changes"
										count={changedFiles.length}
										files={changedFiles}
										onSelect={openChanges}
										className="min-h-0 flex-1"
									/>
								</>
							)}
						</div>
						{committable.length > 0 ? (
							<div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
								<CheckBox
									checked={allSelected}
									indeterminate={someSelected}
									onClick={toggleAll}
									title={allSelected ? "Deselect all" : "Select all"}
								/>
								<span className="text-muted-foreground">
									{selectedCount} of {committable.length} selected to commit
								</span>
								<button
									type="button"
									onClick={requestRevertAll}
									className="ml-auto text-[11px] text-muted-foreground hover:text-destructive"
								>
									Discard all
								</button>
							</div>
						) : null}
					</>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto p-2">
						{selectedSessionId === null && pullRequestFeedback.length === 0 ? (
							<Indicator
								title="No active chat"
								body="Open a chat session to create and manage review comments."
							/>
						) : comments.length === 0 && pullRequestFeedback.length === 0 ? (
							<Indicator
								title="No comments yet"
								body="Select lines in All changes to add one."
							/>
						) : (
							<div className="space-y-4">
								{comments.length > 0 ? (
									<section>
										<NavigatorLabel icon={Sparkles} count={comments.length}>
											Annotations for AI
										</NavigatorLabel>
										<ul className="mt-1.5 space-y-1">
											{comments.map((comment) => (
												<li key={comment.id} className="group relative">
													<button
														type="button"
														onClick={() =>
															openChanges(
																comment.relPath,
																comment.startLine,
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
															aria-label="Edit comment"
															title="Edit comment"
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
															aria-label="Delete comment"
															title="Delete comment"
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
											Pull request feedback
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
				folderId={folderId}
				worktreeId={worktreeId}
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
								Cancel
							</Button>
						}
					/>
					<Button
						type="button"
						variant="destructive"
						disabled={busy}
						onClick={onConfirm}
					>
						{busy ? "Reverting..." : actionLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}

const treeStatusFor = (kind: GitChangeKind): GitStatus => {
	switch (kind) {
		case "added":
		case "copied":
			return "added";
		case "deleted":
			return "deleted";
		case "renamed":
			return "renamed";
		case "untracked":
			return "untracked";
		case "ignored":
			return "ignored";
		default:
			return "modified";
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
				<div className="flex h-7 shrink-0 items-center gap-1.5 px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					<span>{title}</span>
					<span className="tabular-nums">{count}</span>
				</div>
				<div className="px-3 py-2 text-[11px] text-muted-foreground">
					No other changed files
				</div>
			</section>
		);
	}
	return (
		<section
			className={`flex min-h-0 flex-col ${
				conflict ? "max-h-[42%] shrink-0 border-b border-border/60" : ""
			} ${className}`}
			style={
				conflict
					? { height: Math.min(220, Math.max(72, files.length * 24 + 36)) }
					: undefined
			}
		>
			<div className="flex h-7 shrink-0 items-center gap-1.5 px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				{conflict ? <CircleAlert className="size-3 text-amber-400" /> : null}
				<span className={conflict ? "text-amber-300" : ""}>{title}</span>
				<span className="ml-auto tabular-nums">{count}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<ChangesNavigatorTree
					key={files.map((file) => `${file.path}:${file.kind}`).join("\0")}
					files={files}
					onSelect={onSelect}
				/>
			</div>
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
				{feedback.authorAvatarUrl !== null ? (
					<img
						src={feedback.authorAvatarUrl}
						alt=""
						className="size-5 rounded-full bg-foreground/5"
					/>
				) : (
					<div className="grid size-5 place-items-center rounded-full bg-foreground/10 text-[9px] text-muted-foreground">
						{feedback.author.slice(0, 1).toUpperCase()}
					</div>
				)}
				<span className="min-w-0 truncate text-[11px] font-medium text-foreground">
					{feedback.author || "Unknown author"}
				</span>
				{timestamp !== null ? (
					<time className="ml-auto shrink-0 text-[10px] text-muted-foreground">
						{timestamp.toLocaleDateString(undefined, {
							month: "short",
							day: "numeric",
						})}
					</time>
				) : null}
			</div>
			<p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[11px] leading-4 text-foreground/90">
				{feedback.body}
			</p>
		</li>
	);
}

function ChangesNavigatorTree({
	files,
	onSelect,
}: {
	readonly files: readonly GitReviewFile[];
	readonly onSelect: (path: string) => void;
}) {
	const paths = useMemo(() => files.map((file) => file.path), [files]);
	const gitStatus = useMemo<GitStatusEntry[]>(
		() =>
			files.map((file) => ({
				path: file.path,
				status: treeStatusFor(file.kind),
			})),
		[files],
	);
	const { model } = useFileTree({
		paths,
		gitStatus,
		density: "compact",
		icons: "complete",
		initialExpansion: 3,
		initialVisibleRowCount: 50,
		onSelectionChange: (selectedPaths) => {
			const path = selectedPaths[0];
			if (selectedPaths.length === 1 && path !== undefined) onSelect(path);
		},
	});
	return (
		<StructuredFileTree
			model={model}
			aria-label="Changed files"
			className="h-full min-h-0"
		/>
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
	folderId,
	worktreeId,
	branch,
	ahead,
	paths,
	selectedCount,
	totalCount,
	canPush,
	onAfterCommit,
	onAfterPush,
}: {
	folderId: FolderId;
	worktreeId: WorktreeId | null;
	branch: string | null;
	ahead: number;
	paths: ReadonlyArray<string>;
	selectedCount: number;
	totalCount: number;
	canPush: boolean;
	onAfterCommit: () => Promise<void>;
	onAfterPush: () => Promise<void>;
}) {
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState<null | "commit" | "push">(null);
	const [error, setError] = useState<string | null>(null);

	const canCommit = selectedCount > 0;

	const onCommit = async () => {
		const trimmed = message.trim();
		if (trimmed.length === 0 || !canCommit || busy !== null) return;
		setBusy("commit");
		setError(null);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["git.commit"]({ folderId, worktreeId, message: trimmed, paths }),
			);
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
			const client = await getRpcClient();
			await Effect.runPromise(client["git.push"]({ folderId, worktreeId }));
			await onAfterPush();
		} catch (err) {
			setError(formatErr(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="shrink-0 border-t border-border bg-background/20 p-2">
			<Frame>
				<FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
					<span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="truncate font-mono text-foreground">
							{branch ?? "(detached)"}
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
								? "Push commits to origin"
								: "No commits ahead of upstream"
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
						Push
					</button>
				</FrameHeader>
				<FramePanel className="p-0">
					<textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								void onCommit();
							}
						}}
						placeholder="Commit message"
						rows={2}
						disabled={!canCommit || busy === "commit"}
						className="block min-h-16 w-full resize-none rounded-md bg-transparent px-3 py-2 font-mono text-[11px] leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
					/>
				</FramePanel>
				<FrameFooter className="flex flex-row items-center justify-between gap-2 px-3 py-2">
					<span className="min-w-0 truncate text-[10px] text-muted-foreground">
						{error !== null ? (
							<span className="text-destructive">{error}</span>
						) : totalCount === 0 ? (
							<>Nothing to commit</>
						) : (
							<>
								{selectedCount} of {totalCount} selected · ⌘↵
							</>
						)}
					</span>
					<button
						type="button"
						onClick={onCommit}
						disabled={
							!canCommit || message.trim().length === 0 || busy === "commit"
						}
						className="flex shrink-0 items-center gap-1.5 rounded-sm bg-success/15 px-2 py-1 text-[11px] font-medium text-success transition-colors hover:bg-success/25 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{busy === "commit" ? (
							<HugeiconsIcon
								icon={Loading02Icon}
								className="size-3 animate-spin"
							/>
						) : (
							<HugeiconsIcon icon={ArrowTurnDownIcon} className="size-3" />
						)}
						{selectedCount > 0 ? `Commit ${selectedCount}` : "Commit"}
					</button>
				</FrameFooter>
			</Frame>
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

function Indicator({ title, body }: { title: string; body?: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="font-medium text-foreground">{title}</span>
			{body !== undefined ? (
				<span className="text-muted-foreground">{body}</span>
			) : null}
		</div>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-3 py-6 text-center text-xs text-muted-foreground">
			{children}
		</p>
	);
}
