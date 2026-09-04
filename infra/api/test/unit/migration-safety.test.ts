import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

const journalUrl = new URL(
	"../../drizzle/migrations/meta/_journal.json",
	import.meta.url,
);
const reconciliationMigrationUrl = new URL(
	"../../drizzle/migrations/0003_managed_cloud_machines.sql",
	import.meta.url,
);
const credentialCleanupMigrationUrl = new URL(
	"../../drizzle/migrations/0004_credential_cleanup_handshake.sql",
	import.meta.url,
);
const cloudWorkspaceMigrationUrl = new URL(
	"../../drizzle/migrations/0005_thin_rawhide_kid.sql",
	import.meta.url,
);
const cloudChatEncryptionMigrationUrl = new URL(
	"../../drizzle/migrations/0006_cloud_chat_encryption.sql",
	import.meta.url,
);
const launchIntentCutoverMigrationUrl = new URL(
	"../../drizzle/migrations/0007_launch_intent_cutover.sql",
	import.meta.url,
);
const runtimeSummaryMigrationUrl = new URL(
	"../../drizzle/migrations/0008_runtime_summary_projection.sql",
	import.meta.url,
);
const transcriptCheckpointMigrationUrl = new URL(
	"../../drizzle/migrations/0009_cloud_transcript_checkpoints.sql",
	import.meta.url,
);
const cloudBillingMigrationUrl = new URL(
	"../../drizzle/migrations/0010_cloud_billing_ledger.sql",
	import.meta.url,
);
const machineOwnedAuthMigrationUrl = new URL(
	"../../drizzle/migrations/0011_machine_owned_auth.sql",
	import.meta.url,
);
const singleAccountImageMigrationUrl = new URL(
	"../../drizzle/migrations/0012_single_account_image.sql",
	import.meta.url,
);
const cloudProjectSelectionMigrationUrl = new URL(
	"../../drizzle/migrations/0014_cloud_project_selection.sql",
	import.meta.url,
);
const githubAppInstallationsMigrationUrl = new URL(
	"../../drizzle/migrations/0015_github_app_installations.sql",
	import.meta.url,
);
const apiNamingMigrationUrl = new URL(
	"../../drizzle/migrations/0016_api_naming.sql",
	import.meta.url,
);
const cloudCodexAuthBrokerMigrationUrl = new URL(
	"../../drizzle/migrations/0017_cloud_codex_auth_broker.sql",
	import.meta.url,
);

