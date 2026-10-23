"use client";

import "./guided-review-demo.css";
import {
	DEFAULT_THEMES,
	type DiffLineAnnotation,
	type SelectedLineRange,
} from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import {
	BookOpen,
	ChevronDown,
	ChevronRight,
	FileCode2,
	FileText,
	MessageSquare,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import {
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/* The guide written for Zuse's own guided-review pull request, over that
   pull request's real diff. Generated once into /demo/guided-review.json. */

type SketchLine = {
	kind: "context" | "add" | "remove";
	indent: number;
	code: string;
	note?: string;
	chapter?: string;
};
type Chapter = {
	id: string;
	title: string;
	paragraphs: string[];
	files: string[];
	hints?: string[];
};
type Group = { id: string; title: string; summary: string; files?: string[] };
type DemoData = {
	guide: {
		title: string;
		author: string;
		model: string;
		base: string;
		head: string;
		overview: {
			context: string;
			steps: string[];
			beforeAfter: { caption: string; lines: SketchLine[] };
		};
		chapters: Chapter[];
		groups: Group[];
	};
	files: Record<string, DemoFile>;
};
type DemoFile = { additions: number; deletions: number; patch: string };
type Side = "additions" | "deletions";
type DemoComment = {
	id: string;
	path: string;
	side: Side;
	line: number;
	body: string;
};
/** An open comment box: on which file, in which chapter or the full diff. */
type Draft = { path: string; scope: string; range: SelectedLineRange };
type CommentMeta =
	| { kind: "saved"; comment: DemoComment }
	| { kind: "draft"; range: SelectedLineRange };

const NO_COMMENTS: DemoComment[] = [];
const COMMENTS_KEY = "zuse:guided-review-demo:comments";
const anchorOf = (range: SelectedLineRange) => ({
	side: range.endSide ?? range.side ?? "additions",
	lineNumber: range.end,
});
type Mode = "overview" | "guide" | "diff";
type Section = Chapter & { group?: boolean };

const DIFF_CSS = `
:host { --diffs-bg: transparent; --diffs-bg-buffer-override: transparent; --diffs-bg-context-override: transparent; background: transparent; }
[data-diffs-header] { background-color: hsl(136 5% 7.5%); border-bottom: 1px solid hsl(132 5% 13%); border-radius: 0; }
[data-change-icon] { display: none; }
[data-separator="line-info"] { height: 26px; font-size: 11px; }
[data-utility-button] { background-color: hsl(78 70% 52%); color: hsl(80 40% 8%); }
`;

const BASE_DIFF_OPTIONS = {
	theme: DEFAULT_THEMES,
	themeType: "dark",
	diffStyle: "unified",
	overflow: "wrap",
	stickyHeader: true,
	hunkSeparators: "line-info",
	lineHoverHighlight: "number",
	unsafeCSS: DIFF_CSS,
	// Hovering a line number shows a + that starts a comment on it.
	enableGutterUtility: true,
} as const;

const two = (n: number) => String(n).padStart(2, "0");
const splitPath = (path: string) => {
	const slash = path.lastIndexOf("/");
	return { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) };
};
const extension = (path: string) => path.slice(path.lastIndexOf(".") + 1);

function Prose({ text }: { text: string }) {
	return (
		<>
			{text.split(/(`[^`\n]+`)/g).map((part, index) =>
				part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional parts
					<code key={index}>{part.slice(1, -1)}</code>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional parts
					<Fragment key={index}>{part}</Fragment>
				),
			)}
		</>
	);
}

function Stat({ add, del }: { add: number; del: number }) {
	return (
		<span className="grd-stat">
			{add > 0 ? <span className="grd-a">+{add}</span> : null}
			{add > 0 && del > 0 ? " " : null}
			{del > 0 ? <span className="grd-d">−{del}</span> : null}
		</span>
	);
}

function Check({
	on,
	onToggle,
	label = "Reviewed",
}: {
	on: boolean;
	onToggle: () => void;
	label?: string;
}) {
	return (
		<label className={`grd-check${on ? " grd-on" : ""}`}>
			<input
				type="checkbox"
				className="grd-sr"
				checked={on}
				onChange={onToggle}
			/>
			<span className="grd-box" />
			{label}
		</label>
	);
}

/**
 * A small write-and-send box, for review comments and questions alike.
 * Esc cancels and ⌘/Ctrl+Enter sends.
 */
function ReplyBox({
	initial = "",
	placeholder,
	submitLabel,
	rows = 2,
	onSubmit,
	onCancel,
}: {
	initial?: string;
	placeholder: string;
	submitLabel: string;
	rows?: number;
	onSubmit: (body: string) => void;
	onCancel: () => void;
}) {
	const [body, setBody] = useState(initial);
	const ref = useRef<HTMLTextAreaElement>(null);
	// Focus once the box has been placed: diff annotations mount before the
	// diff moves them under their line, which drops a plain autoFocus.
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const element = ref.current;
			element?.focus();
			element?.setSelectionRange(element.value.length, element.value.length);
		});
		return () => cancelAnimationFrame(frame);
	}, []);
	const submit = () => {
		if (body.trim().length > 0) onSubmit(body.trim());
	};
	return (
		<div className="grd-comment">
			<textarea
				ref={ref}
				rows={rows}
				value={body}
				placeholder={placeholder}
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") onCancel();
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
						submit();
				}}
			/>
			<div className="grd-comment-actions">
				<button type="button" className="grd-ghost" onClick={onCancel}>
					Cancel
				</button>
				<button
					type="button"
					className="grd-primary"
					disabled={body.trim().length === 0}
					onClick={submit}
				>
					{submitLabel}
				</button>
			</div>
		</div>
	);
}

function CommentCard({
	comment,
	onDelete,
}: {
	comment: DemoComment;
	onDelete: () => void;
}) {
	return (
		<div className="grd-comment">
			<div className="grd-comment-head">
				<span className="grd-you">Y</span>
				<b>You</b>
				<span className="grd-mono">Line {comment.line}</span>
				<button
					type="button"
					className="grd-icon-btn"
					aria-label="Delete comment"
					onClick={onDelete}
				>
					<Trash2 aria-hidden />
				</button>
			</div>
			<p>{comment.body}</p>
		</div>
	);
}

/** One file's diff, collapsed once reviewed and mounted only near the viewport. */
function FileDiffCard({
	path,
	file,
	reviewed,
	onReviewed,
	startCollapsed = false,
	comments,
	draft,
	onStartComment,
	onSaveComment,
	onCancelComment,
	onDeleteComment,
}: {
	path: string;
	file: DemoFile | undefined;
	reviewed: boolean;
	onReviewed: () => void;
	startCollapsed?: boolean;
	comments: DemoComment[];
	/** The open comment box, when it belongs to this card. */
	draft: SelectedLineRange | null;
	onStartComment: (range: SelectedLineRange) => void;
	onSaveComment: (body: string) => void;
	onCancelComment: () => void;
	onDeleteComment: (id: string) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	// null follows the default: collapsed when reviewed or set aside.
	const [expanded, setExpanded] = useState<boolean | null>(null);
	useEffect(() => {
		if (reviewed) setExpanded(null);
	}, [reviewed]);
	const open = expanded ?? !(reviewed || startCollapsed);
	useEffect(() => {
		const element = ref.current;
		// The wrapper only exists while the file is open, so look again
		// whenever it opens.
		if (!open || element === null || near) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setNear(true);
			},
			{ rootMargin: "1200px 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [near, open]);
	const { name, dir } = splitPath(path);
	const options = useMemo(
		() => ({ ...BASE_DIFF_OPTIONS, onGutterUtilityClick: onStartComment }),
		[onStartComment],
	);
	const annotations = useMemo(() => {
		const list: DiffLineAnnotation<CommentMeta>[] = comments.map((comment) => ({
			side: comment.side,
			lineNumber: comment.line,
			metadata: { kind: "saved", comment },
		}));
		if (draft !== null)
			list.push({
				...anchorOf(draft),
				metadata: { kind: "draft", range: draft },
			});
		return list;
	}, [comments, draft]);

	if (!open)
		return (
			<div className="grd-collapsed">
				<button
					type="button"
					className="grd-expand"
					onClick={() => setExpanded(true)}
				>
					<ChevronRight className="grd-chev" aria-hidden />
					<span className="grd-ficon">{extension(path).slice(0, 2)}</span>
					<span>{name}</span>
					<span className="grd-dir">{dir}</span>
					<Stat add={file?.additions ?? 0} del={file?.deletions ?? 0} />
				</button>
				<Check on={reviewed} onToggle={onReviewed} />
			</div>
		);
	return (
		<div ref={ref} className="grd-diff">
			{near ? (
				<PatchDiff<CommentMeta>
					patch={file?.patch ?? ""}
					disableWorkerPool
					options={options}
					lineAnnotations={annotations}
					selectedLines={draft}
					renderAnnotation={(annotation) =>
						annotation.metadata.kind === "draft" ? (
							<ReplyBox
								placeholder="Leave a review comment…"
								submitLabel="Comment"
								onSubmit={onSaveComment}
								onCancel={onCancelComment}
							/>
						) : (
							<CommentCard
								comment={annotation.metadata.comment}
								onDelete={() =>
									annotation.metadata.kind === "saved" &&
									onDeleteComment(annotation.metadata.comment.id)
								}
							/>
						)
					}
					renderHeaderMetadata={() => (
						<Check on={reviewed} onToggle={onReviewed} />
					)}
				/>
			) : (
				<div style={{ height: 160 }} />
			)}
		</div>
	);
}

/**
 * Questions to the agent that wrote a chapter. In Zuse they open that chat
 * with the chapter attached; here the question is kept on the page.
 */
function AskAuthor({
	chapter,
	hints,
	openCount,
}: {
	chapter: string;
	hints: string[];
	/** Bumped by the chapter's "Ask author" button to open an empty box. */
	openCount: number;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	useEffect(() => {
		if (openCount > 0) setDraft((current) => current ?? "");
	}, [openCount]);
	const [asked, setAsked] = useState<string[]>([]);
	return (
		<div className="grd-ask">
			{hints.map((hint) => (
				<button
					key={hint}
					type="button"
					className="grd-hint"
					onClick={() => setDraft(hint)}
				>
					{hint}
				</button>
			))}
			{asked.map((question) => (
				<div key={question} className="grd-asked">
					<p>{question}</p>
					<span className="grd-asked-note">
						In Zuse, this goes to the chat that wrote “{chapter}”, with the
						chapter attached. <Link href="/download">Try it in Zuse</Link>
					</span>
				</div>
			))}
			{draft !== null ? (
				<ReplyBox
					key={draft}
					initial={draft}
					rows={3}
					placeholder={`Ask about “${chapter}”…`}
					submitLabel="Ask"
					onSubmit={(question) => {
						setAsked((current) => [...current, question]);
						setDraft(null);
					}}
					onCancel={() => setDraft(null)}
				/>
			) : null}
		</div>
	);
}

export function GuidedReviewDemo() {
	const [data, setData] = useState<DemoData | null>(null);
	const [failed, setFailed] = useState(false);
	const [mode, setMode] = useState<Mode>("overview");
	const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
	const [sketchOpen, setSketchOpen] = useState(true);
	const [comments, setComments] = useState<DemoComment[]>([]);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [askCounts, setAskCounts] = useState<Record<string, number>>({});
	const scrollRef = useRef<HTMLDivElement>(null);
	const pendingRef = useRef<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void fetch("/demo/guided-review.json")
			.then((response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.json() as Promise<DemoData>;
			})
			.then(
				(next) => {
					if (!cancelled) setData(next);
				},
				() => {
					if (!cancelled) setFailed(true);
				},
			);
		return () => {
			cancelled = true;
		};
	}, []);

	// Comments stay in this browser, so a reload keeps the review going.
	useEffect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(COMMENTS_KEY) ?? "[]");
			if (Array.isArray(saved)) setComments(saved as DemoComment[]);
		} catch {}
	}, []);
	const updateComments = useCallback(
		(update: (current: DemoComment[]) => DemoComment[]) =>
			setComments((current) => {
				const next = update(current);
				try {
					localStorage.setItem(COMMENTS_KEY, JSON.stringify(next));
				} catch {
					// Blocked or full storage: comments still work for this visit.
				}
				return next;
			}),
		[],
	);
	const commentsByPath = useMemo(() => {
		const map = new Map<string, DemoComment[]>();
		for (const comment of comments)
			map.set(comment.path, [...(map.get(comment.path) ?? []), comment]);
		return map;
	}, [comments]);
	const saveDraft = useCallback(
		(body: string) => {
			if (draft === null) return;
			const anchor = anchorOf(draft.range);
			updateComments((current) => [
				...current,
				{
					id: crypto.randomUUID(),
					path: draft.path,
					side: anchor.side,
					line: anchor.lineNumber,
					body,
				},
			]);
			setDraft(null);
		},
		[draft, updateComments],
	);
	const deleteComment = useCallback(
		(id: string) =>
			updateComments((current) =>
				current.filter((comment) => comment.id !== id),
			),
		[updateComments],
	);
	const cancelDraft = useCallback(() => setDraft(null), []);
	const startHandlers = useRef(
		new Map<string, (range: SelectedLineRange) => void>(),
	);
	/** One stable start handler per card, so diffs don't re-render. */
	const startCommentFor = (path: string, scope: string) => {
		const key = `${scope}\0${path}`;
		let handler = startHandlers.current.get(key);
		if (handler === undefined) {
			handler = (range) => setDraft({ path, scope, range });
			startHandlers.current.set(key, handler);
		}
		return handler;
	};
	const diffCard = (path: string, scope: string, startCollapsed = false) => (
		<FileDiffCard
			path={path}
			file={data?.files[path]}
			reviewed={reviewed.has(path)}
			onReviewed={() => toggleFile(path)}
			startCollapsed={startCollapsed}
			comments={commentsByPath.get(path) ?? NO_COMMENTS}
			draft={
				draft !== null && draft.path === path && draft.scope === scope
					? draft.range
					: null
			}
			onStartComment={startCommentFor(path, scope)}
			onSaveComment={saveDraft}
			onCancelComment={cancelDraft}
			onDeleteComment={deleteComment}
		/>
	);

	const sections: Section[] = useMemo(() => {
		if (data === null) return [];
		return [
			...data.guide.chapters,
			...data.guide.groups
				.filter((group) => (group.files?.length ?? 0) > 0)
				.map((group) => ({
					id: group.id,
					title: group.title,
					paragraphs: [group.summary],
					files: group.files ?? [],
					group: true,
				})),
		];
	}, [data]);
	const core = sections.filter((section) => !section.group);
	const numberOf = useMemo(
		() => new Map(core.map((chapter, index) => [chapter.id, index + 1])),
		[core],
	);
	const allFiles = data === null ? [] : Object.keys(data.files);

	const toggleFile = useCallback((path: string) => {
		setReviewed((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);
	const toggleChapter = useCallback((files: string[]) => {
		setReviewed((current) => {
			const done = files.every((path) => current.has(path));
			const next = new Set(current);
			for (const path of files) {
				if (done) next.delete(path);
				else next.add(path);
			}
			return next;
		});
	}, []);

	const show = useCallback((next: Mode) => {
		setMode(next);
	}, []);
	useEffect(() => {
		const pending = pendingRef.current;
		pendingRef.current = null;
		if (mode === "guide" && pending !== null)
			requestAnimationFrame(() =>
				document
					.getElementById(`grd-${pending}`)
					?.scrollIntoView({ block: "start" }),
			);
		else scrollRef.current?.scrollTo({ top: 0 });
	}, [mode]);
	const openChapter = useCallback(
		(id: string) => {
			if (mode === "guide") {
				document
					.getElementById(`grd-${id}`)
					?.scrollIntoView({ behavior: "smooth", block: "start" });
				return;
			}
			pendingRef.current = id;
			setMode("guide");
		},
		[mode],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (target?.isContentEditable || target?.closest("input, textarea"))
				return;
			if (event.key === "1" || event.key === "2" || event.key === "3") {
				show(
					(["overview", "guide", "diff"] as const)[Number(event.key) - 1] ??
						"overview",
				);
				return;
			}
			if (mode !== "guide" || (event.key !== "j" && event.key !== "k")) return;
			const container = scrollRef.current;
			if (container === null) return;
			const top = container.getBoundingClientRect().top + 48;
			const tops = sections.map(
				(section) =>
					document.getElementById(`grd-${section.id}`)?.getBoundingClientRect()
						.top ?? Number.POSITIVE_INFINITY,
			);
			const current = tops.findLastIndex((value) => value <= top);
			const next =
				sections[current + (event.key === "j" ? 1 : current < 0 ? 0 : -1)];
			if (next === undefined) return;
			event.preventDefault();
			document
				.getElementById(`grd-${next.id}`)
				?.scrollIntoView({ behavior: "smooth", block: "start" });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [mode, sections, show]);

	const totals = useMemo(() => {
		if (data === null) return { add: 0, del: 0 };
		return Object.values(data.files).reduce(
			(sum, file) => ({
				add: sum.add + file.additions,
				del: sum.del + file.deletions,
			}),
			{ add: 0, del: 0 },
		);
	}, [data]);
	const sectionStats = (files: string[]) =>
		files.reduce(
			(sum, path) => ({
				add: sum.add + (data?.files[path]?.additions ?? 0),
				del: sum.del + (data?.files[path]?.deletions ?? 0),
			}),
			{ add: 0, del: 0 },
		);

	return (
		<div className="grd">
			<header className="grd-bar">
				<Link href="/" className="grd-brand">
					Zuse
				</Link>
				<span className="grd-crumb">/</span>
				<span className="grd-crumb">Guided review demo</span>
				<div className="grd-progress">
					<div className="grd-meter">
						<i
							style={{
								width: `${allFiles.length === 0 ? 0 : (reviewed.size / allFiles.length) * 100}%`,
							}}
						/>
					</div>
					<span>
						<b>{reviewed.size}</b> / {allFiles.length} reviewed
					</span>
					{comments.length > 0 ? (
						<span className="grd-comment-count">
							<MessageSquare aria-hidden />
							{comments.length}
						</span>
					) : null}
				</div>
				<Link href="/download" className="grd-download">
					Download Zuse
				</Link>
			</header>

			<div ref={scrollRef} className="grd-scroll">
				<div className="grd-page">
					{data === null ? (
						<div className="grd-loading">
							{failed
								? "The demo couldn’t load. Refresh to try again."
								: "Loading the guide…"}
						</div>
					) : mode === "overview" ? (
						<>
							<h1>{data.guide.title}</h1>
							<div className="grd-byline">
								<span className="grd-author-logo" aria-hidden />
								<span style={{ color: "var(--grd-fg)" }}>
									{data.guide.author}
								</span>
								<span className="grd-mono">{data.guide.model}</span>
								<span className="grd-sep" />
								<span className="grd-mono">
									{data.guide.head} → {data.guide.base}
								</span>
								<span className="grd-sep" />
								<Stat add={totals.add} del={totals.del} />
								<span className="grd-sep" />
								<span>{allFiles.length} files</span>
							</div>
							<p className="grd-note-line">
								This is the guide for the pull request that built guided
								reviews, over its real diff. Hover a line number and press + to
								leave a comment.
							</p>
							<section className="grd-grid" style={{ paddingTop: 40 }}>
								<div className="grd-col">
									<h2>Overview</h2>
									<p className="grd-prose">
										<Prose text={data.guide.overview.context} />
									</p>
									<ol className="grd-steps grd-prose">
										{data.guide.overview.steps.map((step, index) => (
											<li key={step}>
												<span className="grd-n">{index + 1}.</span>
												<span>
													<Prose text={step} />
												</span>
											</li>
										))}
									</ol>
								</div>
								<div className={`grd-card${sketchOpen ? "" : " grd-closed"}`}>
									<button
										type="button"
										className="grd-card-head"
										onClick={() => setSketchOpen((open) => !open)}
									>
										<ChevronDown className="grd-chev" aria-hidden />
										<span style={{ fontWeight: 500 }}>Before / after</span>
										<Stat
											add={
												data.guide.overview.beforeAfter.lines.filter(
													(line) => line.kind === "add",
												).length
											}
											del={
												data.guide.overview.beforeAfter.lines.filter(
													(line) => line.kind === "remove",
												).length
											}
										/>
									</button>
									{sketchOpen ? (
										<div className="grd-sketch">
											<p className="grd-caption">
												{data.guide.overview.beforeAfter.caption}
											</p>
											{data.guide.overview.beforeAfter.lines.map(
												(line, index) => {
													const number = line.chapter
														? numberOf.get(line.chapter)
														: undefined;
													return (
														<div
															// biome-ignore lint/suspicious/noArrayIndexKey: ordered sketch
															key={index}
															className={`grd-sl${line.kind === "add" ? " grd-add" : line.kind === "remove" ? " grd-rem" : ""}`}
														>
															<span className="grd-sign">
																{line.kind === "add"
																	? "+"
																	: line.kind === "remove"
																		? "−"
																		: ""}
															</span>
															<span
																className="grd-code"
																style={{ paddingLeft: line.indent * 16 }}
															>
																<span>{line.code}</span>
															</span>
															{line.note ? (
																<span className="grd-note">{line.note}</span>
															) : null}
															{number !== undefined && line.chapter ? (
																<button
																	type="button"
																	className="grd-tag"
																	onClick={() =>
																		openChapter(line.chapter ?? "")
																	}
																>
																	{two(number)}
																</button>
															) : null}
														</div>
													);
												},
											)}
										</div>
									) : null}
								</div>
							</section>
							<section className="grd-toc">
								<h2>In this guide</h2>
								<div className="grd-toc-grid">
									{sections.map((section) => {
										const stats = sectionStats(section.files);
										const done = section.files.every((path) =>
											reviewed.has(path),
										);
										return (
											<button
												key={section.id}
												type="button"
												className="grd-toc-card"
												onClick={() => openChapter(section.id)}
											>
												<span className={`grd-ring${done ? " grd-on" : ""}`} />
												<span className="grd-num">
													{section.group
														? "Also changed"
														: `${two(numberOf.get(section.id) ?? 0)} / ${two(core.length)}`}
												</span>
												<span className="grd-t">{section.title}</span>
												<span className="grd-m">
													{section.files.length}{" "}
													{section.files.length === 1 ? "file" : "files"} ·{" "}
													<Stat add={stats.add} del={stats.del} />
												</span>
											</button>
										);
									})}
								</div>
							</section>
						</>
					) : mode === "guide" ? (
						sections.map((section, index) => {
							const next = sections[index + 1];
							const done = section.files.every((path) => reviewed.has(path));
							return (
								<section
									key={section.id}
									id={`grd-${section.id}`}
									className="grd-chapter grd-grid"
								>
									<div className="grd-left grd-col">
										<div>
											<h3
												style={
													section.group
														? { color: "var(--grd-fg-soft)" }
														: undefined
												}
											>
												{section.title}
											</h3>
											<div className="grd-meta">
												{section.group ? null : (
													<span className="grd-mono">
														{two(numberOf.get(section.id) ?? 0)} /{" "}
														{two(core.length)}
													</span>
												)}
												<Check
													on={done}
													onToggle={() => toggleChapter(section.files)}
												/>
											</div>
										</div>
										<div className="grd-col" style={{ gap: 12 }}>
											{section.paragraphs.map((paragraph) => (
												<p key={paragraph} className="grd-prose">
													<Prose text={paragraph} />
												</p>
											))}
										</div>
										<ul className="grd-files">
											{section.files.map((path) => {
												const { name, dir } = splitPath(path);
												const file = data.files[path];
												return (
													<li key={path}>
														<button
															type="button"
															className="grd-file"
															onClick={() =>
																document
																	.getElementById(
																		`grd-file-${section.id}-${path}`,
																	)
																	?.scrollIntoView({
																		behavior: "smooth",
																		block: "start",
																	})
															}
														>
															<span className="grd-ficon">
																{extension(path).slice(0, 2)}
															</span>
															<span className="grd-name">{name}</span>
															<span className="grd-dir">{dir}</span>
															<Stat
																add={file?.additions ?? 0}
																del={file?.deletions ?? 0}
															/>
														</button>
													</li>
												);
											})}
										</ul>
										{section.group ? null : (
											<AskAuthor
												chapter={section.title}
												hints={section.hints ?? []}
												openCount={askCounts[section.id] ?? 0}
											/>
										)}
										<div className="grd-actions">
											{next ? (
												<button
													type="button"
													className="grd-btn"
													onClick={() => openChapter(next.id)}
												>
													Next chapter <span className="grd-kbd">J</span>
												</button>
											) : null}
											{section.group ? null : (
												<button
													type="button"
													className="grd-link"
													onClick={() =>
														setAskCounts((current) => ({
															...current,
															[section.id]: (current[section.id] ?? 0) + 1,
														}))
													}
												>
													Ask author
												</button>
											)}
										</div>
									</div>
									<div className="grd-diffs">
										{section.files.map((path) => (
											<div
												key={path}
												id={`grd-file-${section.id}-${path}`}
												style={{ scrollMarginTop: 16 }}
											>
												{diffCard(path, section.id, section.group)}
											</div>
										))}
									</div>
								</section>
							);
						})
					) : (
						<div className="grd-difflist">
							<div className="grd-diffs">
								{allFiles.map((path) => (
									<Fragment key={path}>{diffCard(path, "diff")}</Fragment>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			<div className="grd-dock" role="tablist" aria-label="Review">
				<Tab
					selected={mode === "overview"}
					onSelect={() => show("overview")}
					icon={<FileText />}
					label="Overview"
				/>
				<Tab
					selected={mode === "guide"}
					onSelect={() => show("guide")}
					icon={<BookOpen />}
					label="Guide"
					count={core.length || null}
				/>
				<Tab
					selected={mode === "diff"}
					onSelect={() => show("diff")}
					icon={<FileCode2 />}
					label="Diff"
					count={allFiles.length || null}
				/>
			</div>
		</div>
	);
}

function Tab({
	selected,
	onSelect,
	icon,
	label,
	count = null,
}: {
	selected: boolean;
	onSelect: () => void;
	icon: ReactNode;
	label: string;
	count?: number | null;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			onClick={onSelect}
		>
			{icon}
			{label}
			{count !== null ? <span className="grd-count">{count}</span> : null}
		</button>
	);
}
