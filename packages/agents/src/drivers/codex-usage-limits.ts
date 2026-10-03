import type { ProviderUsageLimits, UsageLimitWindow } from "@zuse/contracts";
import { normalizePercent, normalizeReset } from "@zuse/utils/usage-values";

type RateWindow = {
	usedPercent?: number;
	resetsAt?: number | null;
	windowDurationMins?: number | null;
};
type RateLimit = {
	limitId?: string | null;
	limitName?: string | null;
	primary?: RateWindow | null;
	secondary?: RateWindow | null;
	credits?: { balance?: string | number | null } | null;
	planType?: string | null;
};

export const mapCodexRateLimits = (
	response: unknown,
	fetchedAt = new Date().toISOString(),
): ProviderUsageLimits => {
	const raw = response as unknown as {
		rateLimitsByLimitId?: Record<string, RateLimit>;
		rateLimits?: RateLimit | RateLimit[];
	};
	const values = Array.isArray(raw.rateLimits)
		? raw.rateLimits
		: raw.rateLimitsByLimitId
			? Object.entries(raw.rateLimitsByLimitId)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([id, value]) => ({ ...value, limitId: id }))
			: raw.rateLimits
				? [raw.rateLimits]
				: [];
	const windows: UsageLimitWindow[] = [];
	for (const limit of values)
		for (const [kind, item] of [
			["primary", limit.primary],
			["secondary", limit.secondary],
		] as const) {
			if (!item || normalizePercent(item.usedPercent) === null) continue;
			const minutes =
				item.windowDurationMins ??
				(kind === "secondary"
					? 10_080
					: limit.planType === "free" || limit.planType === "go"
						? 43_200
						: 300);
			const shortWindow = minutes !== null && minutes <= 1_440;
			const limitName = limit.limitName?.trim() || null;
			const genericLimit =
				limitName === null
					? !limit.limitId || limit.limitId === "codex"
					: /^(general|default|weekly|codex(?: usage| weekly)?)$/i.test(
							limitName,
						);
			windows.push({
				id: `${limit.limitId ?? "codex"}:${kind}`,
				label: genericLimit
					? shortWindow
						? "Session"
						: minutes >= 43_200
							? "Monthly"
							: "Weekly"
					: `${limitName ?? limit.limitId}${shortWindow ? " (session)" : ""}`,
				scope: !genericLimit
					? "model"
					: shortWindow
						? "session"
						: minutes >= 43_200
							? "overall"
							: "weekly",
				usedPercent: normalizePercent(item.usedPercent),
				resetsAt: normalizeReset(item.resetsAt),
				windowMinutes: minutes,
			});
		}
	return {
		providerId: "codex",
		planLabel: values.find((value) => value.planType)?.planType ?? null,
		windows,
		creditsRemaining: (() => {
			const balance = values.find((value) => value.credits?.balance != null)
				?.credits?.balance;
			if (balance === null || balance === undefined) return null;
			const numeric = typeof balance === "number" ? balance : Number(balance);
			return Number.isFinite(numeric) ? numeric : null;
		})(),
		fetchedAt,
		source: "api",
	};
};
