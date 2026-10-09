import { ProviderId, UsageLimitWindow } from "@zuse/contracts";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ProviderAccounts } from "../../provider/services/provider-accounts.ts";
import { type SessionUsageWindow, usageWindowKey } from "./merge.ts";

export const parseSessionUsageWindow = (
	raw: string,
	createdAt: string,
): SessionUsageWindow | null => {
	try {
		if (!Number.isFinite(Date.parse(createdAt))) return null;
		const value = JSON.parse(raw) as UsageLimitWindow & {
			providerId?: ProviderId;
		};
		const providerId = Schema.decodeUnknownSync(ProviderId)(value.providerId);
		const legacyModel =
			providerId === "claude" && typeof value.label === "string"
				? /^Weekly limit \((.+)\)$/.exec(value.label)?.[1]
				: undefined;
		const scope =
			value.scope ??
			(legacyModel
				? "model"
				: value.windowMinutes && value.windowMinutes <= 1440
					? "session"
					: "weekly");
		const label = legacyModel ? `${legacyModel} only` : value.label;
		const window = Schema.decodeUnknownSync(UsageLimitWindow)({
			id: value.id ?? `${providerId}:${scope}:${label}`,
			label,
			scope,
			usedPercent: value.usedPercent,
			resetsAt: value.resetsAt,
			windowMinutes: value.windowMinutes,
		});
		return { providerId, createdAt, window };
	} catch {
		return null;
	}
};

export const loadSessionUsageWindows = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const accounts = yield* Effect.serviceOption(ProviderAccounts);
	const rows = yield* Option.isSome(accounts)
		? sql<{
				content_json: string;
				created_at: string;
			}>`WITH limits AS (
 SELECT content_json,created_at,session_id,
 CASE WHEN json_valid(content_json) THEN json_extract(content_json,'$.providerId') END AS event_provider
 FROM messages WHERE kind='usage_limit'
) SELECT m.content_json,m.created_at FROM limits m
LEFT JOIN session_provider_accounts a ON a.session_id=m.session_id AND a.provider_id=m.event_provider
WHERE m.event_provider NOT IN ('claude','codex')
 OR COALESCE(a.account_id,'')=COALESCE((SELECT id FROM provider_accounts WHERE provider_id=m.event_provider AND preferred=1),'')
ORDER BY m.created_at DESC LIMIT 200`
		: sql<{
				content_json: string;
				created_at: string;
			}>`SELECT content_json, created_at FROM messages WHERE kind = 'usage_limit' ORDER BY created_at DESC LIMIT 200`;
	const seen = new Set<string>();
	const results: SessionUsageWindow[] = [];
	for (const row of rows) {
		const event = parseSessionUsageWindow(row.content_json, row.created_at);
		if (!event) continue;
		const key = `${event.providerId}:${usageWindowKey(event.window)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		results.push(event);
	}
	return results;
});
