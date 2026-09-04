import type {
	CloudCommandBlockedReason,
	CloudCommandState,
} from "@zuse/contracts";

export type CloudFailureKind =
	| "sign-in-required"
	| "billing-blocked"
	| "update-required"
	| "cloud-access-required"
	| "cloud-access-unavailable"
	| "credentials-required"
	| "workspace-deleted"
	| "interaction-expired"
	| "session-unavailable"
	| "outcome-unknown"
	| "cancelled"
	| "rejected"
	| "network";

export type CloudFailurePresentation = Readonly<{
	kind: CloudFailureKind;
	label: string;
	headline: string;
	message: string;
}>;

export type CloudFailureInput = Readonly<{
	state?: CloudCommandState;
	category?: string;
	blockedUntil?: CloudCommandBlockedReason;
	cause?: unknown;
}>;

const STORAGE_LOSS_CATEGORIES = new Set([
	"runtime-storage-replaced",
	"runtime-storage-incarnation-mismatch",
]);

const APPLIED_RESULT_RECOVERY_CATEGORIES = new Set([
	"result-expired",
	"result-invalid",
]);

const LOCAL_RECOVERY_CATEGORIES = new Set([
	"invalid-local-envelope",
	"invalid-local-acceptance",
	"command-identity-unverified",
]);

const WORKSPACE_CHANGED_AFTER_LEASE_CATEGORIES = new Set([
	"workspace-deleted-after-lease",
	"workspace-archived-after-lease",
	"workspace-destruction-fence-advanced-after-lease",
]);

const CATEGORY_KIND: Readonly<Record<string, CloudFailureKind>> = {
	"sign-in-required": "sign-in-required",
	"auth-required": "sign-in-required",
	"authentication-required": "sign-in-required",
	"codex-auth-reconnect-required": "sign-in-required",
	"codex-auth-legacy-workspace": "sign-in-required",
	"claude-auth-reconnect-required": "sign-in-required",
	"claude-auth-legacy-workspace": "sign-in-required",
	"cursor-auth-reconnect-required": "sign-in-required",
	"cursor-auth-legacy-workspace": "sign-in-required",
	"grok-auth-reconnect-required": "sign-in-required",
	"grok-auth-legacy-workspace": "sign-in-required",
	"not-allowed": "sign-in-required",
	"billing-blocked": "billing-blocked",
	"billing-hold": "billing-blocked",
	"entitlement-required": "billing-blocked",
	"update-required": "update-required",
	"invalid-request": "update-required",
	"command-kind-not-supported": "update-required",
	"command-schema-not-supported": "update-required",
	"command-dependencies-not-supported": "update-required",
	"codex-auth-update-required": "update-required",
	"claude-auth-update-required": "update-required",
	"cursor-auth-update-required": "update-required",
	"grok-auth-update-required": "update-required",
	"provider-auth-update-required": "update-required",
	"beta-access-required": "cloud-access-required",
	"beta-access-unavailable": "cloud-access-unavailable",
	"credential-required": "credentials-required",
	"workspace-deleted": "workspace-deleted",
	"workspace-destroyed": "workspace-deleted",
	"workspace-archived": "workspace-deleted",
	"workspace-destruction-fence-advanced": "workspace-deleted",
	"workspace-deleted-after-lease": "workspace-deleted",
	"workspace-archived-after-lease": "workspace-deleted",
	"workspace-destruction-fence-advanced-after-lease": "workspace-deleted",
	"interaction-expired": "interaction-expired",
	"reservation-expired": "interaction-expired",
	"session-not-found": "session-unavailable",
	"session-unavailable": "session-unavailable",
	"codex-auth-reconnecting": "network",
	"claude-auth-reconnecting": "network",
	"cursor-auth-reconnecting": "network",
	"grok-auth-reconnecting": "network",
};

const BLOCKED_KIND: Partial<
	Readonly<Record<CloudCommandBlockedReason, CloudFailureKind>>
