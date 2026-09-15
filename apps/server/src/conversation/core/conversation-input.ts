/** Canonical parsing and formatting helpers for conversation input. */
import type { MessageContent } from "@zuse/contracts";

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

export { serializeAnnotations } from "@zuse/client-runtime/composer-feedback";

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
