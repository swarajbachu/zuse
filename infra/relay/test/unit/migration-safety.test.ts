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

describe("relay migration reconciliation", () => {
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
		]);
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
