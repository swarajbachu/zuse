import type { EnvironmentId, ProviderId } from "@zuse/contracts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { composerOwnsProviderSignIn } from "./provider-auth-recovery.ts";
import { isCloudWorkspaceEnvironment } from "./rpc-client.ts";
import type { ChatError } from "./session-actions.ts";

export type RateLimitInfo = {
	readonly resetText?: string;
	readonly period?: "weekly" | "monthly" | "daily";
};

// Parse rate-limit / usage-limit messages emitted by Claude Code, the
// Anthropic SDK, or other providers. We see them as plain strings (the
// wire ErrorEvent carries no structured metadata) so this is best-effort
// pattern matching against the human-readable text.
export const parseRateLimit = (text: string): RateLimitInfo | null => {
	const isRateLimit =
		/usage limit|rate[-\s]?limit|quota|429|too many requests|overloaded|hit your limit|reached (?:your |the )?limit|agent reached limit/i.test(
			text,
		);
	if (!isRateLimit) return null;

	const resetMatch =
		text.match(
			/reset(?:s|ing)?(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*[ap]m(?:\s*\([^)]+\))?)/i,
		) ??
		text.match(
			/(?:try|see|check)\s+again\s+at\s+(\d{1,2}(?::\d{2})?\s*[ap]m(?:\s*(?:\([^)]+\)|[A-Z][A-Za-z_/-]*(?:\s+time)?))?)/i,
		) ??
		text.match(/reset(?:s|ing)?(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}[T0-9:.Z+-]*)/i);

	const lower = text.toLowerCase();
	const period: RateLimitInfo["period"] = lower.includes("monthly")
		? "monthly"
		: lower.includes("weekly")
			? "weekly"
			: lower.includes("daily")
				? "daily"
				: undefined;

	return { resetText: resetMatch?.[1], period };
};

const RECONNECTING_PATTERN =
	/^\s*Reconnecting\s*\.{3}\s*(\d+)\s*\/\s*(\d+)\s*$/i;

export const parseReconnectingStatus = (
	message: string,
): { readonly attempt: number; readonly maxAttempts: number } | null => {
	const match = RECONNECTING_PATTERN.exec(message);
	if (match === null) return null;
	const attempt = Number(match[1]);
	const maxAttempts = Number(match[2]);
	if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts)) return null;
	return { attempt, maxAttempts };
};

export const GEMINI_UPGRADE_COMMAND = "npm i -g @google/gemini-cli@latest";

export const isGeminiAcpUpgradeError = (text: string): boolean =>
	/Gemini CLI.*(?:does not support ACP|--experimental-acp)|Unknown arguments?:.*(?:experimental-acp|experimentalAcp)/is.test(
		text,
	);

const CLOUD_ACCOUNT_AUTH_PROVIDERS: ReadonlySet<ProviderId> = new Set([
	"claude",
	"codex",
	"cursor",
	"grok",
] as ProviderId[]);

/**
 * What a provider failure means for the user. The transcript renders every
 * notice as a quiet text row; blocking notices also surface above the composer
 * with their recovery action.
 */
export type ProviderErrorNotice =
	| { readonly kind: "usage-limit"; readonly limit: RateLimitInfo }
	| {
			readonly kind: "reconnecting";
			readonly attempt: number;
			readonly maxAttempts: number;
	  }
	| { readonly kind: "gemini-upgrade" }
	/** Cloud workspace account-level credential needs reconnecting. */
	| { readonly kind: "cloud-auth"; readonly providerId: ProviderId }
	/** Local provider with in-app sign-in; `ProviderSignInTray` owns recovery. */
	| { readonly kind: "sign-in"; readonly providerId: ProviderId }
	| { readonly kind: "auth"; readonly providerId?: ProviderId }
	| { readonly kind: "network" }
	| { readonly kind: "terminal"; readonly headline: string }
	| { readonly kind: "generic" };

export const describeProviderError = (
	error: ChatError,
	providerId: ProviderId | undefined,
	environmentId: EnvironmentId | undefined,
): ProviderErrorNotice => {
	if (isGeminiAcpUpgradeError(error.message)) return { kind: "gemini-upgrade" };
	const limit = parseRateLimit(error.message);
	if (limit !== null) return { kind: "usage-limit", limit };
	const reconnecting = parseReconnectingStatus(error.message);
	if (reconnecting !== null) return { kind: "reconnecting", ...reconnecting };
	switch (error.kind) {
		case "auth": {
			const authProvider = error.providerId ?? providerId;
			if (composerOwnsProviderSignIn(authProvider, environmentId))
				return { kind: "sign-in", providerId: authProvider };
			if (
				authProvider !== undefined &&
				environmentId !== undefined &&
				isCloudWorkspaceEnvironment(environmentId) &&
				CLOUD_ACCOUNT_AUTH_PROVIDERS.has(authProvider)
			)
				return { kind: "cloud-auth", providerId: authProvider };
			return authProvider === undefined
				? { kind: "auth" }
				: { kind: "auth", providerId: authProvider };
		}
		case "network":
			return { kind: "network" };
		case "terminal":
			return { kind: "terminal", headline: error.headline };
		case "generic":
			return { kind: "generic" };
	}
};

/**
 * Whether a transcript failure stopped the session in a way the user must act
 * on (wait for a reset, reconnect an account, upgrade a CLI, retry after
 * reconnects ran out). Other failures stay as text in the transcript.
 */
export const isBlockingNotice = (notice: ProviderErrorNotice): boolean => {
	switch (notice.kind) {
		case "usage-limit":
		case "gemini-upgrade":
		case "cloud-auth":
		case "auth":
		case "terminal":
			return true;
		case "reconnecting":
			return notice.attempt >= notice.maxAttempts;
		case "sign-in":
		case "network":
		case "generic":
			return false;
	}
};

type DismissedProviderErrorState = {
	/** Session resource key -> id of the transcript error the user dismissed. */
	readonly dismissedBySession: Readonly<Record<string, string>>;
};

export const useDismissedProviderErrors = create<DismissedProviderErrorState>(
	() => ({ dismissedBySession: {} }),
);

export const dismissTranscriptProviderError = (
	sessionKey: string,
	messageId: string,
): void => {
	useDismissedProviderErrors.setState((state) => ({
		dismissedBySession: {
			...state.dismissedBySession,
			[sessionKey]: messageId,
		},
	}));
};
