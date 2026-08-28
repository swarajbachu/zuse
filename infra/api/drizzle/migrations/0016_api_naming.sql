ALTER TABLE "relay_link_challenges" RENAME TO "api_link_challenges";
ALTER TABLE "relay_environments" RENAME TO "api_environments";
ALTER TABLE "relay_environment_credentials" RENAME TO "api_environment_credentials";
ALTER TABLE "relay_devices" RENAME TO "api_devices";
ALTER TABLE "relay_revoked_dpop_keys" RENAME TO "api_revoked_dpop_keys";
ALTER TABLE "relay_dpop_proofs" RENAME TO "api_dpop_proofs";
ALTER TABLE "relay_machines" RENAME TO "api_machines";
ALTER TABLE "relay_entitlements" RENAME TO "api_entitlements";
ALTER TABLE "relay_cloud_projects" RENAME TO "api_cloud_projects";
ALTER TABLE "relay_cloud_github_installations" RENAME TO "api_cloud_github_installations";
ALTER TABLE "relay_cloud_project_builds" RENAME TO "api_cloud_project_builds";
ALTER TABLE "relay_cloud_workspace_pool" RENAME TO "api_cloud_workspace_pool";
ALTER TABLE "relay_cloud_workspaces" RENAME TO "api_cloud_workspaces";
ALTER TABLE "relay_cloud_workspace_command_receipts" RENAME TO "api_cloud_workspace_command_receipts";
ALTER TABLE "relay_cloud_workspace_launch_intents" RENAME TO "api_cloud_workspace_launch_intents";
ALTER TABLE "relay_cloud_workspace_runtime_summaries" RENAME TO "api_cloud_workspace_runtime_summaries";
ALTER TABLE "relay_cloud_transcript_checkpoints" RENAME TO "api_cloud_transcript_checkpoints";
ALTER TABLE "relay_cloud_workspace_usage" RENAME TO "api_cloud_workspace_usage";
ALTER TABLE "relay_cloud_billing_periods" RENAME TO "api_cloud_billing_periods";
ALTER TABLE "relay_provider_price_schedule" RENAME TO "api_provider_price_schedule";
ALTER TABLE "relay_provider_usage_events" RENAME TO "api_provider_usage_events";
ALTER TABLE "relay_provider_event_finalizations" RENAME TO "api_provider_event_finalizations";
ALTER TABLE "relay_provider_event_deliveries" RENAME TO "api_provider_event_deliveries";
ALTER TABLE "relay_cloud_billing_usage" RENAME TO "api_cloud_billing_usage";
ALTER TABLE "relay_cloud_billing_reservations" RENAME TO "api_cloud_billing_reservations";
ALTER TABLE "relay_cloud_billing_ledger" RENAME TO "api_cloud_billing_ledger";
ALTER TABLE "relay_cloud_billing_cap_commands" RENAME TO "api_cloud_billing_cap_commands";
ALTER TABLE "relay_cloud_billing_outbox" RENAME TO "api_cloud_billing_outbox";
ALTER TABLE "relay_cloud_billing_meter_reconciliations" RENAME TO "api_cloud_billing_meter_reconciliations";
ALTER TABLE "relay_platform_costs" RENAME TO "api_platform_costs";
ALTER TABLE "relay_provider_statement_totals" RENAME TO "api_provider_statement_totals";
ALTER TABLE "relay_billing_events" RENAME TO "api_billing_events";
ALTER TABLE "relay_agent_activity" RENAME TO "api_agent_activity";

DO $$
DECLARE
	relation record;
BEGIN
	FOR relation IN
		SELECT n.nspname AS schema_name, c.relname AS relation_name
		FROM pg_class AS c
		JOIN pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
			AND c.relkind IN ('i', 'I', 'S')
			AND c.relname LIKE 'relay\_%' ESCAPE '\'
	LOOP
		EXECUTE format(
			'ALTER %s %I.%I RENAME TO %I',
			CASE WHEN relation.relation_name IN (
				SELECT sequence_name
				FROM information_schema.sequences
				WHERE sequence_schema = relation.schema_name
			) THEN 'SEQUENCE' ELSE 'INDEX' END,
			relation.schema_name,
			relation.relation_name,
			regexp_replace(relation.relation_name, '^relay_', 'api_')
		);
	END LOOP;
END $$;

DO $$
DECLARE
	constraint_record record;
BEGIN
	FOR constraint_record IN
		SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname
		FROM pg_constraint AS c
		JOIN pg_class AS t ON t.oid = c.conrelid
		JOIN pg_namespace AS n ON n.oid = t.relnamespace
		WHERE n.nspname = current_schema()
			AND c.conname LIKE 'relay\_%' ESCAPE '\'
	LOOP
		EXECUTE format(
			'ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',
			constraint_record.schema_name,
			constraint_record.table_name,
			constraint_record.conname,
			regexp_replace(constraint_record.conname, '^relay_', 'api_')
		);
	END LOOP;
END $$;
