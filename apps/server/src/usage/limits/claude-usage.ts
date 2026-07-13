import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
	extra_usage?: { balance?: number; credits_remaining?: number };
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
		if (raw === null || typeof raw !== "object") continue;
		const item = raw as ClaudeWindow;
		if (key === "five_hour")
			windows.push({
				id: key,
				label: "Session",
				scope: "session",
				usedPercent: normalizePercent(item.utilization),
				resetsAt: normalizeReset(item.resets_at),
				windowMinutes: 300,
			});
		else if (key === "seven_day")
			windows.push({
				id: key,
				label: "Weekly",
				scope: "weekly",
				usedPercent: normalizePercent(item.utilization),
				resetsAt: normalizeReset(item.resets_at),
				windowMinutes: 10_080,
			});
		else if (key.startsWith("seven_day_")) {
			const model = title(key.slice(10));
			windows.push({
				id: key,
				label: `${model} only`,
				scope: "model",
				usedPercent: normalizePercent(item.utilization),
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

export type ClaudeCredentialResult =
	| { token: string; reason?: never }
	| { token?: never; reason: "no-credentials" | "expired" | "scope-missing" };

type ClaudeCredentialBlob = {
	claudeAiOauth?: {
		accessToken?: string;
		expiresAt?: number;
		scopes?: string[];
	};
};

const credentialFromBlob = (raw: string): ClaudeCredentialResult => {
	const oauth = (JSON.parse(raw) as ClaudeCredentialBlob).claudeAiOauth;
	if (!oauth?.accessToken) return { reason: "no-credentials" };
	if (oauth.expiresAt && oauth.expiresAt < Date.now())
		return { reason: "expired" };
	if (oauth.scopes && !oauth.scopes.includes("user:profile"))
		return { reason: "scope-missing" };
	return { token: oauth.accessToken };
};

export const readClaudeAccessToken =
	async (): Promise<ClaudeCredentialResult> => {
		try {
			return credentialFromBlob(
				await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8"),
			);
		} catch {
			if (process.platform !== "darwin") return { reason: "no-credentials" };
			try {
				const { stdout } = await promisify(execFile)(
					"/usr/bin/security",
					["find-generic-password", "-s", "Claude Code-credentials", "-w"],
					{ timeout: 3_000, maxBuffer: 1_000_000 },
				);
				return credentialFromBlob(stdout.trim());
			} catch {
				return { reason: "no-credentials" };
			}
		}
	};

export const fetchClaudeUsage = async (): Promise<ProviderUsageLimits> => {
	const credential = await readClaudeAccessToken();
	if (!("token" in credential)) return unavailable("claude", credential.reason);
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${credential.token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok)
			return unavailable(
				"claude",
				response.status === 401
					? "expired"
					: response.status === 403
						? "scope-missing"
						: "error",
			);
		return parseClaudeUsagePayload((await response.json()) as ClaudePayload);
	} catch {
		return unavailable("claude", "error");
	}
};
