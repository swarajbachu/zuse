import "@zuse/i18n/english/chat";
import type { EditorView } from "@codemirror/view";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Search01Icon } from "@zuse/icons/stroke-rounded";
import fuzzysort from "fuzzysort";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useComposerAnchor } from "~/components/composer/use-composer-anchor";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { cn } from "~/lib/utils";
import type { ComposerDraftSnapshot } from "../../store/composer-drafts.ts";

const MAX_RESULTS = 50;

interface Result {
	readonly snapshot: ComposerDraftSnapshot;
	readonly text: string;
	readonly label: ReactNode;
}

const oneLine = (doc: string): string => doc.trim().replace(/\s+/g, " ");

/** Newest-first prompts with repeats and empty drafts removed. */
export const uniqueSentMessages = (
	entries: readonly ComposerDraftSnapshot[],
): readonly { snapshot: ComposerDraftSnapshot; text: string }[] => {
	const seen = new Set<string>();
	const unique: { snapshot: ComposerDraftSnapshot; text: string }[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const snapshot = entries[i];
		if (snapshot === undefined) continue;
		const text = oneLine(snapshot.doc);
		if (text.length === 0 || seen.has(text)) continue;
		seen.add(text);
		unique.push({ snapshot, text });
	}
	return unique;
};

/**
 * Ctrl+R search over this chat's sent messages and cleared drafts. The list
 * reads bottom-up like the composer history: the newest match sits next to
 * the search field, Up and Ctrl+R walk to older ones.
 */
export function HistorySearchPopover({
	view,
	entries,
	onPick,
	onClose,
}: {
	readonly view: EditorView;
	/** Oldest first, as the composer history stores them. */
	readonly entries: readonly ComposerDraftSnapshot[];
	readonly onPick: (snapshot: ComposerDraftSnapshot) => void;
	readonly onClose: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement | null>(null);

	const unique = useMemo(() => uniqueSentMessages(entries), [entries]);
	const results = useMemo<readonly Result[]>(() => {
		if (query.trim().length === 0)
			return unique
				.slice(0, MAX_RESULTS)
				.map(({ snapshot, text }) => ({ snapshot, text, label: text }));
		return fuzzysort
			.go(query, unique, { key: "text", limit: MAX_RESULTS, threshold: 0.3 })
			.map((result) => ({
				snapshot: result.obj.snapshot,
				text: result.obj.text,
				label: result.highlight((match, index) => (
					<mark key={index} className="bg-transparent text-foreground">
						{match}
					</mark>
				)),
			}));
	}, [unique, query]);

	useEffect(() => setActive(0), [results]);
	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const close = () => {
		onClose();
		view.focus();
	};
	const pick = (result: Result | undefined) => {
		if (result === undefined) return;
		onPick(result.snapshot);
		onClose();
		view.focus();
	};

	const anchor = useComposerAnchor(view);
	if (anchor === null) return null;

	return createPortal(
		<div
			role="dialog"
			aria-label={uiMessage("chat:history_search_placeholder")}
			className={cn(
				"fixed z-50 flex max-h-96 flex-col overflow-hidden p-1.5",
				overlaySurface,
			)}
			style={{ left: anchor.left, bottom: anchor.bottom, width: anchor.width }}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null))
					onClose();
			}}
		>
			<div
				ref={listRef}
				role="listbox"
				aria-label={uiMessage("chat:history_search_results")}
				className="flex min-h-0 flex-col-reverse overflow-y-auto"
			>
				{results.map((result, index) => (
					<button
						key={result.text}
						type="button"
						role="option"
						tabIndex={-1}
						data-index={index}
						aria-selected={index === active}
						onMouseDown={(event) => event.preventDefault()}
						onMouseEnter={() => setActive(index)}
						onClick={() => pick(result)}
						className={cn(
							"w-full shrink-0 truncate rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground",
							index === active
								? "bg-accent text-accent-foreground"
								: "hover:bg-muted/60",
						)}
					>
						{result.label}
					</button>
				))}
			</div>
			<div
				className={cn(
					"flex h-7 shrink-0 items-center gap-2 px-2",
					results.length > 0 && "mt-1 border-t border-border/40 pt-1",
				)}
			>
				<HugeiconsIcon
					icon={Search01Icon}
					className="size-3.5 shrink-0 text-muted-foreground"
				/>
				<input
					// biome-ignore lint/a11y/noAutofocus: the popover exists only to take this query.
					autoFocus
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder={uiMessage("chat:history_search_placeholder")}
					aria-label={uiMessage("chat:history_search_placeholder")}
					className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					onKeyDown={(event) => {
						const older =
							event.key === "ArrowUp" ||
							(event.ctrlKey && event.key.toLowerCase() === "r");
						if (older || event.key === "ArrowDown") {
							event.preventDefault();
							if (results.length === 0) return;
							setActive((index) =>
								older
									? Math.min(index + 1, results.length - 1)
									: Math.max(index - 1, 0),
							);
						} else if (event.key === "Enter" || event.key === "Tab") {
							event.preventDefault();
							pick(results[active]);
						} else if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							close();
						}
					}}
				/>
				{results.length === 0 ? (
					<span className="shrink-0 text-xs text-muted-foreground">
						{uiMessage("chat:history_search_no_results")}
					</span>
				) : null}
			</div>
		</div>,
		document.body,
	);
}
