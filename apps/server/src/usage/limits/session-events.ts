import type { ProviderId, UsageLimitWindow } from "@zuse/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { type SessionUsageWindow, usageWindowKey } from "./merge.ts";

export const loadSessionUsageWindows = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{
		content_json: string;
		created_at: string;
	}>`SELECT content_json, created_at FROM messages WHERE kind = 'usage_limit' ORDER BY created_at DESC LIMIT 200`;
	const seen = new Set<string>();
	const results: SessionUsageWindow[] = [];
	for (const row of rows) {
		try {
			const value = JSON.parse(row.content_json) as UsageLimitWindow & {
				providerId?: ProviderId;
				_tag?: string;
			};
			if (!value.providerId) continue;
			const window: UsageLimitWindow = {
				id: value.id,
				label: value.label,
				scope:
					value.scope ??
					(value.windowMinutes && value.windowMinutes <= 1_440
						? "session"
						: "weekly"),
				usedPercent: value.usedPercent,
				resetsAt: value.resetsAt,
				windowMinutes: value.windowMinutes,
			};
			const key = `${value.providerId}:${usageWindowKey(window)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			results.push({
				providerId: value.providerId,
				createdAt: row.created_at,
				window: { ...window, id: window.id ?? key },
			});
		} catch {
			/* Historical malformed rows are ignored. */
		}
	}
	return results;
});
