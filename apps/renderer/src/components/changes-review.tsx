import type {
	CodeViewDiffItem,
	CodeViewItem,
	CodeViewLineSelection,
	DiffLineAnnotation,
	FileContents,
	MergeConflictResolution,
} from "@pierre/diffs";
import { DEFAULT_THEMES, processFile } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import {
	CodeView,
	type CodeViewHandle,
	UnresolvedFile,
	type UnresolvedFileReactOptions,
	type WorkerInitializationRenderOptions,
	WorkerPoolContextProvider,
	type WorkerPoolOptions,
} from "@pierre/diffs/react";
import type {
	CodeAnnotation,
	FolderId,
	GitReviewFile,
	GitReviewPatch,
	WorktreeId,
} from "@zuse/contracts";
import { Effect } from "effect";
import {
	ChevronDown,
	ChevronRight,
	ChevronsUpDown,
	CircleAlert,
	Columns2,
	Copy,
	EyeOff,
	FilePenLine,
	MoreHorizontal,
	PanelTop,
	RotateCcw,
	Rows3,
	Save,
	Send,
	Settings2,
	Sparkles,
	SquarePlus,
	UserRound,
	X,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	configureReviewEditGuard,
	requestReviewLeave,
} from "../lib/review-edit-guard.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useAnnotationsStore } from "../store/annotations.ts";
import { gitReviewKey, useGitReviewStore } from "../store/git-review.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverPrimitive, PopoverTrigger } from "./ui/popover.tsx";
import { Switch } from "./ui/switch.tsx";

type ReviewPreferences = {
	readonly diffStyle: "split" | "unified";
	readonly wrap: boolean;
	readonly lineNumbers: boolean;
	readonly backgrounds: boolean;
	readonly indicators: "bars" | "classic" | "none";
};

const PREFERENCES_KEY = "zuse.review.preferences.v1";
export const REVIEW_VIEWED_STORAGE_KEY = "zuse.review.viewed.v1";
const DEFAULT_PREFERENCES: ReviewPreferences = {
	diffStyle: "split",
	wrap: true,
	lineNumbers: true,
	backgrounds: true,
	indicators: "bars",
};

const REVIEW_POOL_OPTIONS: WorkerPoolOptions = {
	poolSize: Math.min(3, Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1)),
	totalASTLRUCacheSize: 100,
	workerFactory: () =>
		new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
			type: "module",
		}),
};

const REVIEW_HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
	theme: DEFAULT_THEMES,
	langs: ["css", "go", "python", "rust", "sh", "swift", "tsx", "typescript"],
	preferredHighlighter: "shiki-wasm",
};

const EMPTY_REVIEW_PATCHES: Readonly<Record<string, GitReviewPatch>> = {};

const loadPreferences = (): ReviewPreferences => {
	try {
		return {
			...DEFAULT_PREFERENCES,
			...(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "{}") as object),
		};
	} catch {
		return DEFAULT_PREFERENCES;
	}
};

const loadViewed = (): Record<string, string> => {
	try {
		return JSON.parse(
			localStorage.getItem(REVIEW_VIEWED_STORAGE_KEY) ?? "{}",
		) as Record<string, string>;
	} catch {
		return {};
	}
};

export const reviewFingerprint = (patch: string): string => {
	let value = 2166136261;
	for (let index = 0; index < patch.length; index += 1) {
		value ^= patch.charCodeAt(index);
		value = Math.imul(value, 16777619);
	}
	return `${patch.length}:${(value >>> 0).toString(36)}`;
};

type AnnotationMetadata =
	| { readonly kind: "saved"; readonly annotation: CodeAnnotation }
	| { readonly kind: "draft" };

type HydratedFile = {
	readonly oldContent: string | null;
	readonly newContent: string | null;
	readonly mtime: string | null;
};

export function ChangesReview() {
	const context = useActiveContext();
	if (context.status !== "ready") {
		return (
			<div className="grid h-full place-items-center text-sm text-muted-foreground">
				Select a ready workspace to review changes.
			</div>
		);
	}
	return (
		<WorkerPoolContextProvider
			poolOptions={REVIEW_POOL_OPTIONS}
			highlighterOptions={REVIEW_HIGHLIGHTER_OPTIONS}
		>
			<ChangesReviewReady
				key={`${context.folderId}:${context.worktreeId ?? "main"}`}
				folderId={context.folderId}
				worktreeId={context.worktreeId}
				rootPath={context.rootPath}
			/>
		</WorkerPoolContextProvider>
	);
}