> = {
	"auth-restored": "sign-in-required",
	"billing-restored": "billing-blocked",
	"runtime-compatible": "update-required",
};

const readString = (value: unknown, key: string): string | null => {
	if (typeof value !== "object" || value === null) return null;
	const field = Reflect.get(value, key);
	return typeof field === "string" && field.trim().length > 0 ? field : null;
};

const causeDetails = (
	cause: unknown,
): Readonly<{ identifiers: readonly string[]; text: string }> => {
	const reason =
		readString(cause, "reason") ??
		(typeof cause === "object" && cause !== null
			? readString(Reflect.get(cause, "reason"), "message")
			: null);
	const message =
		readString(cause, "message") ??
		(typeof cause === "string" ? cause : null) ??
		"";
	return {
		identifiers: [
			readString(cause, "category"),
			readString(cause, "code"),
			readString(cause, "_tag"),
			cause instanceof Error ? cause.name : null,
		].flatMap((value) => (value === null ? [] : [value])),
		text: [reason, message].filter((value) => value !== null).join(" "),
	};
};

const categoryKind = (
	category: string | undefined,
	blockedUntil: CloudCommandBlockedReason | undefined,
): CloudFailureKind | null =>
	(category === undefined ? undefined : CATEGORY_KIND[category]) ??
	(blockedUntil === undefined ? undefined : BLOCKED_KIND[blockedUntil]) ??
	null;

const causeKind = (cause: unknown): CloudFailureKind | null => {
	const details = causeDetails(cause);
	for (const identifier of details.identifiers) {
		const exact = categoryKind(identifier, undefined);
		if (exact !== null) return exact;
		if (
			identifier === "SessionNotFoundError" ||
			identifier === "AgentSessionNotFoundError"
		)
			return "session-unavailable";
	}
	const text = details.text;
	const exactText = categoryKind(text.trim(), undefined);
	if (exactText !== null) return exactText;
	if (
		/\b401\b|\bunauthorized\b|expired token|refresh token|invalid_grant|signed?\s?out|sign\s?in required|please log ?in|please run \/login|not logged in|invalid authentication credentials|invalid api key|authorizationrequired|auth\(authorizationrequired\)|authentication (?:failed|required)/i.test(
			text,
		)
	)
		return "sign-in-required";
	if (
		/update required|protocol mismatch|schema mismatch|unsupported protocol/i.test(
			text,
		)
	)
		return "update-required";
	if (/billing hold|entitlement required|subscription required/i.test(text))
		return "billing-blocked";
	if (/\b(?:SessionNotFoundError|AgentSessionNotFoundError)\b/.test(text))
		return "session-unavailable";
	if (
		/\b(network|fetch|econn|enotfound|etimedout|timeout|getaddrinfo|offline|socket|websocket)\b/i.test(
			text,
		)
	)
		return "network";
	return null;
};

const outcomeUnknownMessage = (category: string | undefined): string => {
	if (category !== undefined && STORAGE_LOSS_CATEGORIES.has(category)) {
		return "The sandbox storage was replaced, so Zuse cannot confirm whether the agent applied this command.";
	}
	if (
		category !== undefined &&
		APPLIED_RESULT_RECOVERY_CATEGORIES.has(category)
	) {
		return "The command was applied, but its saved result could not be recovered.";
	}
	if (category !== undefined && LOCAL_RECOVERY_CATEGORIES.has(category)) {
		return "The accepted command's local recovery data could not be verified, so Zuse cannot confirm whether the agent applied it.";
	}
	if (
		category !== undefined &&
		WORKSPACE_CHANGED_AFTER_LEASE_CATEGORIES.has(category)
	) {
		return "The workspace was archived or deleted during delivery, so Zuse cannot confirm whether the agent applied this command.";
	}
	return "Zuse could not confirm whether the agent applied this command. It was not sent again to avoid a duplicate.";
};

