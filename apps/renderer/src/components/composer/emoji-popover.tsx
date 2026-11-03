import type { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useComposerAnchor } from "~/components/composer/use-composer-anchor";
import { overlaySurface } from "~/components/ui/overlay-surface";
import {
	type EmojiIndex,
	type EmojiSuggestion,
	type EmojiTrigger,
	insertEmojiSuggestion,
	loadEmojiIndex,
	loadedEmojiIndex,
	rankEmojiSuggestions,
} from "~/lib/codemirror/composer-emoji.ts";
import { cn } from "~/lib/utils";

export interface EmojiPopoverProps {
	readonly trigger: EmojiTrigger;
	readonly view: EditorView;
	readonly onClose: () => void;
}

const EMPTY_ROWS: ReadonlyArray<EmojiSuggestion> = [];
const POPOVER_MAX_WIDTH = 320;

/**
 * `:shortcode` suggestions. The emoji table loads lazily on first use; while
 * it loads nothing is shown, and once it is loaded a query with no matches
 * releases the trigger so Enter submits again instead of being swallowed.
 */
export function EmojiPopover({ trigger, view, onClose }: EmojiPopoverProps) {
	const [index, setIndex] = useState<EmojiIndex | null>(loadedEmojiIndex);
	useEffect(() => {
		if (index !== null) return;
		let cancelled = false;
		loadEmojiIndex().then(
			(loaded) => {
				if (!cancelled) setIndex(loaded);
			},
			() => {
				if (!cancelled) onClose();
			},
		);
		return () => {
			cancelled = true;
		};
	}, [index, onClose]);

	const rows = useMemo(
		() =>
			index === null ? EMPTY_ROWS : rankEmojiSuggestions(index, trigger.query),
		[index, trigger.query],
	);
	const [highlight, setHighlight] = useState(0);
	useEffect(() => setHighlight(0), [rows]);

	useEffect(() => {
		if (index !== null && rows.length === 0) onClose();
	}, [index, rows, onClose]);

	const confirmRow = (row: EmojiSuggestion) => {
		insertEmojiSuggestion(view, trigger, row.emoji);
		onClose();
	};

	useEffect(() => {
		if (rows.length === 0) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				e.stopPropagation();
				setHighlight((h) => (h + 1) % rows.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				e.stopPropagation();
				setHighlight((h) => (h - 1 + rows.length) % rows.length);
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				const row = rows[highlight];
				if (row !== undefined) confirmRow(row);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [rows, highlight, onClose]);

	const anchor = useComposerAnchor(view);

	if (rows.length === 0 || anchor === null) return null;

	return createPortal(
		<div
			role="listbox"
			className={cn("fixed z-50 p-1.5", overlaySurface)}
			style={{
				left: anchor.left,
				bottom: anchor.bottom,
				width: Math.min(anchor.width, POPOVER_MAX_WIDTH),
			}}
			onMouseDown={(e) => e.preventDefault()}
		>
			{rows.map((row, i) => {
				const active = i === highlight;
				return (
					<button
						key={row.name}
						type="button"
						role="option"
						aria-selected={active}
						onMouseEnter={() => setHighlight(i)}
						onClick={() => confirmRow(row)}
						className={cn(
							"flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm",
							active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
						)}
					>
						<span className="w-5 text-center text-base leading-none">
							{row.emoji}
						</span>
						<span className="truncate font-mono text-foreground">
							:{row.name}:
						</span>
					</button>
				);
			})}
		</div>,
		document.body,
	);
}