function ChangesReviewReady({
	folderId,
	worktreeId,
	rootPath,
}: {
	readonly folderId: FolderId;
	readonly worktreeId: WorktreeId | null;
	readonly rootPath: string;
}) {
	const key = gitReviewKey(folderId, worktreeId);
	const summary = useGitReviewStore((state) => state.summaries[key] ?? null);
	const patches = useGitReviewStore(
		(state) => state.patches[key] ?? EMPTY_REVIEW_PATCHES,
	);
	const loading = useGitReviewStore((state) => state.loading[key] === true);
	const error = useGitReviewStore((state) => state.errors[key] ?? null);
	const refresh = useGitReviewStore((state) => state.refresh);
	const ensurePatch = useGitReviewStore((state) => state.ensurePatch);
	const navigation = useUiStore((state) => state.reviewNavigation);
	const viewerRef = useRef<CodeViewHandle<AnnotationMetadata>>(null);
	const lastNavigationTokenRef = useRef<number | null>(null);
	const parsedRef = useRef(
		new Map<string, CodeViewDiffItem<AnnotationMetadata>>(),
	);
	const [preferences, setPreferences] = useState(loadPreferences);
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const [viewed, setViewed] = useState(loadViewed);
	const [selection, setSelection] = useState<CodeViewLineSelection | null>(
		null,
	);
	const [annotationText, setAnnotationText] = useState("");
	const [annotationError, setAnnotationError] = useState<string | null>(null);
	const [editingPath, setEditingPath] = useState<string | null>(null);
	const [hydrated, setHydrated] = useState<Record<string, HydratedFile>>({});
	const [editDraft, setEditDraft] = useState<FileContents | null>(null);
	const [editError, setEditError] = useState<string | null>(null);
	const selectedSessionId = useSessionsStore(
		(state) => state.selectedSessionId,
	);
	const annotationsBySession = useAnnotationsStore((state) => state.bySession);
	const annotations = useMemo(
		() =>
			selectedSessionId === null
				? []
				: (annotationsBySession[selectedSessionId] ?? []).filter(
						(entry): entry is CodeAnnotation => !("_tag" in entry),
					),
		[annotationsBySession, selectedSessionId],
	);

	useEffect(() => {
		void refresh(folderId, worktreeId);
	}, [folderId, worktreeId, refresh]);

	useEffect(() => {
		const path = navigation?.path;
		if (path === null || path === undefined || patches[path] !== undefined)
			return;
		void ensurePatch(folderId, worktreeId, path);
	}, [ensurePatch, folderId, navigation?.path, patches, worktreeId]);

	useEffect(() => {
		localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
	}, [preferences]);

	const updatePreferences = (patch: Partial<ReviewPreferences>) =>
		setPreferences((current) => ({ ...current, ...patch }));

	const annotationMap = useMemo(() => {
		const map = new Map<string, DiffLineAnnotation<AnnotationMetadata>[]>();
		for (const annotation of annotations) {
			const list = map.get(annotation.relPath) ?? [];
			list.push({
				side: annotation.diffSide ?? "additions",
				lineNumber: annotation.startLine,
				metadata: { kind: "saved", annotation },
			});
			map.set(annotation.relPath, list);
		}
		if (selection !== null) {
			const list = map.get(selection.id) ?? [];
			list.push({
				side: selection.range.side ?? "additions",
				lineNumber: Math.min(selection.range.start, selection.range.end),
				metadata: { kind: "draft" },
			});
			map.set(selection.id, list);
		}
		return map;
	}, [annotations, selection]);

	const items = useMemo(() => {
		if (summary === null) return [];
		const next: CodeViewItem<AnnotationMetadata>[] = [];
		for (const file of summary.files) {
			const streamedPatch = patches[file.path];
			if (streamedPatch === undefined) continue;
			const patch = streamedPatch.result.patch;
			if (patch.length === 0) {
				next.push({
					id: file.path,
					type: "file",
					file: {
						name: file.path,
						contents:
							streamedPatch.error !== null
								? `This file could not be loaded: ${streamedPatch.error}`
								: file.conflict
									? "Select this file in the navigator to resolve its conflicts."
									: file.binary
										? "Binary file changed — no textual diff is available."
										: "No textual diff is available for this change.",
						cacheKey: `${key}:${file.path}:placeholder`,
					},
					collapsed: collapsed.has(file.path),
				});
				continue;
			}
			const fingerprint = reviewFingerprint(patch);
			const content = hydrated[file.path];
			const hydrationKey = content?.mtime ?? "partial";
			const cacheKey = `${key}:${file.path}:${fingerprint}:${hydrationKey}`;
			let parsed = parsedRef.current.get(cacheKey);
			if (parsed === undefined) {
				const fileDiff = processFile(patch, {
					cacheKey,
					...(content?.oldContent !== null && content?.oldContent !== undefined
						? {
								oldFile: {
									name: file.oldPath ?? file.path,
									contents: content.oldContent,
									cacheKey: `${cacheKey}:old`,
								},
							}
						: {}),
					...(content?.newContent !== null && content?.newContent !== undefined
						? {
								newFile: {
									name: file.path,
									contents: content.newContent,
									cacheKey: `${cacheKey}:new`,
								},
							}
						: {}),
				});
				if (fileDiff === undefined) continue;
				parsed = { id: file.path, type: "diff", fileDiff };
				parsedRef.current.set(cacheKey, parsed);
			}
			next.push({
				...parsed,
				annotations: annotationMap.get(file.path),
				collapsed: collapsed.has(file.path),
				edit: editingPath === file.path,
				version:
					Number(collapsed.has(file.path)) +
					Number(editingPath === file.path) * 2,
			});
		}
		return next;
	}, [summary, patches, key, hydrated, annotationMap, collapsed, editingPath]);

	useEffect(() => {
		if (navigation?.path === null || navigation?.path === undefined) return;
		if (lastNavigationTokenRef.current === navigation.token) return;
		if (!items.some((item) => item.id === navigation.path)) return;
		const target =
			navigation.line === null
				? {
						type: "item" as const,
						id: navigation.path,
						behavior: "smooth-auto" as const,
					}
				: {
						type: "line" as const,
						id: navigation.path,
						lineNumber: navigation.line,
						side: navigation.side ?? undefined,
						align: "center" as const,
						behavior: "smooth-auto" as const,
					};
		viewerRef.current?.scrollTo(target);
		lastNavigationTokenRef.current = navigation.token;
	}, [items, navigation]);

	const fileByPath = useMemo(
		() => new Map(summary?.files.map((file) => [file.path, file]) ?? []),
		[summary],
	);

	const viewedKey = useCallback((path: string) => `${key}:${path}`, [key]);
	const isViewed = useCallback(
		(path: string) => {
			const patch = patches[path]?.result.patch ?? "";
			return viewed[viewedKey(path)] === reviewFingerprint(patch);
		},
		[patches, viewed, viewedKey],
	);
	const toggleViewed = useCallback(
		(path: string) => {
			const storageKey = viewedKey(path);
			const fingerprint = reviewFingerprint(patches[path]?.result.patch ?? "");
			setViewed((current) => {
				const next = { ...current };
				if (next[storageKey] === fingerprint) delete next[storageKey];
				else next[storageKey] = fingerprint;
				localStorage.setItem(REVIEW_VIEWED_STORAGE_KEY, JSON.stringify(next));
				window.dispatchEvent(new CustomEvent("zuse-review-viewed"));
				return next;
			});
		},
		[patches, viewedKey],
	);
	const toggleCollapsed = useCallback((path: string) => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const enterEdit = useCallback(
		(file: GitReviewFile) => {
			const loadEditor = async () => {
				setEditingPath(null);
				setEditDraft(null);
				setEditError(null);
				try {
					const client = await getRpcClient();
					const content = await Effect.runPromise(
						client["git.reviewFileContents"]({
							folderId,
							worktreeId,
							path: file.path,
							oldPath: file.oldPath,
						}),
					);
					if (content.newContent === null || content.mtime === null) {
						setEditError("This file cannot be edited in its current state.");
						return;
					}
					setHydrated((current) => ({ ...current, [file.path]: content }));
					setEditingPath(file.path);
				} catch (cause) {
					setEditError(
						`Could not open this file for editing. ${String(cause)}`,
					);
				}
			};
			if (
				editingPath !== null &&
				editingPath !== file.path &&
				editDraft !== null
			) {
				requestReviewLeave(() => void loadEditor());
				return;
			}
			void loadEditor();
		},
		[editingPath, editDraft, folderId, worktreeId],
	);

	const leaveEdit = useCallback(() => {
		requestReviewLeave(() => {
			setEditingPath(null);
			setEditDraft(null);
			setEditError(null);
		});
	}, []);

	const saveEdit = useCallback(async (): Promise<boolean> => {
		if (editingPath === null) return true;
		if (editDraft === null) {
			setEditingPath(null);
			return true;
		}
		const metadata = hydrated[editingPath];
		if (metadata?.mtime === null || metadata?.mtime === undefined) return false;
		setEditError(null);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["fs.writeFile"]({
					folderId,
					worktreeId,
					path: editingPath,
					content: editDraft.contents,
					expectedMtime: metadata.mtime,
				}),
			);
			setEditingPath(null);
			setEditDraft(null);
			await refresh(folderId, worktreeId);
			return true;
		} catch (cause) {
			setEditError(`Save failed. Your draft is preserved. ${String(cause)}`);
			return false;
		}
	}, [editDraft, editingPath, folderId, hydrated, refresh, worktreeId]);

	useEffect(() => {
		configureReviewEditGuard(
			editingPath !== null && editDraft !== null,
			saveEdit,
		);
		return () => configureReviewEditGuard(false, null);
	}, [editDraft, editingPath, saveEdit]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				if (editingPath === null) return;
				event.preventDefault();
				void saveEdit();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [editingPath, saveEdit]);

	const restoreToBase = useCallback(
		async (file: GitReviewFile) => {
			if (!window.confirm(`Restore ${file.path} to the comparison base?`))
				return;
			const client = await getRpcClient();
			await Effect.runPromise(
				client["git.restoreFileToBase"]({
					folderId,
					worktreeId,
					path: file.path,
					oldPath: file.oldPath,
				}),
			);
			await refresh(folderId, worktreeId);
		},
		[folderId, refresh, worktreeId],
	);

	const discardUncommitted = useCallback(
		async (file: GitReviewFile) => {
			if (!window.confirm(`Discard uncommitted edits in ${file.path}?`)) return;
			const client = await getRpcClient();
			await Effect.runPromise(
				client["git.revertFile"]({
					folderId,
					worktreeId,
					path: file.path,
					oldPath: file.oldPath,
					kind: file.kind,
				}),
			);
			await refresh(folderId, worktreeId);
		},
		[folderId, refresh, worktreeId],
	);

	const renderHeaderPrefix = useCallback(
		(item: CodeViewItem<AnnotationMetadata>) => {
			const file = fileByPath.get(item.id);
			if (file === undefined) return null;
			return (
				<div className="ml-[-6px] flex items-center gap-0.5">
					<button
						type="button"
						aria-label={
							collapsed.has(file.path) ? "Expand diff" : "Collapse diff"
						}
						title={collapsed.has(file.path) ? "Expand diff" : "Collapse diff"}
						onClick={(event) => {
							event.stopPropagation();
							toggleCollapsed(file.path);
						}}
						className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
					>
						{collapsed.has(file.path) ? (
							<ChevronRight className="size-3.5" />
						) : (
							<ChevronDown className="size-3.5" />
						)}
					</button>
					<input
						type="checkbox"
						checked={isViewed(file.path)}
						onChange={() => {
							const wasViewed = isViewed(file.path);
							toggleViewed(file.path);
							if (!wasViewed) {
								setCollapsed((current) => new Set(current).add(file.path));
							}
						}}
						onClick={(event) => event.stopPropagation()}
						aria-label={
							isViewed(file.path) ? "Mark unviewed" : "Mark viewed and collapse"
						}
						title={
							isViewed(file.path) ? "Mark unviewed" : "Mark viewed and collapse"
						}
						className="size-3.5 cursor-pointer accent-foreground"
					/>
				</div>
			);
		},
		[collapsed, fileByPath, isViewed, toggleCollapsed, toggleViewed],
	);

	const renderHeaderMetadata = useCallback(
		(item: CodeViewItem<AnnotationMetadata>) => {
			const file = fileByPath.get(item.id);
			if (file === undefined) return null;
			const editing = editingPath === item.id;
			return (
				<div className="flex items-center gap-1 pr-2">
					{editing ? (
						<button
							type="button"
							title="Save edit (⌘S)"
							onClick={() => void saveEdit()}
							className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-foreground hover:bg-foreground/10"
						>
							<Save className="size-3" /> Save
						</button>
					) : null}
					<FileActionsMenu
						file={file}
						editing={editing}
						onEdit={() => (editing ? leaveEdit() : void enterEdit(file))}
						onDiscard={() => void discardUncommitted(file)}
						onRestore={() => void restoreToBase(file)}
					/>
				</div>
			);
		},
		[
			discardUncommitted,
			editingPath,
			enterEdit,
			fileByPath,
			leaveEdit,
			restoreToBase,
			saveEdit,
		],
	);

	const saveAnnotation = (event: FormEvent) => {
		event.preventDefault();
		if (selection === null || annotationText.trim().length === 0) return;
		if (selectedSessionId === null) {
			setAnnotationError("Open a chat session before adding a review comment.");
			return;
		}
		const file = fileByPath.get(selection.id);
		useAnnotationsStore.getState().add(selectedSessionId, {
			relPath: selection.id,
			absPath: `${rootPath}/${selection.id}`,
			startLine: Math.min(selection.range.start, selection.range.end),
			endLine: Math.max(selection.range.start, selection.range.end),
			comment: annotationText.trim(),
			diffSide: selection.range.side ?? "additions",
			...(file?.oldPath === null || file?.oldPath === undefined
				? {}
				: { oldPath: file.oldPath }),
			...(summary?.baseRef === null || summary?.baseRef === undefined
				? {}
				: { baseRef: summary.baseRef }),
		});
		setAnnotationText("");
		setAnnotationError(null);
		setSelection(null);
	};

	if (summary === null && loading) {
		return <ReviewState title="Preparing branch review…" />;
	}
	if (summary === null) {
		return <ReviewState title={error ?? "No review is available."} />;
	}

	const viewedCount = summary.files.filter((file) =>
		isViewed(file.path),
	).length;
	const selectedConflict =
		navigation?.path === null || navigation?.path === undefined
			? null
			: (summary.files.find(
					(file) => file.path === navigation.path && file.conflict,
				) ?? null);
	return (
		<section className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 px-2">
				<div className="min-w-0 truncate pl-1 text-[11px] text-muted-foreground">
					<span className="text-foreground">{summary.files.length} files</span>
					<span className="mx-1.5 text-border">·</span>
					{summary.baseRef === null ? "HEAD" : summary.baseRef}
					<span className="mx-1.5 text-border">·</span>
					{viewedCount}/{summary.files.length} viewed
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					<div className="mr-1 tabular-nums text-[11px]">
						<span className="text-emerald-400">+{summary.additions}</span>{" "}
						<span className="text-rose-400">−{summary.deletions}</span>
					</div>
					<ToolbarButton
						label={
							preferences.diffStyle === "split"
								? "Use unified view"
								: "Use split view"
						}
						onClick={() =>
							updatePreferences({
								diffStyle:
									preferences.diffStyle === "split" ? "unified" : "split",
							})
						}
					>
						{preferences.diffStyle === "split" ? <Columns2 /> : <PanelTop />}
					</ToolbarButton>
					<ToolbarButton
						label={
							collapsed.size === summary.files.length
								? "Expand all files"
								: "Collapse all files"
						}
						onClick={() =>
							setCollapsed(
								collapsed.size === summary.files.length
									? new Set()
									: new Set(summary.files.map((file) => file.path)),
							)
						}
					>
						<ChevronsUpDown />
					</ToolbarButton>
					<ToolbarButton
						label="Copy all patches"
						onClick={() =>
							void navigator.clipboard.writeText(
								summary.files
									.map((file) => patches[file.path]?.result.patch ?? "")
									.join("\n"),
							)
						}
					>
						<Copy />
					</ToolbarButton>
					<DisplaySettings
						preferences={preferences}
						onChange={updatePreferences}
					/>
				</div>
			</div>
			{error !== null ? (
				<div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-300">
					Some changes could not be loaded: {error}
				</div>
			) : null}
			{editError !== null ? (
				<div className="border-b border-rose-500/20 bg-rose-500/5 px-3 py-1.5 text-xs text-rose-300">
					{editError}
				</div>
			) : null}
			<div className="relative min-h-0 flex-1 overflow-hidden">
				{items.length === 0 && !loading ? (
					<ReviewState title="No branch changes to review." />
				) : (
					<CodeView<AnnotationMetadata>
						ref={viewerRef}
						items={items}
						selectedLines={selection}
						onSelectedLinesChange={(next) => {
							setSelection(next);
							setAnnotationError(null);
						}}
						createEditor={(options) => new Editor(options)}
						onItemEditChange={(_item, file) => setEditDraft(file)}
						renderHeaderPrefix={renderHeaderPrefix}
						renderHeaderMetadata={renderHeaderMetadata}
						renderAnnotation={(annotation) => {
							const metadata = annotation.metadata;
							if (metadata.kind === "draft") {
								return (
									<form
										onSubmit={saveAnnotation}
										className="m-2 flex max-w-[600px] items-start gap-2.5 rounded-xl border border-border/70 bg-card p-3 font-sans text-card-foreground shadow-[0_2px_4px_rgb(0_0_0_/_0.04),0_4px_10px_rgb(0_0_0_/_0.04)]"
									>
										<div className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/10 text-muted-foreground">
											<UserRound className="size-4" />
										</div>
										<div className="min-w-0 flex-1">
											<textarea
												value={annotationText}
												onChange={(event) =>
													setAnnotationText(event.target.value)
												}
												onKeyDown={(event) => {
													if (event.key === "Escape") {
														setSelection(null);
														setAnnotationText("");
													}
													if (event.key === "Enter" && !event.shiftKey) {
														event.preventDefault();
														event.currentTarget.form?.requestSubmit();
													}
												}}
												placeholder={
													selectedSessionId === null
														? "Open a chat session to comment"
														: "Add a comment…"
												}
												disabled={selectedSessionId === null}
												rows={2}
												className="field-sizing-content min-h-12 w-full resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
											/>
											{annotationError !== null ? (
												<p className="mt-1 text-xs text-rose-400">
													{annotationError}
												</p>
											) : null}
										</div>
										<div className="flex shrink-0 items-center gap-1 self-end">
											<button
												type="button"
												aria-label="Cancel comment"
												title="Cancel (Esc)"
												onClick={() => {
													setSelection(null);
													setAnnotationText("");
												}}
												className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
											>
												<X className="size-3.5" />
											</button>
											<button
												type="submit"
												aria-label="Add comment"
												title="Add comment (Enter)"
												disabled={
													selectedSessionId === null ||
													annotationText.trim().length === 0
												}
												className="grid size-8 place-items-center rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:bg-foreground/10 disabled:text-muted-foreground"
											>
												<Send className="size-3.5" />
											</button>
										</div>
									</form>
								);
							}
							const saved = metadata.annotation;
							return (
								<SavedAnnotationCard
									annotation={saved}
									sessionId={selectedSessionId}
								/>
							);
						}}
						options={{
							diffStyle: preferences.diffStyle,
							overflow: preferences.wrap ? "wrap" : "scroll",
							disableLineNumbers: !preferences.lineNumbers,
							disableBackground: !preferences.backgrounds,
							diffIndicators: preferences.indicators,
							stickyHeaders: true,
							enableLineSelection: true,
							enableGutterUtility: true,
							controlledSelection: true,
							lineHoverHighlight: "number",
							hunkSeparators: "line-info",
							onGutterUtilityClick(range, context) {
								setSelection({ id: context.item.id, range });
								setAnnotationError(null);
							},
						}}
						className="h-full overflow-auto overscroll-contain"
					/>
				)}
				{selectedConflict !== null ? (
					<ConflictReview
						folderId={folderId}
						worktreeId={worktreeId}
						file={selectedConflict}
						onResolved={() => refresh(folderId, worktreeId)}
						onClose={() => useUiStore.getState().openChanges()}
					/>
				) : null}
			</div>
		</section>
	);
}

