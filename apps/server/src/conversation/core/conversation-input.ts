/** Canonical parsing and formatting helpers for conversation input. */
import type {
	BrowserAnnotation,
	CodeAnnotation,
	ComposerAnnotation,
	MessageContent,
} from "@zuse/contracts";
import { isTrivialUserMessage } from "../../provider/title-generator.ts";

const titleFromInitial = (prompt: string | undefined): string => {
	if (prompt === undefined) return "New chat";
	const firstLine = prompt.trim().split("\n")[0] ?? "";
	const truncated = firstLine.slice(0, 60).trim();
	return truncated.length > 0 ? truncated : "New chat";
};

/** Provisional sidebar title before the LLM auto-namer runs. */
export const deriveProvisionalTitle = (prompt: string | undefined): string => {
	if (prompt === undefined || isTrivialUserMessage(prompt)) return "New chat";
	return titleFromInitial(prompt);
};

export const textFromMessageContent = (
	content: MessageContent,
): string | null => {
	if (
		content._tag === "user" ||
		content._tag === "user_rich" ||
		content._tag === "assistant"
	) {
		return content.text;
	}
	return null;
};

const isBrowserAnnotation = (
	annotation: ComposerAnnotation,
): annotation is BrowserAnnotation =>
	"_tag" in annotation && annotation._tag === "browser";

const serializeCodeAnnotations = (
	annotations: ReadonlyArray<CodeAnnotation>,
): string => {
	const lines = annotations.map((annotation, index) => {
		const range =
			annotation.startLine === annotation.endLine
				? `${annotation.startLine}`
				: `${annotation.startLine}-${annotation.endLine}`;
		const side =
			annotation.diffSide === undefined ? "" : ` (${annotation.diffSide} side)`;
		const previous =
			annotation.oldPath === undefined ? "" : `, previously ${annotation.oldPath}`;
		const base = annotation.baseRef === undefined ? "" : `, base ${annotation.baseRef}`;
		return `${index + 1}. ${annotation.relPath}:${range}${side}${previous}${base} — ${annotation.comment}`;
	});
	return ["Code annotations:", ...lines].join("\n");
};

const serializeBrowserAnnotations = (
	annotations: ReadonlyArray<BrowserAnnotation>,
): string => {
	const lines = annotations.map((annotation, index) => {
		const targetCount =
			annotation.elements.length +
			annotation.regions.length +
			annotation.strokes.length;
		const firstElement = annotation.elements[0];
		const target =
			firstElement !== undefined
				? `<${firstElement.tagName}> ${firstElement.label}`.trim()
				: `${targetCount} visual ${targetCount === 1 ? "target" : "targets"}`;
		const title =
			annotation.pageTitle !== null && annotation.pageTitle.trim().length > 0
				? ` (${annotation.pageTitle.trim()})`
				: "";
		const screenshot =
			annotation.screenshotAttachment !== null ? " Screenshot attached." : "";
		return `${index + 1}. ${annotation.pageUrl}${title} — ${target}; ${annotation.comment}.${screenshot}`;
	});
	return ["Browser annotations:", ...lines].join("\n");
};

export const serializeAnnotations = (
	annotations: ReadonlyArray<ComposerAnnotation>,
): string => {
	const code = annotations.filter(
		(annotation): annotation is CodeAnnotation =>
			!isBrowserAnnotation(annotation),
	);
	const browser = annotations.filter(isBrowserAnnotation);
	return [
		code.length > 0 ? serializeCodeAnnotations(code) : "",
		browser.length > 0 ? serializeBrowserAnnotations(browser) : "",
	]
		.filter((section) => section.length > 0)
		.join("\n\n");
};

export const formatProviderFailure = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (cause !== null && typeof cause === "object") {
		const record = cause as Record<string, unknown>;
		const tag = typeof record._tag === "string" ? record._tag : null;
		const reason = typeof record.reason === "string" ? record.reason : null;
		const providerId =
			typeof record.providerId === "string" ? record.providerId : null;
		const sessionId =
			typeof record.sessionId === "string" ? record.sessionId : null;
		if (reason !== null && reason.length > 0) {
			const provider = providerId !== null ? `${providerId}: ` : "";
			return tag !== null
				? `${tag}: ${provider}${reason}`
				: `${provider}${reason}`;
		}
		if (sessionId !== null) {
			return tag !== null
				? `${tag}: ${sessionId}`
				: `No active provider process for session ${sessionId}.`;
		}
		try {
			return JSON.stringify(cause, null, 2);
		} catch {
			return String(cause);
		}
	}
	return String(cause);
};

/** Authentication failures cannot be recovered by restarting the provider. */
export const looksLikeAuthFailure = (reason: string): boolean =>
	/\b401\b|\bunauthorized\b|invalid authentication credentials|please run \/login|please log ?in|invalid api key|authentication failed|authorizationrequired/i.test(
		reason,
	);
