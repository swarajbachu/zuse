import type { ChatAnnotationSource, MessageContent } from "@zuse/contracts";

/** Marks a transcript row whose text can be selected and annotated. */
export const CHAT_MESSAGE_ATTRIBUTE = "data-chat-message";
export const CHAT_SOURCE_ATTRIBUTE = "data-chat-source";

/** Longest quote kept on an annotation; longer selections are truncated. */
export const CHAT_QUOTE_MAX_CHARS = 2000;

/** Which rows can be annotated, and how the agent should refer to them. */
export const chatSelectionSource = (
	content: MessageContent,
): ChatAnnotationSource | null => {
	switch (content._tag) {
		case "assistant":
			return "assistant";
		case "user":
		case "user_rich":
			return "user";
		case "ui_spec":
			return "ui";
		default:
			return null;
	}
};

export interface ChatSelection {
	readonly messageId: string;
	readonly source: ChatAnnotationSource;
	readonly quote: string;
	readonly range: Range;
}

const SOURCES: ReadonlySet<string> = new Set(["assistant", "user", "ui"]);

const rowOf = (node: Node | null): Element | null => {
	const element =
		node instanceof Element ? node : (node?.parentElement ?? null);
	return element?.closest(`[${CHAT_MESSAGE_ATTRIBUTE}]`) ?? null;
};

/**
 * The annotatable part of the current selection inside `root`, or null when
 * nothing usable is selected. A selection spanning several messages is
 * attributed to the message it starts in.
 */
export const readChatSelection = (
	selection: Selection | null,
	root: Element,
): ChatSelection | null => {
	if (selection === null || selection.isCollapsed || selection.rangeCount === 0)
		return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return null;
	const row = rowOf(range.startContainer) ?? rowOf(range.endContainer);
	const messageId = row?.getAttribute(CHAT_MESSAGE_ATTRIBUTE);
	const source = row?.getAttribute(CHAT_SOURCE_ATTRIBUTE);
	if (!messageId || !source || !SOURCES.has(source)) return null;
	const text = selection.toString().trim();
	if (text.length === 0) return null;
	return {
		messageId,
		source: source as ChatAnnotationSource,
		quote:
			text.length > CHAT_QUOTE_MAX_CHARS
				? `${text.slice(0, CHAT_QUOTE_MAX_CHARS - 1)}…`
				: text,
		range: range.cloneRange(),
	};
};
