import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
	type ClaudeControlOptions,
	withClaudeControlClient,
} from "@zuse/agents/drivers/claude-control-client";
import type { ProviderUsageLimits, UsageLimitWindow } from "@zuse/contracts";

import { normalizePercent, normalizeReset, unavailable } from "./shared.ts";

type ClaudeWindow = { utilization?: number; resets_at?: string | number };
type ClaudeScopedLimit = {
	kind?: string;
	group?: string;
	percent?: number;
	resets_at?: string | number;
	scope?: {
		model?: { id?: string | null; display_name?: string | null } | null;
	} | null;
};
type ClaudePayload = Record<string, unknown> & {
	extra_usage?: {
		balance?: number;
		credits_remaining?: number;
		is_enabled?: boolean;
		monthly_limit?: number | null;
		used_credits?: number | null;
	} | null;
	subscriptionType?: string;
	rate_limit_tier?: string;
	limits?: ClaudeScopedLimit[];
};

const title = (value: string) =>
	value
		.split(/[-_]/)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");

const slug = (value: string) =>
	value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

export const parseClaudeUsagePayload = (
	payload: ClaudePayload,
	fetchedAt = new Date().toISOString(),
): ProviderUsageLimits => {
	const windows: UsageLimitWindow[] = [];
	for (const [key, raw] of Object.entries(payload)) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const item = raw as ClaudeWindow;
		// Prefixes also identify metadata such as seven_day_breakdown. A real
		// allowance must carry a finite usage percentage; zero is valid.
		const usedPercent = normalizePercent(item.utilization);
		if (usedPercent === null) continue;
		if (key === "five_hour")
			windows.push({
				id: key,
				label: "Session",
				scope: "session",
				usedPercent,
				resetsAt: normalizeReset(item.resets_at),
				windowMinutes: 300,
			});
		else if (key === "seven_day")
			windows.push({
				id: key,
				label: "Weekly",
				scope: "weekly",
				usedPercent,
				resetsAt: normalizeReset(item.resets_at),
				windowMinutes: 10_080,
			});
		else if (key.startsWith("seven_day_")) {
			const model = title(key.slice(10));
			windows.push({
				id: key,
				label: `${model} only`,
				scope: "model",
				usedPercent,
				resetsAt: normalizeReset(item.resets_at),
				windowMinutes: 10_080,
			});
		}
	}
	const modelWindowIds = new Set(
		windows
			.filter((window) => window.scope === "model")
			.map((window) => slug(window.label.replace(/ only$/i, ""))),
	);
	for (const limit of payload.limits ?? []) {
		if (limit.kind !== "weekly_scoped" || limit.group !== "weekly") continue;
		const modelName = limit.scope?.model?.display_name?.trim();
		if (!modelName) continue;
		const modelId = slug(limit.scope?.model?.id?.trim() || modelName);
		if (!modelId || modelWindowIds.has(modelId)) continue;
		const usedPercent = normalizePercent(limit.percent);
		if (usedPercent === null) continue;
		modelWindowIds.add(modelId);
		windows.push({
			id: `weekly-scoped:${modelId}`,
			label: `${modelName} only`,
			scope: "model",
			usedPercent,
			resetsAt: normalizeReset(limit.resets_at),
			windowMinutes: 10_080,
		});
	}
	return {
		providerId: "claude",
		planLabel: payload.subscriptionType ?? payload.rate_limit_tier ?? null,
		windows,
		creditsRemaining:
			payload.extra_usage?.credits_remaining ??
			payload.extra_usage?.balance ??
			null,
		fetchedAt,
		source: "api",
	};
};

export const fetchClaudeUsage = async (
	args: ClaudeControlOptions,
): Promise<ProviderUsageLimits> => {
	if (!args.claudeExecutablePath)
		return unavailable("claude", "cli-unavailable");
	return withClaudeControlClient(args, async (client) => {
		let response: SDKControlGetUsageResponse;
		try {
			response =
				await client.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
					skipBehaviors: true,
				});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				/unknown (?:control )?(?:request|method)|unsupported|not supported|unrecognized/i.test(
					message,
				)
			) {
				return unavailable("claude", "unsupported-version");
			}
			if (/not logged in|not authenticated|login required/i.test(message))
				return unavailable("claude", "no-credentials");
			if (/token.*expired|session.*expired/i.test(message))
				return unavailable("claude", "expired");
			throw error;
		}
		if (!response || typeof response.rate_limits_available !== "boolean")
			return unavailable("claude", "invalid-response");
		if (!response.rate_limits_available || !response.rate_limits) {
			const account = await client.accountInfo();
			const hasToken = account.tokenSource && account.tokenSource !== "none";
			const hasKey = account.apiKeySource && account.apiKeySource !== "none";
			const external =
				account.apiProvider && account.apiProvider !== "firstParty";
			if (!hasToken && !hasKey && !external && args.credential === null)
				return unavailable("claude", "no-credentials");
			return unavailable(
				"claude",
				response.subscription_type ? "error" : "unsupported",
			);
		}
		const payload: ClaudePayload = {
			...response.rate_limits,
			subscriptionType: response.subscription_type ?? undefined,
		};
		const scoped = (response.rate_limits as { model_scoped?: unknown })
			.model_scoped;
		if (Array.isArray(scoped))
			payload.limits = scoped.flatMap((item) =>
				item && typeof item.display_name === "string"
					? [
							{
								kind: "weekly_scoped",
								group: "weekly",
								percent: item.utilization,
								resets_at: item.resets_at,
								scope: { model: { display_name: item.display_name } },
							},
						]
					: [],
			);
		return parseClaudeUsagePayload(payload);
	});
};
