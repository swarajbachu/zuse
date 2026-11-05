import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { expect, it } from "vitest";
import {
	AutomationMailboxStore,
	type AutomationRegistration,
} from "../../src/automation-mailbox.ts";
import { testCipher } from "../slack/test-support.ts";
import { automationNamespaceFixture } from "../support/automation-object.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
	"imports legacy Postgres definitions once and retains hook tokens and schedule cursors in the Durable Object",
	async () => {
		const db = new Client({ connectionString });
		await db.connect();
		const schema = `automation_${crypto.randomUUID().replaceAll("-", "")}`;
		try {
			await db.query(`CREATE SCHEMA ${schema}`);
			await db.query(`SET search_path=${schema}`);
			await db.query(
				"CREATE TABLE api_cloud_workspaces (workspace_id text PRIMARY KEY, account_id text, state text)",
			);
			await db.query(
				"INSERT INTO api_cloud_workspaces VALUES ('workspace','owner','ready')",
			);
			await db.query(
				await readFile(
					new URL(
						"../../drizzle/migrations/0048_automation_event_mailbox.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			const durable = automationNamespaceFixture(
				Date.parse("2026-10-04T12:00:00Z"),
			);
			const store = new AutomationMailboxStore(
				{
					query: async (query, values) => {
						const result = await db.query(query, values ? [...values] : []);
						return result.rows;
					},
				},
				testCipher,
				durable.namespace,
			);
			const definition: AutomationRegistration = {
				id: "rule",
				revision: 1,
				enabled: true,
				nextRunAt: "2026-10-04T12:00:00Z",
				triggers: [
					{ _tag: "webhook" },
					{ _tag: "schedule", cron: "0 * * * *", timezone: "UTC" },
				],
			};
			const token = "a".repeat(64);
			await db.query(
				"INSERT INTO api_automation_registrations (workspace_id,account_id,automation_id,revision,enabled,sealed,webhook_token_sealed,next_run_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
				[
					"workspace",
					"owner",
					"rule",
					1,
					true,
					await testCipher.seal(
						"automation-registration:workspace:rule",
						JSON.stringify(definition),
					),
					await testCipher.seal(
						"automation-registration:workspace:rule:hook",
						token,
					),
					Date.parse("2026-10-04T12:00:00Z"),
				],
			);
			expect(await store.migrateLegacyOwners()).toEqual({
				accountIds: ["owner"],
				next: "owner",
			});
			const first = await store.register("owner", "workspace", [definition]);
			expect(first[0]?.token).toBe(token);
			expect(first).toHaveLength(1);
			expect(first[0]?.token).toMatch(/^[a-f0-9]{64}$/u);
			await durable.object("owner").core.alarm();
			const repeated = await store.register("owner", "workspace", [definition]);
			expect(repeated).toEqual(first);
			await durable.object("owner").core.alarm();
			expect(await store.pending("workspace")).toHaveLength(1);
			await store.register("owner", "workspace", [
				{ ...definition, revision: 2, enabled: false },
			]);
			expect(await store.pending("workspace")).toEqual([]);
			await store.register("owner", "workspace", []);
			expect(
				(await db.query("SELECT * FROM api_automation_registrations")).rows,
			).toHaveLength(1);
			expect(
				(await db.query("SELECT * FROM api_automation_events")).rows,
			).toEqual([]);
		} finally {
			await db.query(`DROP SCHEMA ${schema} CASCADE`);
			await db.end();
		}
	},
);
