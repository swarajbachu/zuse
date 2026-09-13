import pg from "pg";

const { Pool } = pg;
const [command, ...args] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const integer = (value, name) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error(`${name} must be an integer`);
	return parsed;
};

try {
	if (command === "import-platform-cost") {
		const [vendor, kind, amount, start, end, externalId] = args;
		if (
			[vendor, kind, amount, start, end, externalId].some(
				(value) => value === undefined,
			)
		)
			throw new Error(
				"usage: import-platform-cost VENDOR KIND AMOUNT_MICROS PERIOD_START_MS PERIOD_END_MS EXTERNAL_ID",
			);
		await pool.query(
			`INSERT INTO api_platform_costs (cost_id, vendor, kind, amount_micros, currency, external_id, period_start, period_end, metadata, created_at)
			 VALUES ($1,$2,$3,$4,'USD',$5,$6,$7,'{}', $8) ON CONFLICT (vendor, external_id) DO NOTHING`,
			[
				`platform:${vendor}:${externalId}`,
				vendor,
				kind,
				integer(amount, "amount"),
				externalId,
				integer(start, "start"),
				integer(end, "end"),
				Date.now(),
			],
		);
		console.log(JSON.stringify({ imported: true, vendor, externalId }));
	} else if (command === "import-provider-statement") {
		const [provider, amount, start, end, externalId] = args;
		if (
			[provider, amount, start, end, externalId].some(
				(value) => value === undefined,
			)
		)
			throw new Error(
				"usage: import-provider-statement PROVIDER AMOUNT_MICROS PERIOD_START_MS PERIOD_END_MS EXTERNAL_ID",
			);
		await pool.query(
			`INSERT INTO api_provider_statement_totals (statement_id, provider, external_id, amount_micros, currency, period_start, period_end, metadata, created_at)
			 VALUES ($1,$2,$3,$4,'USD',$5,$6,'{}',$7) ON CONFLICT (provider, external_id) DO NOTHING`,
			[
				`statement:${provider}:${externalId}`,
				provider,
				externalId,
				integer(amount, "amount"),
				integer(start, "start"),
				integer(end, "end"),
				Date.now(),
			],
		);
		console.log(JSON.stringify({ imported: true, provider, externalId }));
	} else if (command === "report") {
		const periodId = args[0];
		if (periodId === undefined) throw new Error("usage: report PERIOD_ID");
		const result = await pool.query(
			`SELECT p.period_id, p.account_id, p.period_start, p.period_end, p.base_price_micros,
			 COALESCE((SELECT SUM(amount_micros) FROM api_cloud_billing_ledger WHERE period_id=p.period_id AND kind='provider-cost'),0) AS account_provider_cost_micros,
			 COALESCE((SELECT SUM(l.amount_micros) FROM api_cloud_billing_ledger l JOIN api_cloud_billing_periods statement_period ON statement_period.period_id=l.period_id WHERE l.kind='provider-cost' AND statement_period.period_start=p.period_start AND statement_period.period_end=p.period_end),0) AS calculated_statement_scope_micros,
			 COALESCE((SELECT SUM(cycle_period.base_price_micros) FROM api_cloud_billing_periods cycle_period WHERE cycle_period.period_start=p.period_start AND cycle_period.period_end=p.period_end),0) AS cycle_base_revenue_micros,
			 COALESCE((SELECT SUM(l.amount_micros) FROM api_cloud_billing_ledger l JOIN api_cloud_billing_periods cycle_period ON cycle_period.period_id=l.period_id WHERE l.kind='overage-charge' AND cycle_period.period_start=p.period_start AND cycle_period.period_end=p.period_end),0) AS cycle_overage_revenue_micros,
			 COALESCE((SELECT SUM(amount_micros) FROM api_cloud_billing_ledger WHERE period_id=p.period_id AND kind='included-allowance'),0) AS included_used_micros,
			 COALESCE((SELECT SUM(amount_micros) FROM api_cloud_billing_ledger WHERE period_id=p.period_id AND kind='overage-charge'),0) AS internal_overage_micros,
			 COALESCE((SELECT SUM(amount_cents) FROM api_cloud_billing_outbox WHERE period_id=p.period_id),0) AS polar_meter_cents,
			 COALESCE((SELECT SUM(amount_cents) FROM api_cloud_billing_outbox WHERE period_id=p.period_id AND acknowledged_at IS NOT NULL),0) AS polar_acknowledged_cents,
			 (SELECT SUM(amount_micros) FROM api_provider_statement_totals WHERE provider='e2b' AND period_start=p.period_start AND period_end=p.period_end) AS e2b_statement_micros,
			 COALESCE((SELECT SUM(amount_micros) FROM api_platform_costs WHERE period_start < p.period_end AND period_end > p.period_start),0) AS platform_overhead_micros,
			 COALESCE((SELECT SUM(amount_micros) FROM api_platform_costs WHERE vendor='polar' AND period_start < p.period_end AND period_end > p.period_start),0) AS polar_fees_micros
			 FROM api_cloud_billing_periods p WHERE p.period_id=$1`,
			[periodId],
		);
		if (result.rows[0] === undefined)
			throw new Error("billing period not found");
		const row = result.rows[0];
		const accountProviderCost = Number(row.account_provider_cost_micros);
		const calculatedStatementScope = Number(
			row.calculated_statement_scope_micros,
		);
		const statement =
			row.e2b_statement_micros === null
				? null
				: Number(row.e2b_statement_micros);
		const variance =
			statement === null ? null : calculatedStatementScope - statement;
		const internalOverage = Number(row.internal_overage_micros);
		const baseRevenue = Number(row.base_price_micros);
		const cycleBaseRevenue = Number(row.cycle_base_revenue_micros);
		const cycleOverageRevenue = Number(row.cycle_overage_revenue_micros);
		const platformOverhead = Number(row.platform_overhead_micros);
		console.log(
			JSON.stringify(
				{
					...row,
					account_gross_revenue_micros: baseRevenue + internalOverage,
					account_contribution_before_shared_overhead_micros:
						baseRevenue + internalOverage - accountProviderCost,
					cycle_gross_revenue_micros: cycleBaseRevenue + cycleOverageRevenue,
					cycle_net_contribution_micros:
						cycleBaseRevenue +
						cycleOverageRevenue -
						calculatedStatementScope -
						platformOverhead,
					provider_statement_variance_micros: variance,
					provider_statement_variance_alert:
						variance !== null &&
						statement !== null &&
						(Math.abs(variance) > Math.abs(statement) * 0.01 ||
							Math.abs(variance) > 1_000_000),
				},
				null,
				2,
			),
		);
	} else {
		throw new Error(
			"commands: report, import-platform-cost, import-provider-statement",
		);
	}
} finally {
	await pool.end();
}
