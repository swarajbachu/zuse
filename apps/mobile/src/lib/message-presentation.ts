import type { Message, MessageContent } from "@zuse/contracts";

export type ToolResultRecord = Extract<MessageContent, { _tag: "tool_result" }>;

export const buildToolResultsByItemId = (
	messages: readonly Message[],
): ReadonlyMap<string, ToolResultRecord> => {
	const map = new Map<string, ToolResultRecord>();
	for (const message of messages) {
		if (message.content._tag === "tool_result") {
			map.set(message.content.itemId, message.content);
		}
	}
	return map;
};

export const summarizeValue = (value: unknown, maxLength = 360): string => {
	const text =
		typeof value === "string"
			? value
			: (() => {
					try {
						return JSON.stringify(value, null, 2);
					} catch {
						return String(value);
					}
				})();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};