function ConflictReview({
	folderId,
	worktreeId,
	file,
	onResolved,
	onClose,
}: {
	readonly folderId: FolderId;
	readonly worktreeId: WorktreeId | null;
	readonly file: GitReviewFile;
	readonly onResolved: () => Promise<void>;
	readonly onClose: () => void;
}) {
	const [contents, setContents] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [remaining, setRemaining] = useState(0);
	const [saving, setSaving] = useState(false);
	const countConflicts = useCallback(
		(value: string) => value.match(/^<<<<<<<(?: .*)?$/gm)?.length ?? 0,
		[],
	);
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const client = await getRpcClient();
				const result = await Effect.runPromise(
					client["fs.readFile"]({
						folderId,
						worktreeId,
						path: file.path,
					}),
				);
				if (cancelled) return;
				if (result.kind !== "text") {
					setError(
						"Binary conflicts must be resolved with an external editor.",
					);
					return;
				}
				setContents(result.content);
				setRemaining(countConflicts(result.content));
			} catch (cause) {
				if (!cancelled) setError(String(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [countConflicts, file.path, folderId, worktreeId]);

	const persistResolution = useCallback(
		async (resolvedContents: string) => {
			setSaving(true);
			setError(null);
			try {
				const client = await getRpcClient();
				await Effect.runPromise(
					client["git.resolveConflict"]({
						folderId,
						worktreeId,
						path: file.path,
						contents: resolvedContents,
					}),
				);
				await onResolved();
				onClose();
			} catch (cause) {
				setError(`Could not save the resolved file: ${String(cause)}`);
				setSaving(false);
			}
		},
		[file.path, folderId, onClose, onResolved, worktreeId],
	);
	const conflictOptions = useMemo<UnresolvedFileReactOptions<undefined>>(
		() => ({
			diffIndicators: "bars",
			overflow: "wrap",
			hunkSeparators: "line-info",
		}),
		[],
	);

	return (
		<div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
			<div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
				<button
					type="button"
					onClick={onClose}
					className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
					aria-label="Back to review"
					title="Back to review"
				>
					<ChevronRight className="size-4 rotate-180" />
				</button>
				<CircleAlert className="size-3.5 shrink-0 text-amber-400" />
				<span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
				<span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
					{saving
						? "Saving resolution…"
						: `${remaining} conflict${remaining === 1 ? "" : "s"} remaining`}
				</span>
			</div>
			{error !== null ? (
				<div className="border-b border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
					{error}
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-auto p-3">
				{error !== null && contents === null ? (
					<ReviewState title={error} />
				) : contents === null ? (
					<ReviewState title="Loading conflict…" />
				) : (
					<UnresolvedFile
						file={{ name: file.path, contents }}
						options={conflictOptions}
						renderMergeConflictUtility={(action, getInstance) => {
							const resolve = (resolution: MergeConflictResolution) => {
								const instance = getInstance();
								const result = instance?.resolveConflict(
									action.conflictIndex,
									resolution,
								);
								if (instance === undefined || result === undefined) return;
								instance.render({
									file: result.file,
									actions: result.actions,
									markerRows: result.markerRows,
								});
								const nextRemaining = result.actions.filter(Boolean).length;
								setRemaining(nextRemaining);
								if (nextRemaining === 0) {
									void persistResolution(result.file.contents);
								}
							};
							return (
								<div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
									<ConflictAction onClick={() => resolve("current")}>
										Accept current
									</ConflictAction>
									<span className="text-border">|</span>
									<ConflictAction onClick={() => resolve("incoming")}>
										Accept incoming
									</ConflictAction>
									<span className="text-border">|</span>
									<ConflictAction onClick={() => resolve("both")}>
										Accept both
									</ConflictAction>
								</div>
							);
						}}
						className="mx-auto block w-full max-w-[1400px] overflow-hidden rounded-lg border border-border/60"
					/>
				)}
			</div>
		</div>
	);
}

function ConflictAction({
	onClick,
	children,
}: {
	readonly onClick: () => void;
	readonly children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded px-1 py-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
		>
			{children}
		</button>
	);
}

function SavedAnnotationCard({
	annotation,
	sessionId,
}: {
	readonly annotation: CodeAnnotation;
	readonly sessionId: ReturnType<
		typeof useSessionsStore.getState
	>["selectedSessionId"];
}) {
	const [editing, setEditing] = useState(false);
	const [comment, setComment] = useState(annotation.comment);
	return (
		<div className="m-2 max-w-[680px] rounded-lg border border-border/60 bg-background font-sans text-sm text-foreground shadow-sm">
			<div className="flex items-center gap-2 px-3 pt-3">
				<div className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground/10 text-muted-foreground">
					<UserRound className="size-3.5" />
				</div>
				<strong className="font-medium">You</strong>
				<span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
					<Sparkles className="size-2.5" /> Annotation for AI
				</span>
				<span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
					{annotation.startLine === annotation.endLine
						? `Line ${annotation.startLine}`
						: `Lines ${annotation.startLine}–${annotation.endLine}`}
				</span>
			</div>
			<div className="px-3 pb-2 pl-12">
				{editing ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (sessionId === null) return;
							useAnnotationsStore
								.getState()
								.updateComment(sessionId, annotation.id, comment);
							setEditing(false);
						}}
						className="mt-2 flex gap-1.5"
					>
						<input
							value={comment}
							onChange={(event) => setComment(event.target.value)}
							className="h-9 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm outline-none focus:border-foreground/30"
						/>
						<Button type="submit" size="sm">
							Save
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								setComment(annotation.comment);
								setEditing(false);
							}}
						>
							Cancel
						</Button>
					</form>
				) : (
					<p className="mt-2 whitespace-pre-wrap leading-5">
						{annotation.comment}
					</p>
				)}
			</div>
			{!editing ? (
				<div className="flex items-center gap-1 border-t border-border/50 px-3 py-1.5 pl-12">
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
					>
						Edit
					</button>
					<button
						type="button"
						onClick={() =>
							sessionId !== null &&
							useAnnotationsStore.getState().remove(sessionId, annotation.id)
						}
						className="rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-rose-500/10 hover:text-rose-400"
					>
						Delete
					</button>
				</div>
			) : null}
		</div>
	);
}

