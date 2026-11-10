import type { Message } from "@zuse/contracts";
import {
	type ChatTimelineRow,
	findFinalAssistantMessage,
} from "./chat-timeline-rows.ts";

/**
 * Find-in-chat runs against the timeline rows rather than the DOM because the
 * transcript is virtualized: rows outside the viewport are not mounted. A match
 * is addressed as "the Nth occurrence inside row R", which survives rows
 * re-rendering, streaming appends, and the row scrolling in or out of view.
 */
export interface ChatFindMatch {
	readonly rowIndex: number;
	readonly rowId: string;
	/** Zero-based occurrence index inside the row's searchable text. */
	readonly ordinal: number;
}

/** Longest query we bother searching; protects against pasting whole files. */
export const CHAT_FIND_QUERY_MAX_CHARS = 200;

export const normalizeChatFindQuery = (query: string): string =>
	query.trim().slice(0, CHAT_FIND_QUERY_MAX_CHARS);

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Case-insensitive, non-overlapping matcher. A regex over the original text
 * (rather than `toLowerCase` + `indexOf`) keeps match offsets valid for the
 * DOM, where case folding can change string length.
 */
export const chatFindMatcher = (query: string): RegExp | null => {
	const normalized = normalizeChatFindQuery(query);
	return normalized.length === 0
		? null
		: new RegExp(escapeRegExp(normalized), "gi");
};

export const countMatches = (text: string, matcher: RegExp): number => {
	if (text.length === 0) return 0;
	matcher.lastIndex = 0;
	let count = 0;
	while (matcher.exec(text) !== null) {
		count += 1;
		if (matcher.lastIndex === 0) break;
	}
	return count;
};

/** Prose the user can read without expanding anything. */
export const chatFindMessageText = (message: Message): string => {
	switch (message.content._tag) {
		case "user":
		case "user_rich":
		case "assistant":
			return message.content.text;
		case "error":
			return message.content.message;
		default:
			return "";
	}
};

/** The message whose prose a row shows by default, mirroring each row kind. */
export const chatFindRowMessage = (row: ChatTimelineRow): Message | null => {
	switch (row.kind) {
		case "message":
			return row.message;
		case "turn-summary":
			return findFinalAssistantMessage(row.body);
		default:
			return null;
	}
};

/** Searchable text of a row. */
export const chatFindRowText = (row: ChatTimelineRow): string => {
	const message = chatFindRowMessage(row);
	return message === null ? "" : chatFindMessageText(message);
};

/**
 * Rows are rebuilt on every timeline change but message objects persist, so
 * per-message counts are memoized to keep streaming cheap in long chats.
 */
const countCache = new WeakMap<
	Message,
	{ readonly query: string; readonly count: number }
>();

const cachedCount = (
	message: Message,
	query: string,
	matcher: RegExp,
): number => {
	const cached = countCache.get(message);
	if (cached !== undefined && cached.query === query) return cached.count;
	const count = countMatches(chatFindMessageText(message), matcher);
	countCache.set(message, { query, count });
	return count;
};

export const findChatMatches = (
	rows: ReadonlyArray<ChatTimelineRow>,
	query: string,
): ChatFindMatch[] => {
	const matcher = chatFindMatcher(query);
	if (matcher === null) return [];
	const normalized = normalizeChatFindQuery(query);
	const matches: ChatFindMatch[] = [];
	for (const [rowIndex, row] of rows.entries()) {
		const message = chatFindRowMessage(row);
		if (message === null) continue;
		const count = cachedCount(message, normalized, matcher);
		for (let ordinal = 0; ordinal < count; ordinal += 1) {
			matches.push({ rowIndex, rowId: row.id, ordinal });
		}
	}
	return matches;
};

export const wrapChatFindIndex = (index: number, total: number): number =>
	total <= 0 ? -1 : ((index % total) + total) % total;

/** Where a fresh query should land: the first match at or below `rowIndex`. */
export const firstChatFindIndexFromRow = (
	rowIndex: number,
	matches: ReadonlyArray<ChatFindMatch>,
): number => {
	if (matches.length === 0) return -1;
	const index = matches.findIndex((match) => match.rowIndex >= rowIndex);
	return index === -1 ? 0 : index;
};

/**
 * Keep the active match stable while the transcript changes underneath it:
 * follow the same (row, ordinal) if it still exists, otherwise stay as close
 * as possible to the previous position.
 */
export const resolveActiveChatFindIndex = (
	previous: ChatFindMatch | null,
	previousIndex: number,
	matches: ReadonlyArray<ChatFindMatch>,
): number => {
	if (matches.length === 0) return -1;
	if (previous !== null) {
		const same = matches.findIndex(
			(match) =>
				match.rowId === previous.rowId && match.ordinal === previous.ordinal,
		);
		if (same !== -1) return same;
	}
	if (previousIndex < 0) return 0;
	return Math.min(previousIndex, matches.length - 1);
};

/** A match located inside a sequence of text segments (DOM text nodes). */
export interface SegmentSpan {
	readonly startSegment: number;
	readonly startOffset: number;
	readonly endSegment: number;
	readonly endOffset: number;
}

/**
 * Locate every match across concatenated segments. Matches may span segment
 * boundaries, which is how rendered markdown splits a phrase across inline
 * elements such as emphasis or code.
 */
export const locateSegmentMatches = (
	segments: ReadonlyArray<string>,
	matcher: RegExp,
): SegmentSpan[] => {
	if (segments.length === 0) return [];
	const starts: number[] = new Array(segments.length);
	let total = 0;
	for (const [index, segment] of segments.entries()) {
		starts[index] = total;
		total += segment.length;
	}
	if (total === 0) return [];
	const joined = segments.join("");
	const spans: SegmentSpan[] = [];
	let segment = 0;
	const locate = (offset: number, inclusiveEnd: boolean) => {
		while (
			segment < segments.length - 1 &&
			(inclusiveEnd
				? offset > (starts[segment] ?? 0) + (segments[segment]?.length ?? 0)
				: offset >= (starts[segment] ?? 0) + (segments[segment]?.length ?? 0))
		) {
			segment += 1;
		}
		return { segment, offset: offset - (starts[segment] ?? 0) };
	};
	matcher.lastIndex = 0;
	let found = matcher.exec(joined);
	while (found !== null && found[0].length > 0) {
		const start = locate(found.index, false);
		const end = locate(found.index + found[0].length, true);
		spans.push({
			startSegment: start.segment,
			startOffset: start.offset,
			endSegment: end.segment,
			endOffset: end.offset,
		});
		found = matcher.exec(joined);
	}
	return spans;
};
