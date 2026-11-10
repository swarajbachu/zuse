import type { EditorView } from "@codemirror/view";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useComposerAnchor } from "~/components/composer/use-composer-anchor";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { cn } from "~/lib/utils";

export interface ComposerListItem {
	readonly id: string;
	readonly content: ReactNode;
	readonly trailing?: ReactNode;
}

/**
 * Popover above the composer for keyboard-driven lists that are not sigil
 * triggers (sent-message search, stash). Arrow keys move, Enter or Tab pick,
 * Escape closes; `onKey` handles anything list-specific first. Clicks on
 * an element marked `data-composer-list-toggle` are left to that toggle.
 */
export function ComposerListPopover({
	view,
	label,
	header,
	items,
	active,
	onActiveChange,
	onPick,
	onClose,
	onKey,
	empty,
}: {
	readonly view: EditorView;
	readonly label: string;
	readonly header: ReactNode;
	readonly items: readonly ComposerListItem[];
	readonly active: number;
	readonly onActiveChange: (index: number) => void;
	readonly onPick: (index: number) => void;
	readonly onClose: () => void;
	/** Return true when the key was handled. */
	readonly onKey?: (event: KeyboardEvent) => boolean;
	readonly empty: ReactNode;
}) {
	const listRef = useRef<HTMLDivElement | null>(null);
	const activeIndex = Math.min(active, Math.max(0, items.length - 1));

	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	useEffect(() => {
		const handle = (event: KeyboardEvent) => {
			if (event.isComposing) return;
			if (onKey?.(event) === true) {
				// handled by the list
			} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				if (items.length === 0) return;
				const step = event.key === "ArrowDown" ? 1 : -1;
				onActiveChange((activeIndex + step + items.length) % items.length);
			} else if (event.key === "Enter" || event.key === "Tab") {
				if (event.shiftKey) return;
				if (items.length > 0) onPick(activeIndex);
			} else if (event.key === "Escape") onClose();
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (
				!listRef.current?.contains(target) &&
				!view.dom.contains(target) &&
				target.closest?.("[data-composer-list-toggle]") == null
			)
				onClose();
		};
		window.addEventListener("keydown", handle, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			window.removeEventListener("keydown", handle, true);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [activeIndex, items.length, onActiveChange, onClose, onKey, onPick, view]);

	const anchor = useComposerAnchor(view);
	if (anchor === null) return null;

	return createPortal(
		<div
			ref={listRef}
			role="dialog"
			aria-label={label}
			className={cn(
				"fixed z-50 flex max-h-80 flex-col overflow-hidden p-1.5",
				overlaySurface,
			)}
			style={{ left: anchor.left, bottom: anchor.bottom, width: anchor.width }}
			onMouseDown={(event) => event.preventDefault()}
		>
			<div className="flex h-7 shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
				{header}
			</div>
			<div
				role="listbox"
				aria-label={label}
				className="min-h-0 overflow-y-auto [scrollbar-width:thin]"
			>
				{items.length === 0 ? (
					<div className="px-2 py-1.5 text-sm text-muted-foreground">
						{empty}
					</div>
				) : (
					items.map((item, index) => (
						// biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled at the window so focus stays in the composer.
						<div
							key={item.id}
							role="option"
							tabIndex={-1}
							data-index={index}
							aria-selected={index === activeIndex}
							onMouseMove={() => {
								if (index !== activeIndex) onActiveChange(index);
							}}
							onClick={() => onPick(index)}
							className={cn(
								"group flex w-full cursor-default items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm",
								index === activeIndex
									? "bg-accent text-accent-foreground"
									: "text-muted-foreground hover:bg-muted/60",
							)}
						>
							<span className="min-w-0 flex-1 truncate">{item.content}</span>
							{item.trailing}
						</div>
					))
				)}
			</div>
		</div>,
		document.body,
	);
}
