import { expect, it, vi } from "vitest";
// @ts-expect-error migration scripts run directly as Node ESM
import { ensureBillingIndex } from "../../scripts/ensure-billing-index.mjs";

it("builds the ledger index outside a transaction and repairs interrupted builds", async () => {
	const query = vi.fn(async (sql: string) => ({
		rows: sql.startsWith("SELECT indisvalid") ? [{ indisvalid: false }] : [],
	}));
	await ensureBillingIndex({ query });
	const statements = query.mock.calls.map(([sql]) => sql);
	expect(statements.some((sql) => /BEGIN|COMMIT/u.test(sql))).toBe(false);
	expect(statements).toContain(
		"DROP INDEX CONCURRENTLY public.api_provider_usage_events_resource_time_idx",
	);
	expect(
		statements.some((sql) => sql.startsWith("CREATE INDEX CONCURRENTLY")),
	).toBe(true);
	expect(statements.at(-1)).toContain("pg_advisory_unlock");
});