type FailureCopy = Omit<CloudFailurePresentation, "kind">;

const FAILURE_COPY: Readonly<Record<CloudFailureKind, FailureCopy>> = {
	"sign-in-required": {
		label: "Sign in required",
		headline: "Sign in required",
		message: "Sign in, then retry.",
	},
	"billing-blocked": {
		label: "Billing action required",
		headline: "Billing action required",
		message: "Update your Cloud Sandbox billing to continue.",
	},
	"update-required": {
		label: "Update required",
		headline: "Update required",
		message: "Update Zuse or the cloud runtime before retrying.",
	},
	"cloud-access-required": {
		label: "Cloud access required",
		headline: "Zuse Cloud is invite-only",
		message: "This account does not currently have cloud beta access.",
	},
	"cloud-access-unavailable": {
		label: "Cloud access unavailable",
		headline: "Cloud access could not be verified",
		message: "Try again shortly. Your cached chat is still available.",
	},
	"credentials-required": {
		label: "Credentials required",
		headline: "Credentials required",
		message: "Connect GitHub and your agent provider, then retry.",
	},
	"workspace-deleted": {
		label: "Workspace unavailable",
		headline: "Workspace unavailable",
		message:
			"This workspace was archived or deleted before the command could finish.",
	},
	"interaction-expired": {
		label: "Interaction expired",
		headline: "Interaction expired",
		message: "This interaction expired while the agent was unavailable.",
	},
	"session-unavailable": {
		label: "Session unavailable",
		headline: "Session unavailable",
		message: "This chat session is no longer available in the agent runtime.",
	},
	"outcome-unknown": {
		label: "Command outcome unknown",
		headline: "Command outcome unknown",
		message: "",
	},
	cancelled: {
		label: "Command cancelled",
		headline: "Command cancelled",
		message: "The queued command was cancelled before the agent started it.",
	},
	rejected: {
		label: "Command not delivered",
		headline: "Command not delivered",
		message: "The agent rejected this command.",
	},
	network: {
		label: "Connection lost",
		headline: "Connection lost",
		message: "The connection was interrupted. Zuse will keep retrying.",
	},
};

const presentationFor = (
	kind: CloudFailureKind,
	category: string | undefined,
): CloudFailurePresentation => ({
	kind,
	...FAILURE_COPY[kind],
	...(kind === "outcome-unknown"
		? { message: outcomeUnknownMessage(category) }
		: {}),
});

/**
 * Single renderer boundary for mailbox categories, control-plane errors, and
 * provider failures. Callers consume the typed kind instead of parsing copy.
 */
export const cloudFailurePresentation = (
	input: CloudFailureInput,
): CloudFailurePresentation | null => {
	if (input.state === "outcome-unknown")
		return presentationFor("outcome-unknown", input.category);
	const categorized = categoryKind(input.category, input.blockedUntil);
	if (categorized !== null) return presentationFor(categorized, input.category);
	if (input.state === "expired")
		return presentationFor("interaction-expired", input.category);
	if (input.state === "cancelled")
		return presentationFor("cancelled", input.category);
	if (input.state === "rejected")
		return presentationFor("rejected", input.category);
	if (input.cause === undefined) return null;
	const classified = causeKind(input.cause);
	return classified === null
		? null
		: presentationFor(classified, input.category);
};

/** A missing provider session makes a cached question or plan answer expire. */
export const cloudInteractionFailure = (
	cause: unknown,
): Readonly<{
	expired: boolean;
	presentation: CloudFailurePresentation | null;
}> => {
	const presentation = cloudFailurePresentation({ cause });
	const expired =
		presentation?.kind === "session-unavailable" ||
		presentation?.kind === "interaction-expired";
	return {
		expired,
		presentation: expired
			? presentationFor("interaction-expired", "interaction-expired")
			: presentation,
	};
};
