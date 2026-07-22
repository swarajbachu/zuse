import { HugeiconsIcon } from "@hugeicons/react";
import BubbleChatIcon from "@hugeicons-pro/core-solid-rounded/BubbleChatIcon";
import Tick01Icon from "@hugeicons-pro/core-solid-rounded/Tick01Icon";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { PendingSelection } from "../../lib/codemirror/annotation-selection.ts";

export interface AnnotationDraft {
	readonly relPath: string;
	readonly absPath: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly comment: string;
	readonly diffSide?: "additions" | "deletions";
	readonly oldPath?: string;
	readonly baseRef?: string;
}

interface AnnotateOverlayProps {
	/** Current non-empty selection, or `null` to hide everything. */
	readonly selection: PendingSelection | null;
	readonly relPath: string;
	readonly absPath: string;
	/** Card open (comment input shown) vs collapsed (just the pill button). */
	readonly cardOpen: boolean;
	readonly onCardOpenChange: (open: boolean) => void;
	/** Fired with the finished annotation; the host adds it to the store. */
	readonly onConfirm: (draft: AnnotationDraft) => void;
}

const basename = (p: string): string => {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
};

const rangeLabel = (sel: PendingSelection): string =>
	sel.startLine === sel.endLine
		? `${sel.startLine}`
		: `${sel.startLine}-${sel.endLine}`;

/**
 * Floating annotate affordance rendered over the file editor / diff view. A
 * pill button sits just above the current selection; clicking it (or the
 * `editor.annotate` shortcut, which the host toggles via `cardOpen`) expands a
 * small card with a `path:line` tag and a comment box — the code analogue of
 * the element-tag annotation popup in the reference screenshots.
 *
 * Positioned `fixed` in client coordinates (the selection extension reports
 * client-space rects and re-emits on scroll), so it tracks the selection
 * without container-relative math.
 */
export function AnnotateOverlay({
	selection,
	relPath,
	absPath,
	cardOpen,
	onCardOpenChange,
	onConfirm,
}: AnnotateOverlayProps) {
	const [comment, setComment] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	// Reset the draft whenever the card closes or the target selection changes.
	useEffect(() => {
		if (!cardOpen) setComment("");
	}, [cardOpen]);

	useEffect(() => {
		if (cardOpen) textareaRef.current?.focus();
	}, [cardOpen]);

	if (selection === null) return null;

	const confirm = (): void => {
		const trimmed = comment.trim();
		if (trimmed.length === 0) {
			onCardOpenChange(false);
			return;
		}
		onConfirm({
			relPath,
			absPath,
			startLine: selection.startLine,
			endLine: selection.endLine,
			comment: trimmed,
		});
		setComment("");
		onCardOpenChange(false);
	};

	const popupWidth = cardOpen ? 320 : 112;
	const estimatedHeight = cardOpen ? 190 : 32;
	const boundaryRight = selection.boundaryRight ?? window.innerWidth;
	const boundaryBottom = selection.boundaryBottom ?? window.innerHeight;
	const maxLeft = Math.max(8, boundaryRight - popupWidth - 8);
	const left = Math.min(Math.max(8, selection.left), maxLeft);
	const belowTop = selection.bottom + 6;
	const aboveTop = selection.top - estimatedHeight - 6;
	const fitsBelow = belowTop + estimatedHeight <= boundaryBottom - 8;
	const top = Math.max(8, fitsBelow ? belowTop : aboveTop);
	const width = Math.min(popupWidth, Math.max(220, boundaryRight - left - 8));

	return (
		<div
			className="fixed z-50"
			style={{ top, left, width }}
			// Keep mousedown from collapsing the editor's selection / stealing focus.
			onMouseDown={(e) => e.preventDefault()}
		>
			{cardOpen ? (
				<div className="w-full rounded-lg border border-border/70 bg-popover p-2 shadow-lg">
					<div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
						<HugeiconsIcon icon={BubbleChatIcon} className="size-3.5" />
						<span className="truncate font-medium text-foreground">
							{basename(relPath)}
						</span>
						<span className="tabular-nums">:{rangeLabel(selection)}</span>
					</div>
					<textarea
						ref={textareaRef}
						value={comment}
						onChange={(e) => setComment(e.target.value)}
						onMouseDown={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								onCardOpenChange(false);
							} else if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								confirm();
							}
						}}
						rows={2}
						placeholder="Add a comment…"
						className="max-h-32 min-h-14 w-full resize-y rounded-md bg-background/80 px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none ring-0 placeholder:text-muted-foreground/70 focus:bg-background"
					/>
					<div className="mt-1.5 flex items-center justify-end gap-1">
						<button
							type="button"
							onClick={() => onCardOpenChange(false)}
							className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
							aria-label="Cancel annotation"
						>
							<X className="size-3.5" strokeWidth={1.8} />
						</button>
						<button
							type="button"
							onClick={confirm}
							disabled={comment.trim().length === 0}
							className="flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
							aria-label="Add annotation"
						>
							<HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
							Add
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					onClick={() => onCardOpenChange(true)}
					className={cn(
						"flex items-center gap-1.5 rounded-md border border-border/70 bg-popover px-2.5 py-1 text-xs font-medium text-foreground shadow-md",
						"hover:bg-accent hover:text-accent-foreground",
					)}
					aria-label={`Annotate ${basename(relPath)}:${rangeLabel(selection)}`}
				>
					<HugeiconsIcon icon={BubbleChatIcon} className="size-3.5" />
					Annotate
				</button>
			)}
		</div>
	);
}
