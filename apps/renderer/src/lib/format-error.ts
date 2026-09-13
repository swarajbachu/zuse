import "@zuse/i18n/english/errors";
import { message as uiMessage } from "@zuse/i18n";
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
	get PermissionRequestExpiredError() {
		return uiMessage(
			"errors:format_error_the_agent_restarted_and_this_approval_expired_dismiss_it_and_send",
		);
	},
	get PermissionRequestNotFoundError() {
		return uiMessage(
			"errors:format_error_this_approval_is_no_longer_pending_it_may_have_been_resolved_on_a",
		);
	},
	get GitNotARepoError() {
		return uiMessage("errors:format_error_this_folder_isn_t_a_git_repository");
	},
	get DirectoryUnavailableError() {
		return uiMessage("errors:format_error_this_directory_is_unavailable");
	},
	get GitFolderNotFoundError() {
		return uiMessage("errors:format_error_project_folder_not_found");
	},
	get GitNotInstalledError() {
		return uiMessage("errors:format_error_git_is_not_installed");
	},
	get FsFolderNotFoundError() {
		return uiMessage("errors:format_error_project_folder_not_found");
	},
	get WorktreeNotFoundError() {
		return uiMessage("errors:format_error_worktree_not_found");
	},
	// Transport failures ("SocketOpenError: An error occurred during Open")
	// mean the computer on the other end is unreachable — say that instead.
	get SocketOpenError() {
		return uiMessage(
			"errors:format_error_couldn_t_reach_the_computer_it_may_be_asleep_or_offline",
		);
	},
	get SocketCloseError() {
		return uiMessage(
			"errors:format_error_the_connection_to_the_computer_was_interrupted",
		);
	},
	get SocketReadError() {
		return uiMessage(
			"errors:format_error_the_connection_to_the_computer_was_interrupted",
		);
	},
	get SocketWriteError() {
		return uiMessage(
			"errors:format_error_the_connection_to_the_computer_was_interrupted",
		);
	},
	get SocketError() {
		return uiMessage(
			"errors:format_error_couldn_t_reach_the_computer_it_may_be_asleep_or_offline",
		);
	},
	get ClientConnectionError() {
		return uiMessage(
			"errors:format_error_couldn_t_reach_the_computer_it_may_be_asleep_or_offline",
		);
	},
};

const CLOUD_WORKSPACE_CODE_MESSAGES: Readonly<Record<string, string>> = {
	get "not-found"() {
		return uiMessage(
			"errors:format_error_this_cloud_workspace_could_not_be_found",
		);
	},
	get "not-allowed"() {
		return uiMessage(
			"errors:format_error_cloud_workspace_access_is_not_available_for_this_account",
		);
	},
	get "beta-access-required"() {
		return uiMessage("errors:format_error_zuse_cloud_is_currently_invite_only");
	},
	get "beta-access-unavailable"() {
		return uiMessage(
			"errors:format_error_cloud_access_could_not_be_verified_try_again_shortly",
		);
	},
	get "invalid-request"() {
		return uiMessage(
			"errors:format_error_the_cloud_workspace_request_is_invalid",
		);
	},
	get "entitlement-required"() {
		return uiMessage(
			"errors:format_error_a_cloud_sandbox_subscription_is_required",
		);
	},
	get "provider-unavailable"() {
		return uiMessage(
			"errors:format_error_the_cloud_provider_is_temporarily_unavailable_try_again_shortly",
		);
	},
	get "project-not-ready"() {
		return uiMessage(
			"errors:format_error_this_cloud_project_needs_to_be_prepared_again_before_starting_a_w",
		);
	},
	get "credential-required"() {
		return uiMessage(
			"errors:format_error_connect_github_and_the_selected_agent_in_cloud_sandbox_settings_t",
		);
	},
	get "branch-in-use"() {
		return uiMessage(
			"errors:format_error_that_branch_is_already_open_in_another_cloud_workspace_reuse_it_o",
		);
	},
	get conflict() {
		return uiMessage(
			"errors:format_error_the_cloud_workspace_changed_while_starting_refresh_and_try_again",
		);
	},
};

// `environments.list` / `environments.connect` surface api failures as
// ConnectAuthError with a machine-readable reason. Map the reasons a user can
// actually act on; unknown reasons fall through to the generic formatting.
const CONNECT_AUTH_REASON_MESSAGES: Readonly<Record<string, string>> = {
	get "tunnel-unavailable"() {
		return uiMessage(
			"errors:format_error_the_other_computer_s_secure_tunnel_isn_t_ready_yet_give_it_a_mome",
		);
	},
	get "not-allowed"() {
		return uiMessage(
			"errors:format_error_sign_in_to_your_zuse_account_to_reach_this_computer",
		);
	},
	get "not-found"() {
		return uiMessage(
			"errors:format_error_this_computer_is_no_longer_linked_to_your_account_run_zuse_serve",
		);
	},
	get "provider-unavailable"() {
		return uiMessage(
			"errors:format_error_zuse_s_api_is_temporarily_unavailable_try_again_shortly",
		);
	},
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
	if (
		tag === "ConnectAuthError" &&
		reason !== null &&
		CONNECT_AUTH_REASON_MESSAGES[reason] !== undefined
	) {
		return CONNECT_AUTH_REASON_MESSAGES[reason];
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
