import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";
import type { ProviderUsageLimits, UsageLimitWindow } from "@zuse/contracts";

import { normalizePercent, normalizeReset, unavailable } from "./shared.ts";

type RateWindow = {
	usedPercent?: number;
	resetsAt?: number;
	windowDurationMins?: number;
};
type RateLimit = {
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
			? Object.values(raw.rateLimitsByLimitId)
			: raw.rateLimits
				? [raw.rateLimits]
				: [];
	const windows: UsageLimitWindow[] = [];
	const hasMultipleLimits = values.length > 1;
	for (const [index, limit] of values.entries())
		for (const [kind, item] of [
			["primary", limit.primary],
			["secondary", limit.secondary],
		] as const) {
			if (!item) continue;
			const minutes = item.windowDurationMins ?? null;
			const shortWindow = minutes !== null && minutes <= 1_440;
			const limitName = limit.limitName?.trim() || null;
			const genericLimit =
				limitName === null || /^(general|default|weekly)$/i.test(limitName);
			windows.push({
				id: `${index}:${kind}`,
				label: limitName ?? (shortWindow ? "Session" : "Weekly"),
				scope: shortWindow
					? "session"
					: hasMultipleLimits && !genericLimit
						? "model"
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

export const fetchCodexUsage = async (): Promise<ProviderUsageLimits> => {
	let client: CodexAppServerClient | null = null;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		client = await CodexAppServerClient.start({
			codexPath: "codex",
			startupTimeoutMs: 5_000,
			onNotification: () => {},
			onServerRequest: (_request, respond) => respond(null),
		});
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error("timeout")), 5_000);
		});
		const result = await Promise.race([
			client.request<unknown>("account/rateLimits/read", {}),
			timeoutPromise,
		]);
		return mapCodexRateLimits(result);
	} catch {
		return unavailable("codex", "error");
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		client?.close();
	}
};
