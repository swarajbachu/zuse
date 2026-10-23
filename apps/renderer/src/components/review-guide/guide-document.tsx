import "@zuse/i18n/english/chat";
import {
	type DiffLineAnnotation,
	type FileDiffMetadata,
	processFile,
	type SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type {
	GuideView,
	GuideViewChapter,
} from "@zuse/client-runtime/review-guide-view";
import { selectHunks } from "@zuse/client-runtime/review-outline";
import type {
	GitReviewFile,
	GitReviewPatch,
	ProviderId,
	ReviewGuideOverview,
	ReviewGuideSketchLine,
	ReviewGuideState,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import {
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useZuseDiffTheme } from "~/lib/diffs-theme";
import { useProviderDisplayName } from "~/lib/provider-labels";
import { loadReviewDiffFiles } from "~/lib/review-file-contents";
import { cn } from "~/lib/utils";
import { DiffStat } from "../dock-panel/diff-stat.tsx";
import { FileIcon } from "../file-icon.tsx";
import { ProviderIcon } from "../provider-icons.tsx";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Kbd } from "../ui/kbd.tsx";

const UNAVAILABLE_KEYS = {
	disabled: "chat:review_guide_unavailable_disabled",
	"no-session": "chat:review_guide_unavailable_no_session",
	"unsupported-provider": "chat:review_guide_unavailable_unsupported",
	"no-changes": "chat:review_guide_unavailable_no_changes",
	"too-large": "chat:review_guide_unavailable_too_large",
} as const;

const chapterAnchor = (id: string) => `guide-chapter-${id}`;
/**
 * One grid for every section, so prose and code line up from the overview
 * down through each chapter.
 */
const DOCUMENT_GRID =
	"grid gap-y-8 xl:grid-cols-[21rem_minmax(0,1fr)] xl:gap-x-12";
const fileAnchor = (chapterId: string, path: string) =>
	`guide-file-${chapterId}-${path}`;
const twoDigits = (value: number) => String(value).padStart(2, "0");

const splitPath = (path: string) => {
	const slash = path.lastIndexOf("/");
	return slash === -1
		? { name: path, dir: "" }
		: { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) };
};

