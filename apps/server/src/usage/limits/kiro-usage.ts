import {
	kiroControlPlaneRequest,
	readKiroAuthContext,
} from "@zuse/agents/drivers/kiro-auth";
import type { ProviderUsageLimits, UsageLimitWindow } from "@zuse/contracts";

import { unavailable } from "./shared.ts";

/**
 * Kiro credit limits via the control-plane `GetUsageLimits` API
 * (`https://management.<region>.kiro.dev`). Auth is the OIDC token the CLI
 * keeps in its app-support SQLite DB after `kiro-cli login`.
 */

interface UsageBreakdown {
	readonly resourceType?: string;
	readonly displayName?: string;
	readonly displayNamePlural?: string;
	readonly currentUsage?: number;
	readonly currentUsageWithPrecision?: number;
	readonly usageLimit?: number;
	readonly usageLimitWithPrecision?: number;
	readonly nextDateReset?: number;
	readonly currentOverages?: number;
	readonly currentOveragesWithPrecision?: number;
}

interface GetUsageLimitsResponse {
	readonly nextDateReset?: number;
	readonly subscriptionInfo?: {
		readonly subscriptionTitle?: string;
		readonly type?: string;
	};
	readonly usageBreakdownList?: ReadonlyArray<UsageBreakdown>;
}

const NO_LIMIT_SENTINEL = 999_999;

const resetIsoFromEpochSeconds = (value: unknown): string | null => {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	// API returns epoch seconds (sometimes scientific notation in JSON).
	const ms = value < 10_000_000_000 ? value * 1_000 : value;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const mapKiroUsageLimits = (
	response: GetUsageLimitsResponse,
	fetchedAt = new Date().toISOString(),
): ProviderUsageLimits => {
	const planLabel = response.subscriptionInfo?.subscriptionTitle ?? null;
	const globalReset = resetIsoFromEpochSeconds(response.nextDateReset) ?? null;
	const windows: UsageLimitWindow[] = [];
	let creditsRemaining: number | null = null;

	for (const item of response.usageBreakdownList ?? []) {
		const used = item.currentUsageWithPrecision ?? item.currentUsage ?? null;
		const limit = item.usageLimitWithPrecision ?? item.usageLimit ?? null;
		const hasLimit =
			typeof limit === "number" && limit > 0 && limit < NO_LIMIT_SENTINEL;
		const usedPercent =
			hasLimit && typeof used === "number" && Number.isFinite(used)
				? Math.min(100, Math.max(0, (used / limit) * 100))
				: null;
		const resource =
			item.resourceType?.toLowerCase() === "credit"
				? "credit"
				: (item.resourceType?.toLowerCase() ?? "usage");
		const label =
			item.displayNamePlural ??
			item.displayName ??
			item.resourceType ??
			"Usage";
		windows.push({
			id: `monthly:${resource}`,
			label: `Monthly (${label})`,
			scope: "overall",
			usedPercent,
			resetsAt: resetIsoFromEpochSeconds(item.nextDateReset) ?? globalReset,
			// Monthly cycle — approximate; exact day comes from resetsAt.
			windowMinutes: 43_200,
		});
		if (
			resource === "credit" &&
			hasLimit &&
			typeof used === "number" &&
			Number.isFinite(used)
		) {
			creditsRemaining = Math.max(0, limit - used);
		}
	}

	return {
		providerId: "kiro",
		planLabel,
		windows,
		creditsRemaining,
		fetchedAt,
		source: "api",
	};
};

export const fetchKiroUsage = async (): Promise<ProviderUsageLimits> => {
	const auth = readKiroAuthContext({ refreshIfExpired: true });
	if (auth === null) {
		return unavailable("kiro", "no-credentials");
	}
	if (
		auth.token.expiresAt !== null &&
		!Number.isNaN(Date.parse(auth.token.expiresAt)) &&
		Date.parse(auth.token.expiresAt) <= Date.now()
	) {
		return unavailable("kiro", "expired");
	}

	try {
		const response = await kiroControlPlaneRequest<GetUsageLimitsResponse>(
			auth,
			"GetUsageLimits",
			{
				origin: "KIRO_CLI",
				...(auth.profileArn === null ? {} : { profileArn: auth.profileArn }),
			},
		);
		return mapKiroUsageLimits(response);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		if (/invalid token|unauthori[sz]ed|access denied/i.test(message)) {
			return unavailable("kiro", "expired");
		}
		return unavailable("kiro", "error");
	}
};
