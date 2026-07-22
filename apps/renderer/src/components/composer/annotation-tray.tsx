import { HugeiconsIcon } from "@hugeicons/react";
import ArrowDown01Icon from "@hugeicons-pro/core-solid-rounded/ArrowDown01Icon";
import BubbleChatIcon from "@hugeicons-pro/core-solid-rounded/BubbleChatIcon";
import CursorMagicSelection01Icon from "@hugeicons-pro/core-solid-rounded/CursorMagicSelection01Icon";
import PencilEdit01Icon from "@hugeicons-pro/core-solid-rounded/PencilEdit01Icon";
import Tick01Icon from "@hugeicons-pro/core-solid-rounded/Tick01Icon";
import type {
	BrowserAnnotation,
	CodeAnnotation,
	ComposerAnnotation,
	FolderId,
	SessionId,
	WorktreeId,
} from "@zuse/contracts";
import { X } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { useAnnotationsStore } from "../../store/annotations.ts";
import { useRevealAnnotation } from "../annotation/annotation-navigation.ts";
import { AnnotationFileChip } from "../file-chip.tsx";

const EMPTY: ReadonlyArray<ComposerAnnotation> = [];

const isBrowserAnnotation = (
	annotation: ComposerAnnotation,
): annotation is BrowserAnnotation =>
	"_tag" in annotation && annotation._tag === "browser";

const browserHost = (annotation: BrowserAnnotation): string => {
	try {
		return new URL(annotation.pageUrl).host;
	} catch {
		return annotation.pageUrl || "Browser";
	}
};

const browserTargetLabel = (annotation: BrowserAnnotation): string => {
	const count =
		annotation.elements.length +
		annotation.regions.length +
		annotation.strokes.length;
	const first = annotation.elements[0];
	const targetSummary = `${count} ${count === 1 ? "target" : "targets"}`;
	return `${first ? `<${first.tagName}> · ` : ""}${targetSummary}${
		annotation.screenshotAttachment !== null ? " · screenshot" : ""
	}`;
};

function BrowserAnnotationChip({
	annotation,
	className,
}: {
	readonly annotation: BrowserAnnotation;
	readonly className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-[0.375rem] border border-border/45 bg-[var(--chip-bg)] px-1.5 py-0.5 text-[11px] text-muted-foreground dark:shadow-[inset_0_1px_0_color-mix(in_oklch,white_4%,transparent),0_1px_2px_color-mix(in_oklch,black_22%,transparent)]",
				className,
			)}
		>
			<HugeiconsIcon
				icon={CursorMagicSelection01Icon}
				className="size-3.5 shrink-0 text-primary"
				aria-hidden="true"
			/>
			<span className="truncate font-medium text-foreground">
				{browserHost(annotation)}
			</span>
			<span className="truncate">{browserTargetLabel(annotation)}</span>
		</span>
	);
}

/**
 * Stacked annotations docked above the composer. Draft annotations can be
 * opened where possible, edited in-place, removed individually, or cleared as
 * a group before submit.
 */
export function AnnotationTray({
	sessionId,
	folderId,
	worktreeId,
}: {
	sessionId: SessionId;
	folderId: FolderId | null;
	worktreeId: WorktreeId | null;
}) {
	const annotations = useAnnotationsStore(
		(s) => s.bySession[sessionId] ?? EMPTY,
	);
	const remove = useAnnotationsStore((s) => s.remove);
	const updateComment = useAnnotationsStore((s) => s.updateComment);
	const clear = useAnnotationsStore((s) => s.clear);
	const [expanded, setExpanded] = useState(true);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const revealAnnotation = useRevealAnnotation({ folderId, worktreeId });

	if (annotations.length === 0) return null;

	return (
		<div className="mb-1.5 overflow-hidden rounded-lg border border-border/50 bg-card/80 shadow-sm">
			<div className="flex w-full items-center gap-1.5 border-b border-border/35 bg-muted/15 px-2 py-1">
				<button
					type="button"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					className="flex min-h-6 flex-1 items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					<HugeiconsIcon
						icon={BubbleChatIcon}
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<span className="text-xs font-semibold text-foreground">
						Annotations
					</span>
					<span className="rounded border border-border/45 bg-background/70 px-1 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
						{annotations.length}
					</span>
					<HugeiconsIcon
						icon={ArrowDown01Icon}
						className={cn(
							"ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
							expanded ? "rotate-180" : "",
						)}
						aria-hidden="true"
					/>
				</button>
				<button
					type="button"
					onClick={() => clear(sessionId)}
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					aria-label="Clear all annotations"
				>
					<X className="size-3.5" strokeWidth={1.8} />
				</button>
			</div>
			{expanded ? (
				<ul className="max-h-48 divide-y divide-border/35 overflow-y-auto">
					{annotations.map((annotation) => {
						const browser = isBrowserAnnotation(annotation);
						return (
							<li
								key={annotation.id}
								className="group/annotation flex min-w-0 items-center gap-1.5 px-2 py-1.5 first:pt-1.5 last:pb-1.5 hover:bg-muted/45"
							>
								{browser ? (
									<BrowserAnnotationChip
										annotation={annotation}
										className="max-w-[44%] shrink-0"
									/>
								) : (
									<button
										type="button"
										onClick={() =>
											revealAnnotation(annotation as CodeAnnotation)
										}
										className="min-w-0 max-w-[44%] shrink-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
										title="Open annotation"
									>
										<AnnotationFileChip
											annotation={annotation as CodeAnnotation}
											className="max-w-full py-px"
										/>
									</button>
								)}
								<span className="h-4 w-px shrink-0 bg-border/45" />
								{editingId === annotation.id ? (
									<textarea
										value={editText}
										onChange={(event) => setEditText(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Escape") {
												event.preventDefault();
												setEditingId(null);
											} else if (event.key === "Enter" && !event.shiftKey) {
												event.preventDefault();
												updateComment(sessionId, annotation.id, editText);
												setEditingId(null);
											}
										}}
										rows={1}
										className="max-h-20 min-h-7 min-w-0 flex-1 resize-y rounded-md bg-background/70 px-2 py-1 text-xs leading-snug text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50"
										autoFocus
									/>
								) : (
									<button
										type="button"
										onClick={() => {
											if (!browser) {
												revealAnnotation(annotation as CodeAnnotation);
											}
										}}
										disabled={browser}
										className="min-w-0 flex-1 truncate rounded text-left text-xs leading-snug text-foreground disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
										title={annotation.comment}
									>
										{annotation.comment}
									</button>
								)}
								{editingId === annotation.id ? (
									<button
										type="button"
										onClick={() => {
											updateComment(sessionId, annotation.id, editText);
											setEditingId(null);
										}}
										className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-80 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
										aria-label="Save annotation"
									>
										<HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
									</button>
								) : (
									<button
										type="button"
										onClick={() => {
											setEditingId(annotation.id);
											setEditText(annotation.comment);
										}}
										className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/annotation:opacity-100"
										aria-label="Edit annotation"
									>
										<HugeiconsIcon
											icon={PencilEdit01Icon}
											className="size-3.5"
										/>
									</button>
								)}
								<button
									type="button"
									onClick={() => remove(sessionId, annotation.id)}
									className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/annotation:opacity-100"
									aria-label="Remove annotation"
								>
									<X className="size-3.5" strokeWidth={1.8} />
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
		</div>
	);
}