describe("api migration reconciliation", () => {
	test("keeps the main migration history before managed cloud machines", async () => {
		const journal = JSON.parse(await readFile(journalUrl, "utf8")) as {
			readonly entries: ReadonlyArray<{
				readonly idx: number;
				readonly tag: string;
			}>;
		};

		expect(journal.entries.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
			{ idx: 0, tag: "0000_material_the_captain" },
			{ idx: 1, tag: "0001_next_catseye" },
			{ idx: 2, tag: "0002_absurd_leader" },
			{ idx: 3, tag: "0003_managed_cloud_machines" },
			{ idx: 4, tag: "0004_credential_cleanup_handshake" },
			{ idx: 5, tag: "0005_thin_rawhide_kid" },
			{ idx: 6, tag: "0006_cloud_chat_encryption" },
			{ idx: 7, tag: "0007_launch_intent_cutover" },
			{ idx: 8, tag: "0008_runtime_summary_projection" },
			{ idx: 9, tag: "0009_cloud_transcript_checkpoints" },
			{ idx: 10, tag: "0010_cloud_billing_ledger" },
			{ idx: 11, tag: "0011_machine_owned_auth" },
			{ idx: 12, tag: "0012_single_account_image" },
			{ idx: 13, tag: "0013_cloud_image_build_details" },
			{ idx: 14, tag: "0014_cloud_project_selection" },
			{ idx: 15, tag: "0015_github_app_installations" },
			{ idx: 16, tag: "0016_api_naming" },
			{ idx: 17, tag: "0017_cloud_codex_auth_broker" },
			{ idx: 18, tag: "0018_cloud_active_session_summary" },
		]);
	});

	test("stores only authority location and fencing metadata", async () => {
		const migration = await readFile(cloudCodexAuthBrokerMigrationUrl, "utf8");
		expect(migration).toContain('CREATE TABLE "api_cloud_auth_authorities"');
		for (const column of [
			"provider_sandbox_id",
			"storage_incarnation_id",
			"auth_epoch",
			"toolchain_version",
			"provisioning_lease_owner",
		])
			expect(migration).toContain(`"${column}"`);
		expect(migration).not.toMatch(
			/access_token|refresh_token|auth_json|private_key/iu,
		);
	});

	test("renames all current Relay relations without dropping data", async () => {
		const migration = await readFile(apiNamingMigrationUrl, "utf8");
		expect(
			migration.match(/ALTER TABLE "relay_[^"]+" RENAME TO "api_[^"]+";/gu),
		).toHaveLength(33);
		expect(migration).toContain("c.relkind IN ('i', 'I', 'S')");
		expect(migration).toContain("RENAME CONSTRAINT");
		expect(migration).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/iu);
	});

	test("stores GitHub App installation metadata without access tokens", async () => {
		const migration = await readFile(
			githubAppInstallationsMigrationUrl,
			"utf8",
		);
		expect(migration).toContain(
			'CREATE TABLE "relay_cloud_github_installations"',
		);
		expect(migration).toContain('"installation_id" bigint NOT NULL');
		expect(migration).not.toMatch(/access_token|refresh_token|private_key/iu);
	});

	test("supports reversible account-image repository selection", async () => {
		const migration = await readFile(cloudProjectSelectionMigrationUrl, "utf8");
		expect(migration).toContain(
			'ADD COLUMN "included" boolean DEFAULT true NOT NULL',
		);
	});

	test("persists generation-fenced warm account-image sandboxes", async () => {
		const migration = await readFile(singleAccountImageMigrationUrl, "utf8");
		expect(migration).toContain('CREATE TABLE "relay_cloud_workspace_pool"');
		expect(migration).toContain('"image_generation" text NOT NULL');
		expect(migration).toContain("relay_cloud_pool_available_idx");
	});

	test("removes the imported credential table and workspace credential epoch", async () => {
		const migration = await readFile(machineOwnedAuthMigrationUrl, "utf8");
		expect(migration).toContain(
			'DROP TABLE IF EXISTS "relay_cloud_credential_connections"',
		);
		expect(migration).toContain('DROP COLUMN IF EXISTS "credential_epoch"');
	});

	test("adds immutable cloud billing evidence and financial ledgers", async () => {
		const migration = await readFile(cloudBillingMigrationUrl, "utf8");
		for (const table of [
			"relay_cloud_billing_periods",
			"relay_provider_price_schedule",
			"relay_provider_usage_events",
			"relay_provider_event_finalizations",
			"relay_provider_event_deliveries",
			"relay_cloud_billing_usage",
			"relay_cloud_billing_reservations",
			"relay_cloud_billing_ledger",
			"relay_cloud_billing_outbox",
			"relay_platform_costs",
			"relay_provider_statement_totals",
		])
			expect(migration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
		expect(migration).toContain("price_catalog_version");
		expect(migration).toContain("included_provider_cost_micros");
		expect(migration).toContain("idempotency_key");
	});

	test("adds encrypted transcript pointers and removes archive recovery state", async () => {
		const migration = await readFile(transcriptCheckpointMigrationUrl, "utf8");
		expect(migration).toContain(
			'CREATE TABLE "relay_cloud_transcript_checkpoints"',
		);
		expect(migration).toContain(
			'CREATE TABLE "relay_cloud_workspace_command_receipts"',
		);
		expect(migration).toContain('ADD COLUMN "wrapped_transcript_key" text');
		expect(migration).toContain('DROP COLUMN "recovery_bundle_key"');
		expect(migration).toContain('DROP COLUMN "warm_retention_deadline"');
		expect(migration).not.toContain("'recovering'");
	});

	test("stores only a metadata runtime summary projection", async () => {
		const migration = await readFile(runtimeSummaryMigrationUrl, "utf8");
		expect(migration).toContain(
			'CREATE TABLE "relay_cloud_workspace_runtime_summaries"',
		);
		for (const column of [
			"runtime_generation",
			"summary_revision",
			"title",
			"last_activity_at",
			"session_head_version",
		])
			expect(migration).toContain(`"${column}"`);
		for (const forbidden of ["message", "content", "queue", "terminal"])
			expect(migration.toLowerCase()).not.toContain(`"${forbidden}`);
	});

	test("cuts over to the sole encrypted one-shot launch intent", async () => {
		const migration = await readFile(launchIntentCutoverMigrationUrl, "utf8");
		expect(migration).toContain(
			'CREATE TABLE "relay_cloud_workspace_launch_intents"',
		);
		expect(migration).toContain('"turn_id" text NOT NULL');
		expect(migration).toContain('"command_id" text NOT NULL');
		expect(migration).toContain('"ciphertext" text NOT NULL');
		expect(
			[...migration.matchAll(/DROP TABLE "([^"]+)"/gu)].map(
				([, table]) => table,
			),
		).toEqual([
			"relay_cloud_workspace_events",
			"relay_cloud_workspace_commands",
			"relay_cloud_workspace_connection_grants",
		]);
		expect(
			[...migration.matchAll(/DROP COLUMN "([^"]+)"/gu)].map(
				([, column]) => column,
			),
		).toEqual(["chat_metadata_ciphertext"]);
	});

	test("moves chat content into nullable encrypted envelopes", async () => {
		const migration = await readFile(cloudChatEncryptionMigrationUrl, "utf8");
		expect(migration).toContain('"chat_metadata_ciphertext" text');
		expect(
			migration.match(/ADD COLUMN "encrypted_payload" text/gu),
		).toHaveLength(2);
		expect(migration).toContain(
			'"relay_cloud_workspace_commands" ALTER COLUMN "payload" DROP NOT NULL',
		);
		expect(migration).toContain(
			'"relay_cloud_workspace_events" ALTER COLUMN "payload_json" DROP NOT NULL',
		);
	});

	test("separates durable cloud control-plane resources from machine enrollment", async () => {
		const migration = await readFile(cloudWorkspaceMigrationUrl, "utf8");
		for (const table of [
			"relay_cloud_projects",
			"relay_cloud_project_builds",
			"relay_cloud_workspaces",
			"relay_cloud_credential_connections",
			"relay_cloud_workspace_connection_grants",
			"relay_cloud_workspace_commands",
			"relay_cloud_workspace_events",
			"relay_cloud_workspace_usage",
		])
			expect(migration).toContain(`CREATE TABLE "${table}"`);
		expect(migration).toContain("relay_cloud_workspaces_active_branch_idx");
		expect(migration).toContain("'cloud-workspace'");
		expect(migration).toContain('"runtime_boot_token_hash" text');
		expect(migration).not.toContain('"environment_id" text NOT NULL');
		expect(migration).not.toContain('"enrolled_environment_public_key"');
	});

	test("converges both existing staging and main databases idempotently", async () => {
		const migration = await readFile(reconciliationMigrationUrl, "utf8");

		expect(migration).toContain(
			'CREATE TABLE IF NOT EXISTS "relay_revoked_dpop_keys"',
		);
		expect(migration).toContain(
			'ADD COLUMN IF NOT EXISTS "runtime_version" text',
		);
		expect(migration).toContain('CREATE TABLE IF NOT EXISTS "relay_machines"');
		expect(migration).toContain(
			'ADD COLUMN IF NOT EXISTS "account_deletion_requested_at" bigint',
		);
		expect(migration).toContain(
			'ADD COLUMN IF NOT EXISTS "revision" bigint DEFAULT 0 NOT NULL',
		);
		expect(migration).toContain('ALTER COLUMN "entitlement_id" SET NOT NULL');
		expect(migration).toContain(
			'ADD COLUMN IF NOT EXISTS "private_http_base_url" text',
		);
		expect(migration).toContain("SELECT 1 FROM pg_constraint");
		expect(migration).toContain(
			'CREATE UNIQUE INDEX IF NOT EXISTS "relay_machines_account_idempotency_idx"',
		);
	});

	test("persists the final-snapshot credential cleanup handshake", async () => {
		const migration = await readFile(credentialCleanupMigrationUrl, "utf8");

		expect(migration).toContain('ADD COLUMN "boot_phase" text');
		expect(migration).toContain(
			'ADD COLUMN "credential_cleanup_requested_at" bigint',
		);
		expect(migration).toContain(
			'ADD COLUMN "credential_cleanup_completed_at" bigint',
		);
		expect(migration).toContain(
			'ADD COLUMN "final_snapshot_skipped" boolean DEFAULT false NOT NULL',
		);
	});
});
