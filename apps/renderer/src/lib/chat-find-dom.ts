import { type ChatFindMatch, locateSegmentMatches } from "./chat-find.ts";
import { CHAT_MESSAGE_ATTRIBUTE } from "./chat-selection.ts";
import type { ChatTimelineRow } from "./chat-timeline-rows.ts";

/**
 * DOM side of find-in-chat. Highlights go through the CSS Custom Highlight API
 * so the transcript markup is never mutated; styles live in `styles.css` under
 * `::highlight(chat-find)` and `::highlight(chat-find-current)`.
 */
export const CHAT_FIND_HIGHLIGHT = "chat-find";
export const CHAT_FIND_CURRENT_HIGHLIGHT = "chat-find-current";

export const chatFindHighlightsSupported = (): boolean =>
	typeof CSS !== "undefined" &&
	"highlights" in CSS &&
	typeof Highlight === "function";

export const setChatFindHighlights = (
	all: ReadonlyArray<Range>,
	current: Range | null,
): void => {
	if (!chatFindHighlightsSupported()) return;
	const allHighlight = new Highlight();
	for (const range of all) allHighlight.add(range);
	CSS.highlights.set(CHAT_FIND_HIGHLIGHT, allHighlight);
	if (current === null) {
		CSS.highlights.delete(CHAT_FIND_CURRENT_HIGHLIGHT);
		return;
	}
	const currentHighlight = new Highlight(current);
	currentHighlight.priority = 1;
	CSS.highlights.set(CHAT_FIND_CURRENT_HIGHLIGHT, currentHighlight);
};

export const clearChatFindHighlights = (): void => {
	if (!chatFindHighlightsSupported()) return;
	CSS.highlights.delete(CHAT_FIND_HIGHLIGHT);
	CSS.highlights.delete(CHAT_FIND_CURRENT_HIGHLIGHT);
};

const collectTextNodes = (root: Node): Text[] => {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const text = node as Text;
		if (text.data.length > 0) nodes.push(text);
	}
	return nodes;
};

/** Every match inside `root`, including matches that span inline elements. */
export const collectChatFindRanges = (root: Node, matcher: RegExp): Range[] => {
	const nodes = collectTextNodes(root);
	if (nodes.length === 0) return [];
	const spans = locateSegmentMatches(
		nodes.map((node) => node.data),
		matcher,
	);
	const ranges: Range[] = [];
	for (const span of spans) {
		const start = nodes[span.startSegment];
		const end = nodes[span.endSegment];
		if (start === undefined || end === undefined) continue;
		const range = document.createRange();
		range.setStart(start, span.startOffset);
		range.setEnd(end, span.endOffset);
		ranges.push(range);
	}
	return ranges;
};

/**
 * The element whose text `chatFindRowText` describes. Message rows wrap their
 * prose in the annotation attribute; a settled turn renders its final reply as
 * the one prose block that is not nested inside another message.
 */
export const resolveChatFindRowRoot = (
	container: Element,
	row: ChatTimelineRow,
): Element => {
	if (row.kind === "message") {
		return (
			container.querySelector(
				`[${CHAT_MESSAGE_ATTRIBUTE}="${CSS.escape(row.message.id)}"]`,
			) ?? container
		);
	}
	if (row.kind === "turn-summary") {
		for (const prose of container.querySelectorAll(".fz-prose")) {
			if (prose.closest(`[${CHAT_MESSAGE_ATTRIBUTE}]`) === null) return prose;
		}
	}
	return container;
};

/** Rendered markdown can drop or add occurrences; stay inside the row. */
export const pickCurrentChatFindRange = (
	ranges: ReadonlyArray<Range>,
	match: ChatFindMatch,
): Range | null =>
	ranges.length === 0
		? null
		: (ranges[Math.min(match.ordinal, ranges.length - 1)] ?? null);

export interface MountedChatFindRow {
	readonly index: number;
	readonly element: HTMLElement;
}

interface MountedRowsSource {
	getState(): {
		readonly startBuffered: number;
		readonly endBuffered: number;
		readonly elementAtIndex: (index: number) => unknown;
	};
}

/** Row containers the virtualizer currently has in the DOM. */
export const mountedChatFindRows = (
	list: MountedRowsSource,
	rowCount: number,
): MountedChatFindRow[] => {
	const state = list.getState();
	const first = Math.max(0, state.startBuffered);
	const last = Math.min(rowCount - 1, state.endBuffered);
	const rows: MountedChatFindRow[] = [];
	for (let index = first; index <= last; index += 1) {
		const element = state.elementAtIndex(index);
		if (element instanceof HTMLElement) rows.push({ index, element });
	}
	return rows;
};

export const mountedChatFindRow = (
	list: MountedRowsSource,
	index: number,
): HTMLElement | null => {
	const element = list.getState().elementAtIndex(index);
	return element instanceof HTMLElement ? element : null;
};

/**
 * Centre `target` inside `scroller` unless it already sits comfortably within
 * the viewport, so stepping through nearby matches does not shuffle the page.
 */
export const scrollChatFindTargetIntoView = (
	scroller: HTMLElement,
	target: Range | Element,
	behavior: ScrollBehavior,
): void => {
	const viewport = scroller.getBoundingClientRect();
	const rect = target.getBoundingClientRect();
	if (viewport.height <= 0 || (rect.height === 0 && rect.width === 0)) return;
	const margin = Math.min(viewport.height * 0.2, 120);
	const fits =
		rect.top >= viewport.top + margin &&
		rect.bottom <= viewport.bottom - margin;
	if (fits) return;
	const delta =
		rect.top + rect.height / 2 - (viewport.top + viewport.height / 2);
	scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
};

/** Text the user has selected inside the transcript, for prefilling the query. */
export const readChatFindSelection = (root: Element | null): string | null => {
	if (root === null) return null;
	const selection = document.getSelection();
	if (selection === null || selection.isCollapsed || selection.rangeCount === 0)
		return null;
	if (!root.contains(selection.getRangeAt(0).commonAncestorContainer))
		return null;
	const text = selection.toString().trim();
	if (text.length === 0 || text.includes("\n")) return null;
	return text;
};
