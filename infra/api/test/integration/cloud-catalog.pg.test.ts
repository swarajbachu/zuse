import { readdirSync, readFileSync } from "node:fs";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStorePg,
} from "../../src/cloud-workspace-store";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"catalog changes commit atomically, resume and isolate accounts",
	async () => {
		const schema = `catalog_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
			max: 3,
		});
		const db = PgClient.layerFrom(
			PgClient.fromPool({ acquire: Effect.succeed(pool) }),
		);
		const runtime = ManagedRuntime.make(
			CloudWorkspaceStorePg.pipe(Layer.provideMerge(db)),
		);
		try {
			const migrationDir = new URL(
				"../../drizzle/migrations/",
				import.meta.url,
			);
			for (const name of readdirSync(migrationDir)
				.filter((name) => name.endsWith(".sql"))
				.sort()) {
				for (const statement of readFileSync(
					new URL(name, migrationDir),
					"utf8",
				).split("--> statement-breakpoint"))
					await pool.query(
						statement
							.replaceAll('"public".', `"${schema}".`)
							.replaceAll("public.", `${schema}.`),
					);
			}
			await pool.query(
				`INSERT INTO api_cloud_projects (project_id,account_id,repository_identity,repository_url,display_name,default_branch,visibility,git_connection_kind,configuration_digest,state,idempotency_key,created_at,updated_at) VALUES ('p','a','repo','https://example.test/repo','Repo','main','private','github-app','digest','ready','p',1,1)`,
			);
			await pool.query(
				`INSERT INTO api_cloud_project_builds (build_id,project_id,account_id,provider,template_version,configuration_digest,state,idempotency_key,next_action_at,created_at,updated_at) VALUES ('b','p','a','box','1','digest','ready','b',1,1,1)`,
			);
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const read = (cursor?: number, account = "a") =>
				runtime.runPromise(store.readCloudCatalog(account, cursor));
			expect(await read()).toMatchObject({
				reset: true,
				cursor: 0,
				entries: [],
			});
			const tx = await pool.connect();
			await tx.query("BEGIN");
			await tx.query(
				`INSERT INTO api_cloud_workspaces (workspace_id,account_id,project_id,build_id,provider,chat_id,initial_session_id,branch,base_ref,state,desired_state,status_code,idempotency_key,next_action_at,created_at,updated_at,last_activity_at) VALUES ('w','a','p','b','box','chat','session','branch','main','ready','ready','ready','w',1,1,1,1)`,
			);
			expect((await read(0)).entries).toHaveLength(0);
			await tx.query("COMMIT");
			tx.release();
			const created = await read(0);
			expect(
				created.entries.map((entry) => entry.workspace.workspaceId),
			).toEqual(["w"]);
			expect((await read(created.cursor)).entries).toEqual([]);
			expect((await read(undefined, "another-account")).entries).toEqual([]);
			await pool.query(
				"UPDATE api_cloud_projects SET display_name='Updated' WHERE project_id='p'",
			);
			const renamed = await read(created.cursor);
			expect(renamed.entries[0]?.project.displayName).toBe("Updated");
			const rollback = await pool.connect();
			await rollback.query("BEGIN");
			await rollback.query(
				"UPDATE api_cloud_workspaces SET state='paused' WHERE workspace_id='w'",
			);
			await rollback.query("ROLLBACK");
			rollback.release();
			expect((await read(renamed.cursor)).entries).toEqual([]);
			await pool.query(
				"DELETE FROM api_cloud_workspaces WHERE workspace_id='w'",
			);
			const deleted = await read(renamed.cursor);
			expect(deleted.deletedWorkspaceIds).toEqual(["w"]);
			expect((await read(deleted.cursor + 10)).reset).toBe(true);
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
	30_000,
);