function ReviewState({ title }: { readonly title: string }) {
	return (
		<div className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground">
			{title}
		</div>
	);
}

function FileActionsMenu({
	file,
	editing,
	onEdit,
	onDiscard,
	onRestore,
}: {
	readonly file: GitReviewFile;
	readonly editing: boolean;
	readonly onEdit: () => void;
	readonly onDiscard: () => void;
	readonly onRestore: () => void;
}) {
	return (
		<Popover>
			<PopoverTrigger
				aria-label={`Actions for ${file.path}`}
				title="File actions"
				className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground data-[popup-open]:bg-foreground/10"
			>
				<MoreHorizontal className="size-3.5" />
			</PopoverTrigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					className="z-50"
				>
					<PopoverPrimitive.Popup className="w-52 rounded-md border border-border/70 bg-popover p-1 text-xs text-popover-foreground shadow-lg outline-none">
						{!file.binary && file.kind !== "deleted" && !file.conflict ? (
							<FileMenuAction icon={FilePenLine} onClick={onEdit}>
								{editing ? "Return to diff" : "Edit file"}
							</FileMenuAction>
						) : null}
						{file.hasUncommittedChanges ? (
							<FileMenuAction destructive icon={RotateCcw} onClick={onDiscard}>
								Discard uncommitted changes
							</FileMenuAction>
						) : null}
						<FileMenuAction destructive icon={RotateCcw} onClick={onRestore}>
							Restore to comparison base
						</FileMenuAction>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</Popover>
	);
}

