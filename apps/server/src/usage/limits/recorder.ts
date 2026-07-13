import type { ProviderUsageLimits } from "@zuse/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const recordLimitSnapshots = (
	providers: readonly ProviderUsageLimits[],
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const now = new Date();
		const hour = `${now.toISOString().slice(0, 13)}:00:00.000Z`;
		for (const provider of providers)
			for (const item of provider.windows)
				yield* sql`
    INSERT INTO usage_limit_snapshots(provider_id, account_key, window_id, captured_hour, used_percent, resets_at, window_minutes, source, updated_at)
    VALUES (${provider.providerId}, '', ${item.id}, ${hour}, ${item.usedPercent}, ${item.resetsAt}, ${item.windowMinutes}, ${provider.source}, ${now.toISOString()})
    ON CONFLICT(provider_id, account_key, window_id, captured_hour) DO UPDATE SET
				used_percent = CASE
					WHEN excluded.used_percent IS NULL THEN usage_limit_snapshots.used_percent
					WHEN usage_limit_snapshots.used_percent IS NULL THEN excluded.used_percent
					ELSE MAX(usage_limit_snapshots.used_percent, excluded.used_percent)
				END, resets_at = excluded.resets_at,
      window_minutes = excluded.window_minutes, source = excluded.source, updated_at = excluded.updated_at`;
	});
