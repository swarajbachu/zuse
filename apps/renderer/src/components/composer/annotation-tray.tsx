import { isInputComposing } from "../../lib/input-composition.ts";
import { ContextPill } from "../context-pill.tsx";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	BrowserAnnotation,
	CodeAnnotation,
	ComposerAnnotation,
	FolderId,
	SessionId,
	WorktreeId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	CursorMagicSelection01Icon,
	PencilEdit01Icon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";
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
	const { message: uiMessage } = useUiMessages(["chat"]);

	const annotations = useAnnotationsStore(
		(s) => s.bySession[sessionId] ?? EMPTY,
	);
	const remove = useAnnotationsStore((s) => s.remove);
	const updateComment = useAnnotationsStore((s) => s.updateComment);
	const clear = useAnnotationsStore((s) => s.clear);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const revealAnnotation = useRevealAnnotation({ folderId, worktreeId });

	if (annotations.length === 0) return null;

	return (
		<ContextPill
			label={`${annotations.length} ${uiMessage("chat:annotation_tray_annotations")}`}
			onRemove={() => clear(sessionId)}
		>
			<ul className="max-h-48 divide-y divide-border/35 overflow-y-auto">
				{annotations.map((annotation) => {
					const browser = isBrowserAnnotation(annotation);
					return (
						<li
							key={annotation.id}
							className="group/annotation flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1.5 first:pt-1.5 last:pb-1.5 hover:bg-muted/45"
						>
							{"_tag" in annotation && annotation._tag === "context" ? (
								<span className="truncate text-xs">{annotation.label}</span>
							) : browser ? (
								<BrowserAnnotationChip
									annotation={annotation}
									className="max-w-[44%] shrink-0"
								/>
							) : (
								<button
									type="button"
									onClick={() => revealAnnotation(annotation as CodeAnnotation)}
									className="min-w-0 max-w-[44%] shrink-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
									title={uiMessage("chat:annotation_tray_open_annotation")}
								>
									<AnnotationFileChip
										annotation={annotation as CodeAnnotation}
										className="max-w-full py-px"
									/>
								</button>
							)}
							<span className="flex-1" />
							{editingId === annotation.id ? (
								<textarea
									value={editText}
									onChange={(event) => setEditText(event.target.value)}
									onKeyDown={(event) => {
										if (isInputComposing(event)) return;

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
									// biome-ignore lint/a11y/noAutofocus: entering edit mode should immediately focus the annotation comment field.
									autoFocus
								/>
							) : (
								<button
									type="button"
									onClick={() => {
										if (!("_tag" in annotation)) {
											revealAnnotation(annotation as CodeAnnotation);
										}
									}}
									disabled={"_tag" in annotation}
									className="order-last w-full whitespace-pre-wrap break-words rounded text-left text-xs leading-relaxed text-foreground disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
									aria-label={uiMessage("chat:annotation_tray_save_annotation")}
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
									aria-label={uiMessage("chat:annotation_tray_edit_annotation")}
								>
									<HugeiconsIcon icon={PencilEdit01Icon} className="size-3.5" />
								</button>
							)}
							<button
								type="button"
								onClick={() => remove(sessionId, annotation.id)}
								className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/annotation:opacity-100"
								aria-label={uiMessage("chat:annotation_tray_remove_annotation")}
							>
								<X className="size-3.5" strokeWidth={1.8} />
							</button>
						</li>
					);
				})}
			</ul>
		</ContextPill>
	);
}
