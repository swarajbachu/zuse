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
test.skipIf(!url).each(["a", "organization:org_a"])(
	"catalog and runtime credentials commit atomically and isolate owner %s",
	async (ownerId) => {
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
				`INSERT INTO api_cloud_projects (project_id,account_id,repository_identity,repository_url,display_name,default_branch,visibility,git_connection_kind,configuration_digest,state,idempotency_key,created_at,updated_at) VALUES ('p',$1,'repo','https://example.test/repo','Repo','main','private','github-app','digest','ready','p',1,1)`,
				[ownerId],
			);
			await pool.query(
				`INSERT INTO api_cloud_project_builds (build_id,project_id,account_id,provider,template_version,configuration_digest,state,idempotency_key,next_action_at,created_at,updated_at) VALUES ('b','p',$1,'box','1','digest','ready','b',1,1,1)`,
				[ownerId],
			);
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const imported = {
				buildId: "imported",
				projectId: null,
				accountId: ownerId,
				provider: "boxd",
				templateVersion: "1:connection:key",
				configurationDigest: "snapshot",
				settings: { source: "custom-snapshot", providerConnectionId: "key" },
				state: "queued" as const,
				idempotencyKey: "same-request",
				nextActionAtMs: 1,
				revision: 0,
				createdAtMs: 1,
				updatedAtMs: 1,
			};
			const first = await runtime.runPromise(store.createBuild(imported));
			const retry = await runtime.runPromise(
				store.createBuild({ ...imported, buildId: "retry" }),
			);
			expect(first.projectId).toBeNull();
			expect(retry.buildId).toBe(first.buildId);
			const other = await runtime.runPromise(
				store.createBuild({
					...imported,
					buildId: "other",
					accountId: "other-owner",
				}),
			);
			expect(other.buildId).toBe("other");

			expect(
				await runtime.runPromise(store.getWorkspaceSettings(ownerId)),
			).toEqual({ revision: 0, values: {} });
			const settingsWrites = await Promise.all(
				["first", "second"].map((branchNamingPrefix) =>
					runtime.runPromise(
						store.replaceWorkspaceSettings(ownerId, {
							expectedRevision: 0,
							values: { branchNamingPrefix },
						}),
					),
				),
			);
			expect(settingsWrites.filter((result) => result !== null)).toHaveLength(
				1,
			);
			expect(
				await runtime.runPromise(store.getWorkspaceSettings("unrelated-owner")),
			).toEqual({ revision: 0, values: {} });
			expect(
				await runtime.runPromise(
					store.replaceWorkspaceSettings(ownerId, {
						expectedRevision: 0,
						values: {},
					}),
				),
			).toBeNull();
			expect(
				await runtime.runPromise(
					store.replaceWorkspaceSettings(ownerId, {
						expectedRevision: 1,
						values: {},
					}),
				),
			).toEqual({ revision: 2, values: {} });
			const read = (cursor?: number, account = ownerId) =>
				runtime.runPromise(store.readCloudCatalog(account, cursor));
			expect(await read()).toMatchObject({
				reset: true,
				cursor: 0,
				entries: [],
			});
			const tx = await pool.connect();
			await tx.query("BEGIN");
			await tx.query(
				`INSERT INTO api_cloud_workspaces (workspace_id,account_id,project_id,build_id,provider,chat_id,initial_session_id,branch,base_ref,state,desired_state,status_code,idempotency_key,next_action_at,created_at,updated_at,last_activity_at) VALUES ('w',$1,'p','b','box','chat','session','branch','main','ready','ready','ready','w',1,1,1,1)`,
				[ownerId],
			);
			expect((await read(0)).entries).toHaveLength(0);
			await tx.query("COMMIT");
			tx.release();
			const access = [
				{
					providerId: "codex" as const,
					state: "detected" as const,
					checkedAt: 10,
				},
			];
			const summary = {
				workspaceId: "w",
				runtimeGeneration: 1,
				summaryRevision: 1,
				title: "Native workspace",
				lastActivityAtMs: 10,
				activeSessionId: "session",
				sessionHeadVersion: 1,
				updatedAtMs: 10,
				nativeAgentAccess: access,
			};
			expect(
				(await runtime.runPromise(store.saveRuntimeSummary(summary))).kind,
			).toBe("applied");
			expect(
				(await runtime.runPromise(store.getRuntimeSummary("w")))
					?.nativeAgentAccess,
			).toEqual(access);
			expect(
				(
					await runtime.runPromise(
						store.saveRuntimeSummary({ ...summary, nativeAgentAccess: [] }),
					)
				).kind,
			).toBe("stale");
			expect(
				(await runtime.runPromise(store.getRuntimeSummary("w")))
					?.nativeAgentAccess,
			).toEqual(access);
			const created = await read(0);
			expect(
				created.entries.map((entry) => entry.workspace.workspaceId),
			).toEqual(["w"]);
			expect((await read(created.cursor)).entries).toEqual([]);
			expect((await read(undefined, "another-account")).entries).toEqual([]);
			expect((await read(undefined, "organization:org_b")).entries).toEqual([]);
			const otherOwner = ownerId === "a" ? "organization:org_a" : "a";
			expect((await read(undefined, otherOwner)).entries).toEqual([]);
			expect((await read(0, otherOwner)).entries).toEqual([]);
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
			const policy = {
				creatorSubject: "creator",
				creatorMembershipId: "membership_creator",
				audience: "organization",
				permission: "edit",
				grants: [],
			};
			await pool.query(
				"UPDATE api_cloud_workspaces SET request_config=$1::jsonb WHERE workspace_id='w'",
				[JSON.stringify({ sharingPolicy: policy })],
			);
			const beforeSharing = await runtime.runPromise(store.getWorkspace("w"));
			if (beforeSharing === null) throw new Error("Missing fixture workspace");
			const sharingUpdate = {
				workspaceId: "w",
				accountId: ownerId,
				expectedRevision: 0,
				sharing: {
					audience: "private" as const,
					permission: "view" as const,
					grants: [],
				},
				nowMs: 100,
			};
			expect(
				await runtime.runPromise(
					store.updateWorkspaceSharing({
						...sharingUpdate,
						accountId: otherOwner,
					}),
				),
			).toBeNull();
			const concurrent = await Promise.all([
				runtime.runPromise(store.updateWorkspaceSharing(sharingUpdate)),
				runtime.runPromise(store.updateWorkspaceSharing(sharingUpdate)),
			]);
			expect(concurrent.filter((value) => value !== null)).toHaveLength(1);
			await runtime.runPromise(
				store.saveWorkspace({
					...beforeSharing,
					revision: beforeSharing.revision + 10,
					updatedAtMs: 200,
				}),
			);
			expect(
				(await runtime.runPromise(store.getWorkspace("w")))?.requestConfig
					.sharingPolicy,
			).toEqual({ ...policy, ...sharingUpdate.sharing, revision: 1 });
			// Exercise renewal against real row locks, rather than only the memory store.
			await pool.query(
				"UPDATE api_cloud_workspaces SET runtime_credential_hash='old', request_config=request_config || $1::jsonb WHERE workspace_id='w'",
				[
					JSON.stringify({
						runtimeGeneration: 4,
						gatewayEpoch: 8,
						runtimeSigningKeyThumbprint: "key",
						runtimeCredentialExpiresAtMs: 100,
					}),
				],
			);
			const renewal = {
				workspaceId: "w",
				currentCredentialHash: "old",
				requestId: "renew-1",
				nextCredentialHash: "next",
				expiresAtMs: 1_000,
				generation: 4,
				gatewayEpoch: 8,
				nowMs: 200,
				verifiedSigningKeyThumbprint: "key",
			};
			const renew = (overrides: Partial<typeof renewal> = {}) =>
				runtime.runPromise(
					store.renewRuntimeCredential({ ...renewal, ...overrides }),
				);
			expect(
				await runtime.runPromise(
					store.renewRuntimeCredential({
						...renewal,
						verifiedSigningKeyThumbprint: undefined,
					}),
				),
			).toBeNull();
			expect(
				await renew({ verifiedSigningKeyThumbprint: "revoked-key" }),
			).toBeNull();
			const receipts = await Promise.all([renew(), renew()]);
			expect(receipts[0]).toMatchObject({
				credentialHash: "next",
				generation: 4,
			});
			expect(receipts[1]).toEqual(receipts[0]);
			// A lost response followed by two days asleep must still renew safely.
			const wakeAt = 2 * 24 * 60 * 60_000;
			expect(
				await renew({ nowMs: wakeAt, expiresAtMs: wakeAt + 1_000 }),
			).toMatchObject({ credentialHash: "next", expiresAtMs: wakeAt + 1_000 });
			const competing = await Promise.all(
				["a", "b"].map((requestId) =>
					renew({
						currentCredentialHash: "next",
						requestId,
						nextCredentialHash: requestId,
						nowMs: wakeAt + 1,
						expiresAtMs: wakeAt + 2_000,
					}),
				),
			);
			expect(competing.filter((receipt) => receipt !== null)).toHaveLength(1);
			expect(await renew()).toBeNull();
			const winner = competing.find((receipt) => receipt !== null);
			if (!winner) throw new Error("Missing winning renewal");
			await pool.query(
				"UPDATE api_cloud_workspaces SET request_config=jsonb_set(request_config, '{runtimeSigningKeyThumbprint}', $1::jsonb) WHERE workspace_id='w'",
				[JSON.stringify("replacement-key")],
			);
			expect(
				await renew({
					currentCredentialHash: winner.previousCredentialHash,
					requestId: winner.requestId,
				}),
			).toBeNull();
			await pool.query(
				"UPDATE api_cloud_workspaces SET request_config=jsonb_set(request_config, '{runtimeGeneration}', '5'::jsonb) WHERE workspace_id='w'",
			);
			expect(
				await renew({
					currentCredentialHash: winner.previousCredentialHash,
					requestId: winner.requestId,
					verifiedSigningKeyThumbprint: "replacement-key",
				}),
			).toBeNull();
			await pool.query(
				"DELETE FROM api_cloud_workspaces WHERE workspace_id='w'",
			);
			const deleted = await read(renamed.cursor);
			expect(deleted.deletedWorkspaceIds).toEqual(["w"]);
			expect((await read(0, otherOwner)).deletedWorkspaceIds).toEqual([]);
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
