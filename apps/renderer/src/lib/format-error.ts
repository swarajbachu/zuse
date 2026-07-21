import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

// Tagged errors that carry only ids (no `reason`/`message`) would otherwise
// fall through to a raw JSON dump like `{ "folderId": "…" }`. Map them to
// human copy here so any surface that formats them stays readable.
const TAG_MESSAGES: Record<string, string> = {
	GitNotARepoError: "This folder isn't a Git repository.",
	DirectoryUnavailableError: "This directory is unavailable.",
	GitFolderNotFoundError: "Project folder not found.",
	GitNotInstalledError: "Git is not installed.",
	FsFolderNotFoundError: "Project folder not found.",
	WorktreeNotFoundError: "Worktree not found.",
};

const parseJsonRecord = (
	value: string | null,
): Record<string, unknown> | null => {
	if (value === null || !value.trim().startsWith("{")) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
};

const tagFromErrorName = (value: string | null): string | null => {
	if (value === null) return null;
	const match = /\b([A-Za-z][A-Za-z0-9]*Error)\b/.exec(value);
	return match?.[1] ?? null;
};

export const formatError = (err: unknown): string => {
	const formatted = formatErrorInner(err);
	recordDiagnosticEvent({
		level: "error",
		source: "renderer.formatError",
		message: formatted,
	});
	return formatted;
};

const formatErrorInner = (err: unknown): string => {
	if (!isRecord(err)) return String(err);

	const message = typeof err["message"] === "string" ? err["message"] : null;
	const messagePayload = parseJsonRecord(message);
	const errorName = err instanceof Error ? err.name : null;
	const tag =
		typeof err["_tag"] === "string"
			? err["_tag"]
			: typeof messagePayload?.["_tag"] === "string"
				? messagePayload["_tag"]
				: tagFromErrorName(errorName);
	const reason =
		typeof err["reason"] === "string"
			? err["reason"]
			: typeof messagePayload?.["reason"] === "string"
				? messagePayload["reason"]
				: null;
	const providerId =
		typeof err["providerId"] === "string"
			? err["providerId"]
			: typeof messagePayload?.["providerId"] === "string"
				? messagePayload["providerId"]
				: null;
	const sessionId =
		typeof err["sessionId"] === "string"
			? err["sessionId"]
			: typeof messagePayload?.["sessionId"] === "string"
				? messagePayload["sessionId"]
				: null;
	const output =
		typeof err["output"] === "string"
			? err["output"]
			: typeof messagePayload?.["output"] === "string"
				? messagePayload["output"]
				: null;
	const exitCode =
		typeof err["exitCode"] === "number"
			? err["exitCode"]
			: typeof messagePayload?.["exitCode"] === "number"
				? messagePayload["exitCode"]
				: null;
	const timeoutMs =
		typeof err["timeoutMs"] === "number"
			? err["timeoutMs"]
			: typeof messagePayload?.["timeoutMs"] === "number"
				? messagePayload["timeoutMs"]
				: null;

	if (tag === "ChatArchiveScriptError") {
		const status = exitCode === null ? "failed" : `exited ${exitCode}`;
		return output !== null && output.trim().length > 0
			? `Archive cleanup ${status}:\n${output.trim()}`
			: `Archive cleanup ${status}.`;
	}
	if (tag === "ChatArchiveTimeoutError") {
		const seconds =
			timeoutMs === null ? "the timeout" : `${Math.round(timeoutMs / 1000)}s`;
		return output !== null && output.trim().length > 0
			? `Archive cleanup timed out after ${seconds}:\n${output.trim()}`
			: `Archive cleanup timed out after ${seconds}.`;
	}
	if (reason !== null && reason.length > 0) {
		const provider = providerId !== null ? `${providerId}: ` : "";
		return tag !== null
			? `${tag}: ${provider}${reason}`
			: `${provider}${reason}`;
	}
	if (tag !== null && TAG_MESSAGES[tag] !== undefined) {
		return TAG_MESSAGES[tag];
	}
	if (message !== null && message.length > 0) {
		return tag !== null ? `${tag}: ${message}` : message;
	}
	if (sessionId !== null && Object.keys(err).length === 1) {
		return `Internal session response was routed as an error: ${sessionId}`;
	}
	if (tag !== null) return tag;
	if (err instanceof Error) return err.message;

	try {
		return JSON.stringify(err, null, 2);
	} catch {
		return String(err);
	}
};
