import type { ProviderId, UsageLimitWindow } from "@zuse/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

import type { SessionUsageWindow } from "./merge.ts";

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
			const key = `${value.providerId}:${value.windowMinutes === null ? value.label : value.windowMinutes}`;
			if (seen.has(key)) continue;
			seen.add(key);
			results.push({
				providerId: value.providerId,
				createdAt: row.created_at,
				window: {
					id: value.id ?? key,
					label: value.label,
					scope:
						value.scope ??
						(value.windowMinutes && value.windowMinutes <= 1_440
							? "session"
							: "weekly"),
					usedPercent: value.usedPercent,
					resetsAt: value.resetsAt,
					windowMinutes: value.windowMinutes,
				},
			});
		} catch {
			/* Historical malformed rows are ignored. */
		}
	}
	return results;
});