/** Text with `backtick` spans shown as code. */
function Prose({ text }: { readonly text: string }) {
	const parts = text.split(/(`[^`\n]+`)/g);
	return (
		<>
			{parts.map((part, index) =>
				part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
					<code
						key={index}
						className="rounded-[4px] bg-muted/70 px-1 font-mono text-[12px] text-foreground leading-none"
					>
						{part.slice(1, -1)}
					</code>
				) : (
					<Fragment key={index}>{part}</Fragment>
				),
			)}
		</>
	);
}

/**
 * Review comments inside chapter diffs, owned by the review that hosts the
 * guide so a comment behaves the same in the guide and in the plain diff.
 */
export interface GuideComments<A> {
	readonly annotationsFor: (
		path: string,
		chapterId: string,
	) => DiffLineAnnotation<A>[];
	readonly selectedFor: (
		path: string,
		chapterId: string,
	) => SelectedLineRange | null;
	readonly renderAnnotation: (annotation: DiffLineAnnotation<A>) => ReactNode;
	/** The gutter's add-comment button was pressed on these lines. */
	readonly onStart: (
		range: SelectedLineRange,
		path: string,
		chapterId: string,
	) => void;
}

export interface GuideDocumentProps<A> {
	readonly executionRef: ExecutionRef;
	readonly state: ReviewGuideState | null;
	readonly view: GuideView | null;
	readonly files: ReadonlyMap<string, GitReviewFile>;
	readonly patches: Readonly<Record<string, GitReviewPatch>>;
	readonly isFileViewed: (path: string) => boolean;
	readonly isChapterReviewed: (chapter: GuideViewChapter) => boolean;
	readonly onChapterReviewed: (
		chapter: GuideViewChapter,
		reviewed: boolean,
	) => void;
	readonly onGenerate: (force: boolean) => void;
	readonly onCancel: () => void;
	readonly onAsk: (chapter: GuideViewChapter, question: string) => void;
	/** Which page of the guide is showing: the overview or the chapters. */
	readonly mode: "overview" | "guide";
	readonly onModeChange: (mode: "overview" | "guide") => void;
	readonly onFileReviewed: (path: string, reviewed: boolean) => void;
	/** What is being compared, for the overview's byline. */
	readonly heading: {
		readonly head: string | null;
		readonly base: string | null;
		readonly additions: number;
		readonly deletions: number;
		readonly fileCount: number;
	};
	readonly comments: GuideComments<A>;
}

const STICKY_HEADER_CSS =
	"\n[data-diffs-header][data-sticky] { border-radius: 0; }\n";

/**
 * A guided review as a document, in the order a colleague would walk you
 * through it: an overview with a before/after sketch, then one section per
 * chapter with the explanation on the left and that chapter's own diff on
 * the right. Tests, generated files, and mechanical edits close the guide.
 */
export function GuideDocument<A>({
	executionRef,
	state,
	view,
	files,
	patches,
	isFileViewed,
	isChapterReviewed,
	onChapterReviewed,
	onGenerate,
	onCancel,
	onAsk,
	mode,
	onModeChange,
	onFileReviewed,
	heading,
	comments,
}: GuideDocumentProps<A>) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const guide = state?.guide ?? null;
	const run = state?.run ?? null;
	const overview = guide?.overview ?? run?.overview ?? null;
	const chapters = view?.chapters ?? [];
	const core = chapters.filter((chapter) => chapter.number !== null);
	const fresh = chapters.find((chapter) => chapter.kind === "new");
	const groups = chapters.filter(
		(chapter) => chapter.number === null && chapter.kind !== "new",
	);
	const reading = [...(fresh ? [fresh] : []), ...core, ...groups];
	const numberOf = useMemo(
		() => new Map(core.map((chapter) => [chapter.id, chapter.number ?? 0])),
		[core],
	);

	const scrollTo = useCallback((id: string, smooth = true) => {
		const target = scrollRef.current?.querySelector<HTMLElement>(
			`[id="${CSS.escape(id)}"]`,
		);
		target?.scrollIntoView({
			behavior: smooth ? "smooth" : "auto",
			block: "start",
		});
	}, []);

	// Each page starts at its top; a chapter opened from the overview lands
	// on that chapter once the guide page has rendered.
	const pendingChapterRef = useRef<string | null>(null);
	useEffect(() => {
		const pending = pendingChapterRef.current;
		pendingChapterRef.current = null;
		if (mode === "guide" && pending !== null)
			requestAnimationFrame(() => scrollTo(chapterAnchor(pending), false));
		else scrollRef.current?.scrollTo({ top: 0 });
	}, [mode, scrollTo]);
	const openChapter = useCallback(
		(id: string) => {
			if (mode === "guide") {
				scrollTo(chapterAnchor(id));
				return;
			}
			pendingChapterRef.current = id;
			onModeChange("guide");
		},
		[mode, onModeChange, scrollTo],
	);

	// J and K walk the chapters, from wherever the reader has scrolled to.
	useEffect(() => {
		if (mode !== "guide") return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key !== "j" && event.key !== "k") return;
			const target = event.target as HTMLElement | null;
			if (
				target?.isContentEditable ||
				target?.closest("input, textarea, select, [role=textbox]")
			)
				return;
			const container = scrollRef.current;
			if (container === null || reading.length === 0) return;
			// A section scrolled into view rests a little below the top (its
			// scroll margin), and still counts as the one being read.
			const top = container.getBoundingClientRect().top + 48;
			const tops = reading.map(
				(chapter) =>
					container
						.querySelector<HTMLElement>(
							`[id="${CSS.escape(chapterAnchor(chapter.id))}"]`,
						)
						?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
			);
			const current = tops.findLastIndex((value) => value <= top);
			const next =
				reading[current + (event.key === "j" ? 1 : current < 0 ? 0 : -1)];
			if (next === undefined) return;
			event.preventDefault();
			scrollTo(chapterAnchor(next.id));
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [mode, reading, scrollTo]);

	// "No changes" is saved when a refresh found none; once there are changes
	// again it must not keep the reader from writing a guide.
	const unavailable =
		state?.unavailable === "no-changes" && heading.fileCount > 0
			? null
			: (state?.unavailable ?? null);
	const status =
		run !== null
			? guide === null
				? uiMessage("chat:review_guide_writing")
				: uiMessage("chat:review_guide_updating_for", { sha: run.forSha })
			: null;

	return (
		<div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain">
			<div className="mx-auto w-full max-w-[1240px] px-8 pb-32">
				{status !== null || state?.lastError ? (
					<div className="flex h-9 items-center gap-2 text-xs">
						{status !== null ? (
							<>
								<LoaderCircle className="size-3 animate-spin text-muted-foreground" />
								<span className="text-muted-foreground">{status}</span>
								<span className="text-muted-foreground/60 tabular-nums">
									{uiMessage("chat:review_guide_progress", {
										assigned: run?.assigned ?? 0,
										total: run?.total ?? 0,
									})}
								</span>
								<button
									type="button"
									onClick={onCancel}
									className="ml-auto text-muted-foreground hover:text-foreground"
								>
									{uiMessage("chat:review_guide_cancel")}
								</button>
							</>
						) : (
							<>
								<span className="text-destructive">{state?.lastError}</span>
								<button
									type="button"
									onClick={() => onGenerate(true)}
									className="ml-auto text-muted-foreground hover:text-foreground"
								>
									{uiMessage("chat:review_guide_regenerate")}
								</button>
							</>
						)}
					</div>
				) : null}

				{guide === null && run === null ? (
					<EmptyGuide
						state={state}
						unavailableText={
							unavailable === null
								? null
								: uiMessage(UNAVAILABLE_KEYS[unavailable])
						}
						onGenerate={onGenerate}
					/>
				) : null}

				{mode === "overview" && (guide !== null || run !== null) ? (
					<>
						<header className="pt-6">
							<h1 className="font-semibold text-[24px] text-foreground leading-8 tracking-[-0.02em]">
								{overview?.title ||
									heading.head ||
									uiMessage("chat:review_guide_overview")}
							</h1>
							<div className="mt-2 flex flex-wrap items-center gap-2.5 text-muted-foreground text-xs">
								{guide !== null || state?.writer ? (
									<Author
										providerId={
											guide?.providerId ??
											state?.writer?.providerId ??
											("claude" as ProviderId)
										}
										model={guide?.model ?? state?.writer?.model ?? ""}
									/>
								) : null}
								{heading.head !== null ? (
									<>
										<span className="h-3 w-px bg-border" />
										<span>
											{heading.base === null
												? heading.head
												: `${heading.head} → ${heading.base}`}
										</span>
									</>
								) : null}
								<span className="h-3 w-px bg-border" />
								<DiffStat
									additions={heading.additions}
									deletions={heading.deletions}
								/>
								<span className="h-3 w-px bg-border" />
								<span>
									{uiMessage("chat:review_guide_file_count", {
										count: heading.fileCount,
									})}
								</span>
							</div>
						</header>
						{overview !== null ? (
							<OverviewSection
								overview={overview}
								numberOf={numberOf}
								onOpenChapter={openChapter}
							/>
						) : null}
						{reading.length > 0 ? (
							<InThisGuide
								chapters={reading}
								total={core.length}
								files={files}
								isChapterReviewed={isChapterReviewed}
								onOpen={openChapter}
							/>
						) : null}
					</>
				) : null}

				{mode === "guide"
					? reading.map((chapter, index) => (
							<ChapterSection
								key={chapter.id}
								executionRef={executionRef}
								chapter={chapter}
								total={core.length}
								files={files}
								patches={patches}
								isFileViewed={isFileViewed}
								reviewed={isChapterReviewed(chapter)}
								onFileReviewed={onFileReviewed}
								next={reading[index + 1] ?? null}
								onReviewed={(reviewed) => onChapterReviewed(chapter, reviewed)}
								onNext={(next) => scrollTo(chapterAnchor(next.id))}
								onOpenFile={(path) => scrollTo(fileAnchor(chapter.id, path))}
								onAsk={(question) => onAsk(chapter, question)}
								comments={comments}
							/>
						))
					: null}
			</div>
		</div>
	);
}

/** Who wrote the guide: the chat's agent, with its model beside it. */
function Author({
	providerId,
	model,
}: {
	readonly providerId: ProviderId;
	readonly model: string;
}) {
	const name = useProviderDisplayName(providerId);
	return (
		<span className="flex items-center gap-1.5">
			<ProviderIcon
				providerId={providerId}
				className="size-4 text-foreground"
			/>
			<span className="text-foreground">{name}</span>
			{model.length > 0 ? <span className="font-mono">{model}</span> : null}
		</span>
	);
}

/** The chapters as cards, so the overview doubles as a table of contents. */
function InThisGuide({
	chapters,
	total,
	files,
	isChapterReviewed,
	onOpen,
}: {
	readonly chapters: ReadonlyArray<GuideViewChapter>;
	readonly total: number;
	readonly files: ReadonlyMap<string, GitReviewFile>;
	readonly isChapterReviewed: (chapter: GuideViewChapter) => boolean;
	readonly onOpen: (id: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	return (
		<section className="pt-14">
			<h2 className="font-semibold text-[17px] text-foreground leading-6 tracking-[-0.01em]">
				{uiMessage("chat:review_guide_in_this_guide")}
			</h2>
			<div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
				{chapters.map((chapter) => {
					const reviewed = isChapterReviewed(chapter);
					const additions = chapter.files.reduce(
						(sum, path) => sum + (files.get(path)?.additions ?? 0),
						0,
					);
					const deletions = chapter.files.reduce(
						(sum, path) => sum + (files.get(path)?.deletions ?? 0),
						0,
					);
					return (
						<button
							key={chapter.id}
							type="button"
							onClick={() => onOpen(chapter.id)}
							className="relative flex flex-col gap-1.5 rounded-[10px] bg-card p-4 text-left outline-none ring-1 ring-border/60 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span
								className={cn(
									"absolute top-4 right-4 size-3.5 rounded-full",
									reviewed
										? "bg-primary"
										: "ring-[1.5px] ring-border ring-inset",
								)}
							/>
							<span className="font-mono text-[11px] text-muted-foreground">
								{chapter.number !== null
									? `${twoDigits(chapter.number)} / ${twoDigits(total)}`
									: uiMessage("chat:review_guide_also_changed")}
							</span>
							<span className="pr-6 font-medium text-[13.5px] text-foreground leading-5">
								{chapter.title}
							</span>
							<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
								{uiMessage("chat:review_guide_file_count", {
									count: chapter.files.length,
								})}
								<span>·</span>
								<DiffStat additions={additions} deletions={deletions} />
							</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}

function EmptyGuide({
	state,
	unavailableText,
	onGenerate,
}: {
	readonly state: ReviewGuideState | null;
	readonly unavailableText: string | null;
	readonly onGenerate: (force: boolean) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const tooLarge = state?.unavailable === "too-large";
	const blocked = unavailableText !== null && !tooLarge;
	return (
		<div className="mx-auto flex max-w-md flex-col items-center gap-2 pt-24 text-center">
			<p className="font-medium text-[15px] text-foreground">
				{uiMessage("chat:review_guide_empty_title")}
			</p>
			<p className="text-[13px] text-muted-foreground leading-[22px]">
				{blocked ? unavailableText : uiMessage("chat:review_guide_empty_body")}
			</p>
			{blocked || state === null ? null : (
				<div className="flex flex-col items-center gap-2 pt-3">
					<Button variant="outline" onClick={() => onGenerate(tooLarge)}>
						{tooLarge
							? uiMessage("chat:review_guide_write_anyway")
							: uiMessage("chat:review_guide_generate")}
					</Button>
					{state.writer !== null ? (
						<span className="font-mono text-[11px] text-muted-foreground">
							{state.writer.model}
						</span>
					) : null}
				</div>
			)}
		</div>
	);
}

function OverviewSection({
	overview,
	numberOf,
	onOpenChapter,
}: {
	readonly overview: ReviewGuideOverview;
	readonly numberOf: ReadonlyMap<string, number>;
	readonly onOpenChapter: (id: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	return (
		<section className={cn(DOCUMENT_GRID, "pt-10")}>
			<div className="flex min-w-0 flex-col gap-4">
				<h2 className="font-semibold text-[17px] text-foreground tracking-[-0.01em]">
					{uiMessage("chat:review_guide_overview")}
				</h2>
				<p className="text-[13.5px] text-foreground/80 leading-[22px]">
					<Prose text={overview.context} />
				</p>
				{overview.steps.length > 0 ? (
					<ol className="flex flex-col gap-2.5">
						{overview.steps.map((step, index) => (
							<li
								key={index}
								className="grid grid-cols-[1.25rem_minmax(0,1fr)] text-[13.5px] text-foreground/80 leading-[22px]"
							>
								<span className="text-muted-foreground tabular-nums">
									{index + 1}.
								</span>
								<span>
									<Prose text={step} />
								</span>
							</li>
						))}
					</ol>
				) : null}
			</div>
			{overview.beforeAfter !== null &&
			overview.beforeAfter.lines.length > 0 ? (
				<BeforeAfter
					caption={overview.beforeAfter.caption}
					lines={overview.beforeAfter.lines}
					numberOf={numberOf}
					onOpenChapter={onOpenChapter}
				/>
			) : null}
		</section>
	);
}

function BeforeAfter({
	caption,
	lines,
	numberOf,
	onOpenChapter,
}: {
	readonly caption: string;
	readonly lines: ReadonlyArray<ReviewGuideSketchLine>;
	readonly numberOf: ReadonlyMap<string, number>;
	readonly onOpenChapter: (id: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const [open, setOpen] = useState(true);
	const added = lines.filter((line) => line.kind === "add").length;
	const removed = lines.filter((line) => line.kind === "remove").length;
	return (
		<div className="min-w-0 self-start overflow-clip rounded-[10px] bg-card ring-1 ring-border/60">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex h-11 w-full items-center gap-2 px-4 text-left outline-none focus-visible:bg-muted/30"
			>
				{open ? (
					<ChevronDown className="size-3.5 text-muted-foreground" />
				) : (
					<ChevronRight className="size-3.5 text-muted-foreground" />
				)}
				<span className="font-medium text-[13px] text-foreground">
					{uiMessage("chat:review_guide_before_after")}
				</span>
				<DiffStat additions={added} deletions={removed} className="ml-auto" />
			</button>
			{open ? (
				<div className="border-border/50 border-t pt-3 pb-3">
					<p className="px-4 pb-2.5 text-muted-foreground text-xs">{caption}</p>
					<div className="font-mono text-[12px] leading-[26px]">
						{lines.map((line, index) => {
							const number =
								line.chapterId === null
									? undefined
									: numberOf.get(line.chapterId);
							return (
								<div
									key={index}
									className={cn(
										"flex min-w-0 items-center border-l-2 pr-3",
										line.kind === "add"
											? "border-success bg-success/8"
											: line.kind === "remove"
												? "border-destructive bg-destructive/8"
												: "border-transparent",
									)}
								>
									<span
										className={cn(
											"w-6 shrink-0 text-center",
											line.kind === "add"
												? "text-[var(--accent-green)]"
												: "text-[var(--accent-red)]",
										)}
									>
										{line.kind === "add"
											? "+"
											: line.kind === "remove"
												? "−"
												: ""}
									</span>
									<span
										className="shrink-0 whitespace-pre text-foreground"
										style={{ paddingLeft: `${line.indent * 16}px` }}
									>
										<span
											className={cn(
												line.kind === "remove" &&
													"text-foreground/65 line-through decoration-destructive/60",
											)}
										>
											{line.code.trimStart()}
										</span>
									</span>
									{line.note !== null ? (
										<span className="ml-4 min-w-0 truncate font-sans text-[12px] text-muted-foreground">
											{line.note}
										</span>
									) : null}
									{number !== undefined && line.chapterId !== null ? (
										<button
											type="button"
											onClick={() => onOpenChapter(line.chapterId ?? "")}
											className="ml-auto h-5 shrink-0 rounded-[4px] px-1.5 text-[10px] text-muted-foreground leading-5 ring-1 ring-border hover:text-foreground"
										>
											{twoDigits(number)}
										</button>
									) : null}
								</div>
							);
						})}
					</div>
				</div>
			) : null}
		</div>
	);
}

function ChapterSection<A>({
	executionRef,
	chapter,
	total,
	files,
	patches,
	isFileViewed,
	reviewed,
	onFileReviewed,
	next,
	onReviewed,
	onNext,
	onOpenFile,
	onAsk,
	comments,
}: {
	readonly executionRef: ExecutionRef;
	readonly comments: GuideComments<A>;
	readonly onFileReviewed: (path: string, reviewed: boolean) => void;
	readonly chapter: GuideViewChapter;
	readonly total: number;
	readonly files: ReadonlyMap<string, GitReviewFile>;
	readonly patches: Readonly<Record<string, GitReviewPatch>>;
	readonly isFileViewed: (path: string) => boolean;
	readonly reviewed: boolean;
	readonly next: GuideViewChapter | null;
	readonly onReviewed: (reviewed: boolean) => void;
	readonly onNext: (next: GuideViewChapter) => void;
	readonly onOpenFile: (path: string) => void;
	readonly onAsk: (question: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const group = chapter.number === null;
	const ids = useMemo(() => new Set(chapter.hunkIds), [chapter.hunkIds]);
	const paragraphs = chapter.summary
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);

	return (
		<section
			id={chapterAnchor(chapter.id)}
			className={cn(DOCUMENT_GRID, "border-border/50 border-t py-10")}
		>
			<div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-6 xl:self-start">
				<div className="flex flex-col gap-2">
					<h3
						className={cn(
							"font-semibold text-[17px] leading-snug tracking-[-0.01em]",
							group ? "text-foreground/80" : "text-foreground",
						)}
					>
						{chapter.title}
					</h3>
					<div className="flex items-center gap-3 text-muted-foreground text-xs">
						{chapter.number !== null ? (
							<span className="font-mono tabular-nums">
								{twoDigits(chapter.number)} / {twoDigits(total)}
							</span>
						) : null}
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox is the nested control */}
						<label className="flex cursor-pointer items-center gap-1.5">
							<Checkbox
								checked={reviewed}
								onCheckedChange={(value) => onReviewed(value === true)}
							/>
							{uiMessage("chat:review_guide_reviewed")}
						</label>
						{chapter.changed ? (
							<span>· {uiMessage("chat:review_guide_changed")}</span>
						) : null}
					</div>
				</div>

				{paragraphs.length > 0 ? (
					<div className="flex flex-col gap-3 text-[13.5px] text-foreground/80 leading-[22px]">
						{paragraphs.map((paragraph, index) => (
							<p key={index}>
								<Prose text={paragraph} />
							</p>
						))}
					</div>
				) : null}

				<ul className="flex flex-col">
					{chapter.files.map((path) => {
						const file = files.get(path);
						const { name, dir } = splitPath(path);
						return (
							<li key={path}>
								<button
									type="button"
									onClick={() => onOpenFile(path)}
									className="flex h-7 w-full min-w-0 items-center gap-2 text-left text-xs outline-none hover:text-foreground focus-visible:bg-muted/30"
								>
									<FileIcon name={path} kind="file" />
									<span className="shrink-0 text-foreground">{name}</span>
									<span className="min-w-0 truncate text-muted-foreground">
										{dir}
									</span>
									{file !== undefined ? (
										<DiffStat
											additions={file.additions}
											deletions={file.deletions}
											className="ml-auto"
										/>
									) : null}
								</button>
							</li>
						);
					})}
				</ul>

				{chapter.askHints.length > 0 ? (
					<div className="flex flex-col items-start gap-1.5">
						{chapter.askHints.map((hint) => (
							<button
								key={hint}
								type="button"
								onClick={() => onAsk(hint)}
								className="text-left text-muted-foreground text-xs leading-5 hover:text-foreground"
							>
								{hint}
							</button>
						))}
					</div>
				) : null}

				<div className="flex items-center gap-4 pt-1">
					{next !== null ? (
						<Button variant="outline" onClick={() => onNext(next)}>
							{uiMessage("chat:review_guide_next_chapter")}
							<Kbd className="h-4 min-w-4 bg-transparent px-0 text-[10px]">
								J
							</Kbd>
						</Button>
					) : null}
					{!group ? (
						<button
							type="button"
							onClick={() => onAsk("")}
							className="text-muted-foreground text-xs hover:text-foreground"
						>
							{uiMessage("chat:review_guide_ask_author")}
						</button>
					) : null}
				</div>
			</div>

			<div className="flex min-w-0 flex-col gap-3">
				{chapter.files.map((path) => {
					const patch = patches[path];
					return (
						<div
							key={path}
							id={fileAnchor(chapter.id, path)}
							className="scroll-mt-4"
						>
							<LazyChapterDiff
								executionRef={executionRef}
								path={path}
								oldPath={files.get(path)?.oldPath ?? null}
								patch={patch?.result.patch ?? ""}
								ids={ids}
								collapsed={group}
								cacheKey={`${chapter.id}:${path}`}
								reviewed={isFileViewed(path)}
								onReviewed={(value) => onFileReviewed(path, value)}
								chapterId={chapter.id}
								comments={comments}
							/>
						</div>
					);
				})}
			</div>
		</section>
	);
}

/**
 * One file's part of a chapter, mounted only near the viewport so a long
 * guide costs what is on screen, not what is in the change.
 */
function LazyChapterDiff<A>(props: {
	readonly executionRef: ExecutionRef;
	readonly chapterId: string;
	readonly comments: GuideComments<A>;
	readonly path: string;
	readonly oldPath: string | null;
	readonly patch: string;
	readonly ids: ReadonlySet<string>;
	readonly collapsed: boolean;
	readonly cacheKey: string;
	readonly reviewed: boolean;
	readonly onReviewed: (reviewed: boolean) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	const [open, setOpen] = useState(!props.collapsed);
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

	const { name, dir } = splitPath(props.path);
	if (!open)
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="flex h-10 w-full items-center gap-2 rounded-[10px] bg-card px-4 text-left text-xs ring-1 ring-border/60 hover:bg-muted/30"
			>
				<ChevronRight className="size-3.5 text-muted-foreground" />
				<FileIcon name={props.path} kind="file" />
				<span className="text-foreground">{name}</span>
				<span className="min-w-0 truncate text-muted-foreground">{dir}</span>
			</button>
		);
	return (
		<div ref={ref} className="min-h-10">
			{near ? <ChapterDiff {...props} /> : <div className="h-40" />}
		</div>
	);
}

function ChapterDiff<A>({
	executionRef,
	chapterId,
	comments,
	path,
	oldPath,
	patch,
	ids,
	cacheKey,
	reviewed,
	onReviewed,
}: {
	readonly executionRef: ExecutionRef;
	readonly chapterId: string;
	readonly comments: GuideComments<A>;
	readonly path: string;
	readonly oldPath: string | null;
	readonly patch: string;
	readonly ids: ReadonlySet<string>;
	readonly cacheKey: string;
	readonly reviewed: boolean;
	readonly onReviewed: (reviewed: boolean) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const theme = useZuseDiffTheme();
	const fileDiff = useMemo((): FileDiffMetadata | null => {
		if (patch.length === 0) return null;
		const selected = selectHunks(path, patch, ids) ?? patch;
		return (
			processFile(selected, {
				cacheKey: `guide:${cacheKey}:${selected.length}`,
			}) ?? null
		);
	}, [cacheKey, ids, patch, path]);
	if (fileDiff === null) return null;
	return (
		<FileDiff<A>
			fileDiff={fileDiff}
			lineAnnotations={comments.annotationsFor(path, chapterId)}
			selectedLines={comments.selectedFor(path, chapterId)}
			renderAnnotation={comments.renderAnnotation}
			renderHeaderMetadata={() => (
				// biome-ignore lint/a11y/noLabelWithoutControl: the checkbox is the nested control
				<label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs">
					<Checkbox
						checked={reviewed}
						onCheckedChange={(value) => onReviewed(value === true)}
					/>
					{uiMessage("chat:review_guide_reviewed")}
				</label>
			)}
			className="fz-diff overflow-clip rounded-[10px] ring-1 ring-border/60"
			options={{
				...theme,
				// The file header stays pinned while its lines scroll under it;
				// the card's own corners round it at rest, so it stays square.
				unsafeCSS: `${theme.unsafeCSS ?? ""}${STICKY_HEADER_CSS}`,
				stickyHeader: true,
				diffStyle: "unified",
				overflow: "wrap",
				hunkSeparators: "line-info",
				lineHoverHighlight: "number",
				// The gutter's + starts a review comment on the hovered lines.
				enableGutterUtility: true,
				onGutterUtilityClick: (range) =>
					comments.onStart(range, path, chapterId),
				loadDiffFiles: (meta) =>
					loadReviewDiffFiles(executionRef, { path, oldPath }, meta.cacheKey),
			}}
		/>
	);
}
