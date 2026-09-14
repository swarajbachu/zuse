import type { AccountProfile, QuotaResult } from "./contracts.ts";

const object = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const percent = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v)
		? Math.max(0, Math.min(100, v))
		: null;
const reset = (v: unknown) => {
	const date =
		typeof v === "number"
			? new Date(v * 1000)
			: typeof v === "string"
				? new Date(v)
				: null;
	return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export interface QuotaSource {
	request(credential: unknown): {
		url: string;
		headers: Record<string, string>;
	};
	parse(payload: unknown): Pick<QuotaResult, "windows" | "plan">;
}
/** Add another account provider here. Collection belongs entirely to this extension. */
export const sources: Record<AccountProfile["provider"], QuotaSource> = {
	codex: {
		request(raw) {
			const tokens = object(object(raw).tokens);
			if (
				typeof tokens.access_token !== "string" ||
				!tokens.access_token ||
				typeof tokens.account_id !== "string" ||
				!tokens.account_id
			)
				throw new Error(
					"This profile needs a Codex ChatGPT login with access_token and account_id. API keys do not expose subscription quota.",
				);
			return {
				url: "https://chatgpt.com/backend-api/wham/usage",
				headers: {
					Authorization: `Bearer ${tokens.access_token}`,
					"ChatGPT-Account-Id": tokens.account_id,
				},
			};
		},
		parse(raw) {
			const p = object(raw);
			const rate = object(p.rate_limit);
			const windows: QuotaResult["windows"][number][] = [];
			for (const [id, label] of [
				["primary_window", "Session"],
				["secondary_window", "Weekly"],
			]) {
				const w = object(rate[id]);
				if (Object.keys(w).length)
					windows.push({
						id,
						label,
						usedPercent: percent(w.used_percent),
						resetsAt: reset(w.reset_at),
					});
			}
			return {
				windows,
				plan: typeof p.plan_type === "string" ? p.plan_type : null,
			};
		},
	},
	claude: {
		request(raw) {
			const oauth = object(object(raw).claudeAiOauth);
			if (typeof oauth.accessToken !== "string" || !oauth.accessToken)
				throw new Error(
					"This profile needs Claude OAuth credentials with claudeAiOauth.accessToken.",
				);
			if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now())
				throw new Error(
					"Login expired. Reauthenticate this profile with Claude, then refresh.",
				);
			return {
				url: "https://api.anthropic.com/api/oauth/usage",
				headers: {
					Authorization: `Bearer ${oauth.accessToken}`,
					"anthropic-beta": "oauth-2025-04-20",
				},
			};
		},
		parse(raw) {
			const p = object(raw);
			const windows: QuotaResult["windows"][number][] = [];
			for (const [id, value] of Object.entries(p)) {
				if (
					id !== "five_hour" &&
					id !== "seven_day" &&
					!id.startsWith("seven_day_")
				)
					continue;
				const w = object(value);
				if (!Object.keys(w).length) continue;
				windows.push({
					id,
					label:
						id === "five_hour"
							? "Session"
							: id === "seven_day"
								? "Weekly"
								: id.slice(10).replaceAll("_", " "),
					usedPercent: percent(w.utilization),
					resetsAt: reset(w.resets_at),
				});
			}
			return {
				windows,
				plan: typeof p.rate_limit_tier === "string" ? p.rate_limit_tier : null,
			};
		},
	},
};
export async function fetchQuota(
	provider: AccountProfile["provider"],
	credential: unknown,
	signal: AbortSignal,
	request: typeof fetch = fetch,
) {
	const source = sources[provider];
	const config = source.request(credential);
	const response = await request(config.url, {
		headers: config.headers,
		signal,
		redirect: "error",
	}).catch(() => {
		throw new Error("Quota connection failed or timed out.");
	});
	if (!response.ok)
		throw new Error(
			response.status === 401
				? "Login expired. Reauthenticate this profile and refresh."
				: response.status === 403
					? "Quota access denied for this account or token scope."
					: response.status === 429
						? "Provider rate limited quota requests. Wait before refreshing."
						: `Quota request failed (HTTP ${response.status}).`,
		);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Provider returned an empty response.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 262144) throw new Error("Provider response exceeds 256 KiB.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new Error("Provider returned malformed quota data.");
	}
	const parsed = source.parse(payload);
	if (parsed.windows.length === 0)
		throw new Error(
			"Provider returned no supported quota windows. Its response format may have changed.",
		);
	return parsed;
}
