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
	Check,
	ChevronDown,
	ChevronRight,
	Columns2,
	Copy,
	FilePenLine,
	MessageSquarePlus,
	PanelTop,
	RotateCcw,
	Save,
	WrapText,
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
	const navigation = useUiStore((state) => state.reviewNavigation);
	const viewerRef = useRef<CodeViewHandle<AnnotationMetadata>>(null);
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

	const renderHeaderMetadata = useCallback(
		(item: CodeViewItem<AnnotationMetadata>) => {
			const file = fileByPath.get(item.id);
			if (file === undefined) return null;
			const editing = editingPath === item.id;
			return (
				<div className="flex items-center gap-1 pr-2 text-[11px]">
					<span className="tabular-nums text-emerald-400">
						+{file.additions}
					</span>
					<span className="tabular-nums text-rose-400">−{file.deletions}</span>
					{!file.binary && file.kind !== "deleted" && !file.conflict ? (
						<HeaderButton
							label={editing ? "Return to diff" : "Edit file"}
							onClick={() => (editing ? leaveEdit() : void enterEdit(file))}
						>
							<FilePenLine />
						</HeaderButton>
					) : null}
					{editing ? (
						<HeaderButton label="Save edit" onClick={() => void saveEdit()}>
							<Save />
						</HeaderButton>
					) : null}
					<HeaderButton
						label={isViewed(file.path) ? "Mark unviewed" : "Mark viewed"}
						active={isViewed(file.path)}
						onClick={() => toggleViewed(file.path)}
					>
						<Check />
					</HeaderButton>
					<HeaderButton
						label="Copy patch"
						onClick={() =>
							void navigator.clipboard.writeText(
								patches[file.path]?.result.patch ?? "",
							)
						}
					>
						<Copy />
					</HeaderButton>
					<HeaderButton
						label={collapsed.has(file.path) ? "Expand file" : "Collapse file"}
						onClick={() =>
							setCollapsed((current) => {
								const next = new Set(current);
								if (next.has(file.path)) next.delete(file.path);
								else next.add(file.path);
								return next;
							})
						}
					>
						{collapsed.has(file.path) ? <ChevronRight /> : <ChevronDown />}
					</HeaderButton>
					{file.hasUncommittedChanges ? (
						<HeaderButton
							label="Discard uncommitted edits"
							destructive
							onClick={() => void discardUncommitted(file)}
						>
							<RotateCcw />
						</HeaderButton>
					) : null}
					<HeaderButton
						label="Restore file to comparison base"
						destructive
						onClick={() => void restoreToBase(file)}
					>
						<RotateCcw />
					</HeaderButton>
				</div>
			);
		},
		[
			collapsed,
			discardUncommitted,
			editingPath,
			enterEdit,
			fileByPath,
			isViewed,
			leaveEdit,
			patches,
			restoreToBase,
			saveEdit,
			toggleViewed,
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
			<div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
				<div className="mr-2 min-w-0">
					<h1 className="text-sm font-medium">All changes</h1>
					<p className="truncate text-[11px] text-muted-foreground">
						{summary.baseRef === null
							? "Compared with HEAD"
							: `Compared with merge base of ${summary.baseRef}`}
						{` · ${summary.files.length} files · ${viewedCount}/${summary.files.length} viewed`}
					</p>
				</div>
				<ToolbarButton
					active={preferences.diffStyle === "split"}
					label="Split view"
					onClick={() => updatePreferences({ diffStyle: "split" })}
				>
					<Columns2 />
				</ToolbarButton>
				<ToolbarButton
					active={preferences.diffStyle === "unified"}
					label="Unified view"
					onClick={() => updatePreferences({ diffStyle: "unified" })}
				>
					<PanelTop />
				</ToolbarButton>
				<ToolbarButton
					active={preferences.wrap}
					label="Word wrap"
					onClick={() => updatePreferences({ wrap: !preferences.wrap })}
				>
					<WrapText />
				</ToolbarButton>
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						updatePreferences({ lineNumbers: !preferences.lineNumbers })
					}
				>
					Lines {preferences.lineNumbers ? "on" : "off"}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						updatePreferences({ backgrounds: !preferences.backgrounds })
					}
				>
					Background {preferences.backgrounds ? "on" : "off"}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						updatePreferences({
							indicators:
								preferences.indicators === "bars"
									? "classic"
									: preferences.indicators === "classic"
										? "none"
										: "bars",
						})
					}
				>
					Indicators: {preferences.indicators}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						setCollapsed(
							collapsed.size === summary.files.length
								? new Set()
								: new Set(summary.files.map((file) => file.path)),
						)
					}
				>
					{collapsed.size === summary.files.length
						? "Expand all"
						: "Collapse all"}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						void navigator.clipboard.writeText(
							summary.files
								.map((file) => patches[file.path]?.result.patch ?? "")
								.join("\n"),
						)
					}
				>
					<Copy className="size-3.5" /> Copy patch
				</Button>
				<div className="ml-auto tabular-nums text-xs">
					<span className="text-emerald-400">+{summary.additions}</span>{" "}
					<span className="text-rose-400">−{summary.deletions}</span>
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
			<div className="relative min-h-0 flex-1">
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
						renderHeaderMetadata={renderHeaderMetadata}
						renderAnnotation={(annotation) => {
							const metadata = annotation.metadata;
							if (metadata.kind === "draft") {
								return (
									<form
										onSubmit={saveAnnotation}
										className="m-2 flex max-w-xl flex-col gap-2 rounded-md border border-border bg-background p-2 shadow-lg"
									>
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
													? "Open a chat session to annotate"
													: "Leave a comment…"
											}
											disabled={selectedSessionId === null}
											className="min-h-16 resize-y bg-transparent text-xs outline-none"
										/>
										{annotationError !== null ? (
											<p className="text-xs text-rose-400">{annotationError}</p>
										) : null}
										<div className="flex justify-end gap-1">
											<Button
												type="button"
												size="sm"
												variant="ghost"
												onClick={() => setSelection(null)}
											>
												Cancel
											</Button>
											<Button
												type="submit"
												size="sm"
												disabled={selectedSessionId === null}
											>
												<MessageSquarePlus className="size-3.5" /> Add
											</Button>
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
							controlledSelection: true,
							lineHoverHighlight: "both",
							hunkSeparators: "line-info",
						}}
						className="h-full"
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
			} catch (cause) {
				if (!cancelled) setError(String(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [file.path, folderId, worktreeId]);

	return (
		<div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
				<Button size="sm" variant="ghost" onClick={onClose}>
					Back to review
				</Button>
				<span className="truncate font-mono text-xs">Resolve {file.path}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{error !== null ? (
					<ReviewState title={error} />
				) : contents === null ? (
					<ReviewState title="Loading conflict…" />
				) : (
					<UnresolvedFile
						file={{ name: file.path, contents }}
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
								if (result.actions.filter(Boolean).length > 0) return;
								void (async () => {
									const client = await getRpcClient();
									await Effect.runPromise(
										client["git.resolveConflict"]({
											folderId,
											worktreeId,
											path: file.path,
											contents: result.file.contents,
										}),
									);
									await onResolved();
									onClose();
								})();
							};
							return (
								<div className="flex gap-1 p-1">
									{(["current", "incoming", "both"] as const).map(
										(resolution) => (
											<Button
												key={resolution}
												size="sm"
												variant="outline"
												onClick={() => resolve(resolution)}
											>
												{resolution === "current"
													? "Ours"
													: resolution === "incoming"
														? "Theirs"
														: "Both"}
											</Button>
										),
									)}
								</div>
							);
						}}
					/>
				)}
			</div>
		</div>
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
		<div className="m-2 max-w-xl rounded-md border border-border bg-background p-2 text-xs shadow-sm">
			<div className="mb-1 flex items-center justify-between text-muted-foreground">
				<span>
					{annotation.relPath}:{annotation.startLine}
				</span>
				<span className="flex gap-1">
					<button
						type="button"
						onClick={() => setEditing((value) => !value)}
						className="rounded px-1 hover:bg-foreground/10 hover:text-foreground"
					>
						{editing ? "Cancel" : "Edit"}
					</button>
					<button
						type="button"
						onClick={() =>
							sessionId !== null &&
							useAnnotationsStore.getState().remove(sessionId, annotation.id)
						}
						className="rounded px-1 hover:bg-foreground/10 hover:text-rose-400"
					>
						Delete
					</button>
				</span>
			</div>
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
					className="flex gap-1"
				>
					<input
						value={comment}
						onChange={(event) => setComment(event.target.value)}
						className="h-7 min-w-0 flex-1 rounded border border-border bg-transparent px-2 outline-none"
					/>
					<Button type="submit" size="sm">
						Save
					</Button>
				</form>
			) : (
				annotation.comment
			)}
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

function ToolbarButton({
	active,
	label,
	onClick,
	children,
}: {
	readonly active: boolean;
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

function HeaderButton({
	label,
	active = false,
	destructive = false,
	onClick,
	children,
}: {
	readonly label: string;
	readonly active?: boolean;
	readonly destructive?: boolean;
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
			className={`rounded p-1 transition-colors [&>svg]:size-3 ${
				destructive
					? "text-muted-foreground hover:bg-rose-500/10 hover:text-rose-400"
					: active
						? "bg-foreground/10 text-foreground"
						: "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
			}`}
		>
			{children}
		</button>
	);
}
