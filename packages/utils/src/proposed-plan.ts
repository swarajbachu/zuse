type MessageLike = {
	readonly content?: unknown;
};

export const PLAN_APPROVAL_PROMPT =
	"Implement the proposed plan now. Make the code changes.";

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;

const taggedPlanMarkdown = (text: string): string | null => {
	const matches = [
		...text.matchAll(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g),
	];
	const markdown = matches.at(-1)?.[1]?.trim();
	return markdown === undefined || markdown.length === 0 ? null : markdown;
};

/**
 * Extract a final proposed plan from a persisted message content value.
 *
 * Native plan-mode providers emit an `ExitPlanMode` tool use with a `plan`
 * input. Providers that finish plan mode as assistant text wrap the Markdown
 * in a complete `<proposed_plan>` block. Incomplete streaming blocks are
 * deliberately ignored until the closing tag arrives.
 */
export const proposedPlanMarkdownFromContent = (
	content: unknown,
): string | null => {
	const record = asRecord(content);
	if (record === null) return null;

	if (record._tag === "tool_use" && record.tool === "ExitPlanMode") {
		const input = asRecord(record.input);
		const plan = typeof input?.plan === "string" ? input.plan.trim() : "";
		return plan.length > 0 ? plan : null;
	}

	if (record._tag === "assistant" && typeof record.text === "string") {
		if (record.isPlan === true) {
			const markdown = record.text.trim();
			return markdown.length > 0 ? markdown : null;
		}
		return taggedPlanMarkdown(record.text);
	}

	return null;
};

/** Return the newest complete proposed plan in a transcript. */
export const latestProposedPlanMarkdown = (
	messages: ReadonlyArray<MessageLike>,
): string | null => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const markdown = proposedPlanMarkdownFromContent(messages[index]?.content);
		if (markdown !== null) return markdown;
	}

	// Compatibility for transcripts persisted before assistant plan items carried
	// `isPlan`. The approval handoff is durable evidence that the immediately
	// preceding assistant response was the proposed plan, even after the session
	// has switched back to its default permission mode.
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const approval = asRecord(messages[index]?.content);
		if (
			(approval?._tag !== "user" && approval?._tag !== "user_rich") ||
			approval.text !== PLAN_APPROVAL_PROMPT
		) {
			continue;
		}

		for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
			const content = asRecord(messages[candidate]?.content);
			if (content?._tag === "assistant" && typeof content.text === "string") {
				const markdown = content.text.trim();
				return markdown.length > 0 ? markdown : null;
			}
			if (content?._tag === "user" || content?._tag === "user_rich") break;
		}
	}
	return null;
};
