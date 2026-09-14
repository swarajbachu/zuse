// Runs after transactional Drizzle migrations, using a dedicated autocommit
// connection. Never run this function inside BEGIN/COMMIT.
export async function ensureBillingIndex(client) {
	await client.query("SET lock_timeout = '5s'");
	await client.query("SET statement_timeout = '10min'");
	await client.query("SELECT pg_advisory_lock(578, 24)");
	try {
		const result = await client.query(
			"SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.api_provider_usage_events_resource_time_idx')",
		);
		// Interrupted concurrent builds leave invalid indexes. Drop and retry.
		if (result.rows[0]?.indisvalid === false)
			await client.query(
				"DROP INDEX CONCURRENTLY public.api_provider_usage_events_resource_time_idx",
			);
		await client.query(
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS api_provider_usage_events_resource_time_idx ON public.api_provider_usage_events (provider, provider_resource_id, type, occurred_at)",
		);
	} finally {
		await client.query("SELECT pg_advisory_unlock(578, 24)");
	}
}
