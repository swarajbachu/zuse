import { ProviderId, UsageLimitWindow } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
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
	const rows = yield* sql<{
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