function FileMenuAction({
	icon: Icon,
	destructive = false,
	onClick,
	children,
}: {
	readonly icon: React.ComponentType<{ className?: string }>;
	readonly destructive?: boolean;
	readonly onClick: () => void;
	readonly children: React.ReactNode;
}) {
	return (
		<PopoverPrimitive.Close
			onClick={onClick}
			className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left ${
				destructive
					? "text-rose-400 hover:bg-rose-500/10"
					: "text-foreground hover:bg-foreground/5"
			}`}
		>
			<Icon className="size-3.5 shrink-0" />
			<span>{children}</span>
		</PopoverPrimitive.Close>
	);
}

function DisplaySettings({
	preferences,
	onChange,
}: {
	readonly preferences: ReviewPreferences;
	readonly onChange: (patch: Partial<ReviewPreferences>) => void;
}) {
	return (
		<Popover>
			<PopoverTrigger
				aria-label="Display settings"
				title="Display settings"
				className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground data-[popup-open]:bg-foreground/10 data-[popup-open]:text-foreground"
			>
				<Settings2 className="size-3.5" />
			</PopoverTrigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className="z-50"
				>
					<PopoverPrimitive.Popup className="w-60 rounded-lg border border-border/70 bg-popover p-3 text-popover-foreground shadow-xl/15 outline-none">
						<div className="flex flex-col gap-1">
							<DisplaySwitch
								label="Backgrounds"
								checked={preferences.backgrounds}
								onCheckedChange={(backgrounds) => onChange({ backgrounds })}
							/>
							<DisplaySwitch
								label="Line numbers"
								checked={preferences.lineNumbers}
								onCheckedChange={(lineNumbers) => onChange({ lineNumbers })}
							/>
							<DisplaySwitch
								label="Word wrap"
								checked={preferences.wrap}
								onCheckedChange={(wrap) => onChange({ wrap })}
							/>
						</div>
						<div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
							<span className="text-xs text-muted-foreground">Indicators</span>
							<div className="flex rounded-md bg-foreground/5 p-0.5">
								{(
									[
										["bars", Rows3, "Bars"],
										["classic", SquarePlus, "Classic"],
										["none", EyeOff, "Hidden"],
									] as const
								).map(([value, Icon, label]) => (
									<button
										key={value}
										type="button"
										aria-label={`${label} indicators`}
										aria-pressed={preferences.indicators === value}
										title={label}
										onClick={() => onChange({ indicators: value })}
										className={`grid size-7 place-items-center rounded-[5px] transition-colors ${
											preferences.indicators === value
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										}`}
									>
										<Icon className="size-3.5" />
									</button>
								))}
							</div>
						</div>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</Popover>
	);
}

function DisplaySwitch({
	label,
	checked,
	onCheckedChange,
}: {
	readonly label: string;
	readonly checked: boolean;
	readonly onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex h-9 items-center justify-between gap-4 rounded-md px-1 text-xs text-muted-foreground">
			<span>{label}</span>
			<Switch
				aria-label={label}
				checked={checked}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}

function ToolbarButton({
	active = false,
	label,
	onClick,
	children,
}: {
	readonly active?: boolean;
	readonly label: string;
	readonly onClick: () => void;
	readonly children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={active}
			onClick={onClick}
			className={`rounded p-1.5 transition-colors ${
				active
					? "bg-foreground/10 text-foreground"
					: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
			}`}
		>
			<span className="block size-3.5 [&>svg]:size-3.5">{children}</span>
		</button>
	);
}
