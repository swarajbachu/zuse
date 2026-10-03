import "@zuse/i18n/english/usage";
import type { ProviderId, ProviderUsageLimits } from "@zuse/contracts";
import { message } from "@zuse/i18n";

import { PROVIDER_DISPLAY } from "./provider-status";

export const usageLimitsUnavailableLabel = (
	providerId: ProviderId,
	reason: ProviderUsageLimits["unavailableReason"],
): string => {
	const providerName = PROVIDER_DISPLAY[providerId];
	if (reason === "cli-unavailable")
		return message("usage:usage_limits_cli_unavailable", {
			provider: providerName,
		});
	if (reason === "unsupported-version")
		return message("usage:usage_limits_upgrade_cli", {
			provider: providerName,
		});
	if (reason === "timeout")
		return message("usage:usage_limits_timeout", { provider: providerName });
	if (reason === "invalid-response")
		return message("usage:usage_limits_invalid_response", {
			provider: providerName,
		});
	if (reason === "unsupported")
		return message("usage:usage_limits_unavailable_account");
	if (reason === "scope-missing")
		return message("usage:usage_limits_unavailable_scope");
	if (reason === "no-credentials") {
		return providerId === "kiro"
			? message("usage:usage_limits_sign_in_kiro")
			: message("usage:usage_limits_sign_in", { provider: providerName });
	}
	if (reason === "expired") {
		return providerId === "kiro"
			? message("usage:usage_limits_expired_kiro")
			: message("usage:usage_limits_expired", { provider: providerName });
	}
	if (reason === "error") return message("usage:usage_limits_load_failed");
	return message("usage:usage_limits_no_data");
};

/** Compact absolute count for menu rows (e.g. 1479 → "1.5k"). */
export const formatCredits = (value: number): string => {
	if (!Number.isFinite(value)) return "—";
	const abs = Math.abs(value);
	if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
	if (abs >= 1000) {
		const k = value / 1000;
		return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/**
 * Derive used/limit from remaining credits + used%, when the API only
 * surfaces remaining + percent (Kiro credit windows).
 */
export const creditUsage = (
	creditsRemaining: number | null,
	usedPercent: number | null | undefined,
): { used: number; limit: number; remaining: number } | null => {
	if (
		creditsRemaining === null ||
		usedPercent === null ||
		usedPercent === undefined ||
		!Number.isFinite(creditsRemaining) ||
		!Number.isFinite(usedPercent)
	) {
		return null;
	}
	const remaining = Math.max(0, creditsRemaining);
	const fractionUsed = Math.min(100, Math.max(0, usedPercent)) / 100;
	if (fractionUsed <= 0) {
		return { used: 0, limit: remaining, remaining };
	}
	// At 100% we only know remaining (usually 0); skip absolute used/limit.
	if (fractionUsed >= 1) return null;
	const limit = remaining / (1 - fractionUsed);
	if (!Number.isFinite(limit) || limit <= 0) return null;
	const used = Math.max(0, limit - remaining);
	return { used, limit, remaining };
};

export const boundedUsagePercent = (
	value: number | null | undefined,
): number | null =>
	value == null || !Number.isFinite(value)
		? null
		: Math.min(100, Math.max(0, value));

export const percentLeft = (
	value: number | null | undefined,
): number | null => {
	const used = boundedUsagePercent(value);
	return used === null ? null : Math.round(100 - used);
};
