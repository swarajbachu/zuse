import { readFile } from "node:fs/promises";
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

it.each([
	true,
	false,
	undefined,
])("builds recovery indexes concurrently and handles validity %s", async (validity) => {
	const query = vi.fn(async (sql: string) => ({
		rows:
			sql.startsWith("SELECT indisvalid") && validity !== undefined
				? [{ indisvalid: validity }]
				: [],
	}));
	await ensureBillingIndex({ query });
	const statements = query.mock.calls.map(([sql]) => sql);
	for (const index of [
		"api_provider_usage_events_resource_time_idx",
		"api_stripe_customer_recovery_pending_idx",
	]) {
		expect(statements).toContain(
			`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.${index}')`,
		);
		expect(statements.includes(`DROP INDEX CONCURRENTLY public.${index}`)).toBe(
			validity === false,
		);
		expect(
			statements.some((sql) =>
				sql.startsWith(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} `),
			),
		).toBe(true);
	}
	expect(statements).toContain(
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS api_stripe_customer_recovery_pending_idx ON public.api_stripe_customers (COALESCE(recovery_attempted_at, 0), account_id) WHERE customer_id IS NULL AND NOT recovery_complete",
	);
	expect(statements.some((sql) => /BEGIN|COMMIT/u.test(sql))).toBe(false);
});

it("releases the build lock if concurrent recovery index creation fails", async () => {
	const query = vi.fn(async (sql: string) => {
		if (
			sql.startsWith("CREATE INDEX") &&
			sql.includes("api_stripe_customer_recovery_pending_idx")
		)
			throw new Error("interrupted");
		return { rows: [] };
	});
	await expect(ensureBillingIndex({ query })).rejects.toThrow("interrupted");
	expect(query.mock.calls.at(-1)?.[0]).toBe(
		"SELECT pg_advisory_unlock(578, 24)",
	);
});

it("keeps recovery index builds out of the transactional migration", async () => {
	const migration = await readFile(
		new URL(
			"../../drizzle/migrations/0043_stripe_customer_recovery_jobs.sql",
			import.meta.url,
		),
		"utf8",
	);
	expect(migration).not.toMatch(/CREATE\s+INDEX/iu);
});
