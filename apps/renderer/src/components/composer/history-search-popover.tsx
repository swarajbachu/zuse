import "@zuse/i18n/english/chat";
import type { EditorView } from "@codemirror/view";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Search01Icon } from "@zuse/icons/stroke-rounded";
import fuzzysort from "fuzzysort";
import { useEffect, useMemo, useState } from "react";

import { Kbd } from "~/components/ui/kbd";
import { formatTimeAgo } from "~/lib/use-relative-time";
import type { ComposerDraftSnapshot } from "../../store/composer-drafts.ts";
import {
	type ComposerListItem,
	ComposerListPopover,
} from "./composer-list-popover.tsx";

const MAX_RESULTS = 50;

export type RecallEntry = {
	readonly at: number;
	readonly snapshot: ComposerDraftSnapshot;
};

type SearchableEntry = RecallEntry & { readonly text: string };

/** Newest-first prompts with repeats and empty drafts removed. */
export const uniqueRecallEntries = (
	entries: readonly RecallEntry[],
): readonly SearchableEntry[] => {
	const seen = new Set<string>();
	const unique: SearchableEntry[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry === undefined) continue;
		const text = entry.snapshot.doc.trim().replace(/\s+/g, " ");
		if (text.length === 0 || seen.has(text)) continue;
		seen.add(text);
		unique.push({ ...entry, text });
	}
	return unique;
};

/**
 * Ctrl+R: while active, the composer text is the query and matching sent
 * messages list above it, newest first. Enter takes the highlighted one,
 * Ctrl+R again steps to the next, Escape puts the original draft back.
 */
export function HistorySearchPopover({
	view,
	entries,
	query,
	stepRequest,
	onPick,
	onCancel,
}: {
	readonly view: EditorView;
	/** Oldest first, as the composer history stores them. */
	readonly entries: readonly RecallEntry[];
	readonly query: string;
	/** Bumped by each extra Ctrl+R to move to the next match. */
	readonly stepRequest: number;
	readonly onPick: (snapshot: ComposerDraftSnapshot) => void;
	readonly onCancel: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const unique = useMemo(() => uniqueRecallEntries(entries), [entries]);
	const matches = useMemo(() => {
		const trimmed = query.trim();
		if (trimmed.length === 0)
			return unique
				.slice(0, MAX_RESULTS)
				.map((entry) => ({ entry, label: entry.text as React.ReactNode }));
		return fuzzysort
			.go(trimmed, unique, { key: "text", limit: MAX_RESULTS, threshold: 0.3 })
			.map((result) => ({
				entry: result.obj,
				label: result.highlight((match, index) => (
					<mark
						key={index}
						className="bg-transparent font-medium text-foreground"
					>
						{match}
					</mark>
				)) as React.ReactNode,
			}));
	}, [query, unique]);

	const [active, setActive] = useState(0);
	useEffect(() => setActive(0), [query]);
	useEffect(() => {
		if (stepRequest > 0)
			setActive((index) =>
				Math.min(index + 1, Math.max(0, matches.length - 1)),
			);
	}, [stepRequest, matches.length]);

	const now = Date.now();
	const items: ComposerListItem[] = matches.map(({ entry, label }) => ({
		id: `${entry.at}:${entry.text}`,
		content: label,
		trailing: (
			<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
				{formatTimeAgo(entry.at, now)}
			</span>
		),
	}));

	return (
		<ComposerListPopover
			view={view}
			label={uiMessage("chat:history_search_results")}
			header={
				<>
					<HugeiconsIcon icon={Search01Icon} className="size-3.5" />
					<span className="flex-1">
						{uiMessage("chat:history_search_title")}
					</span>
					<Kbd className="h-4 px-1 text-[10px]">↵</Kbd>
					<span>{uiMessage("chat:history_search_use")}</span>
					<Kbd className="ms-1 h-4 px-1 text-[10px]">
						{uiMessage("chat:command_palette_esc")}
					</Kbd>
					<span>{uiMessage("chat:history_search_cancel")}</span>
				</>
			}
			items={items}
			active={active}
			onActiveChange={setActive}
			onPick={(index) => {
				const match = matches[index];
				if (match !== undefined) onPick(match.entry.snapshot);
			}}
			onClose={onCancel}
			onKey={(event) => {
				// Without matches, Enter must not send the query as a message.
				if (event.key === "Enter" && matches.length === 0) return true;
				return false;
			}}
			empty={uiMessage(
				unique.length === 0
					? "chat:history_search_empty"
					: "chat:history_search_no_results",
			)}
		/>
	);
}
