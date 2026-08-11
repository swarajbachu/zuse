import { recordDiagnosticEvent } from "./diagnostics-recorder.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const diagnosticErrorType = (value: unknown): string => {
	if (isRecord(value)) {
		const tag = value._tag;
		if (typeof tag === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(tag)) {
			return tag;
		}
	}
	if (value instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(value.name)) {
		return value.name;
	}
	return "RendererError";
};

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
	// Transport failures ("SocketOpenError: An error occurred during Open")
	// mean the computer on the other end is unreachable — say that instead.
	SocketOpenError: "Couldn't reach the computer. It may be asleep or offline.",
	SocketCloseError: "The connection to the computer was interrupted.",
	SocketReadError: "The connection to the computer was interrupted.",
	SocketWriteError: "The connection to the computer was interrupted.",
	SocketError: "Couldn't reach the computer. It may be asleep or offline.",
	ClientConnectionError:
		"Couldn't reach the computer. It may be asleep or offline.",
};

const CLOUD_WORKSPACE_CODE_MESSAGES: Readonly<Record<string, string>> = {
	"not-found": "This cloud workspace could not be found.",
	"not-allowed": "Cloud workspace access is not available for this account.",
	"invalid-request": "The cloud workspace request is invalid.",
	"entitlement-required": "A Cloud Sandbox subscription is required.",
	"provider-unavailable":
		"The cloud provider is temporarily unavailable. Try again shortly.",
	"project-not-ready":
		"This cloud project needs to be prepared again before starting a workspace.",
	"branch-in-use":
		"That branch is already open in another cloud workspace. Reuse it or choose another branch.",
	conflict:
		"The cloud workspace changed while starting. Refresh and try again.",
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
		message: diagnosticErrorType(err),
	});
	return formatted;
};

const formatErrorInner = (err: unknown): string => {
	// Plain strings (e.g. a connection supervisor's stored error text) still
	// deserve the tag mapping: "SocketOpenError: An error occurred during
	// Open" should read as human copy everywhere.
	if (typeof err === "string") {
		const stringTag = tagFromErrorName(err);
		return stringTag !== null && TAG_MESSAGES[stringTag] !== undefined
			? TAG_MESSAGES[stringTag]
			: err;
	}
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
	const code =
		typeof err["code"] === "string"
			? err["code"]
			: typeof messagePayload?.["code"] === "string"
				? messagePayload["code"]
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
	if (
		tag === "CloudWorkspaceOpError" &&
		code !== null &&
		CLOUD_WORKSPACE_CODE_MESSAGES[code] !== undefined
	) {
		return CLOUD_WORKSPACE_CODE_MESSAGES[code];
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
	// A wrapper error (connection layer, fiber failure) often carries the
	// tagged error only as text — "SocketOpenError: An error occurred during
	// Open". Map it when the embedded tag is a known one; never use the
	// embedded tag for generic prefixing.
	const messageTag = tagFromErrorName(message);
	if (messageTag !== null && TAG_MESSAGES[messageTag] !== undefined) {
		return TAG_MESSAGES[messageTag];
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
