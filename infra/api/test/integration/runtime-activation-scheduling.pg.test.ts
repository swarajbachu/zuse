import { readdirSync, readFileSync } from "node:fs";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStorePg,
} from "../../src/cloud-workspace-store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"runtime callbacks cannot postpone an active activation to the idle deadline",
	async () => {
		const schema = `activation_${crypto.randomUUID().replaceAll("-", "")}`;
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
			const dir = new URL("../../drizzle/migrations/", import.meta.url);
			for (const name of readdirSync(dir)
				.filter((name) => name.endsWith(".sql"))
				.sort()) {
				for (const statement of readFileSync(new URL(name, dir), "utf8").split(
					"--> statement-breakpoint",
				))
					await pool.query(
						statement
							.replaceAll('"public".', `"${schema}".`)
							.replaceAll("public.", `${schema}.`),
					);
			}
			await pool.query(
				"INSERT INTO api_cloud_projects (project_id,account_id,repository_identity,repository_url,display_name,default_branch,visibility,git_connection_kind,configuration_digest,state,idempotency_key,created_at,updated_at) VALUES ('p','owner','repo','https://example.test/repo','Repo','main','private','github-app','digest','ready','p',1,1)",
			);
			await pool.query(
				"INSERT INTO api_cloud_project_builds (build_id,project_id,account_id,provider,template_version,configuration_digest,state,idempotency_key,next_action_at,created_at,updated_at) VALUES ('b','p','owner','boxd','1','digest','ready','b',1,1,1)",
			);
			const store = await runtime.runPromise(CloudWorkspaceStore);
			for (const phase of [
				"preparing",
				"launching",
				"confirming",
				"rolling-back",
				"confirmed",
				"failed",
			]) {
				const pending = phase !== "confirmed" && phase !== "failed";
				const workspaceId = `workspace-${phase}`;
				await runtime.runPromise(
					store.createWorkspace(
						{
							workspaceId,
							accountId: "owner",
							projectId: "p",
							buildId: "b",
							provider: "boxd",
							chatId: `chat-${phase}`,
							initialSessionId: `session-${phase}`,
							branch: phase,
							baseRef: "main",
							state: "setup",
							desiredState: "ready",
							runtimeState: "connecting",
							statusCode: "runtime-authenticating",
							idempotencyKey: phase,
							requestConfig: {
								sessionHeadVersion: 5,
								runtimeGeneration: 1,
								gatewayEpoch: 1,
								runtimeActivation: {
									id: "activation",
									phase,
									startedAtMs: 50,
									attempts: 1,
								},
							},
							nextActionAtMs: 100,
							revision: 0,
							createdAtMs: 1,
							updatedAtMs: 1,
							lastActivityAtMs: 1,
						},
						{
							workspaceId,
							accountId: "owner",
							chatId: `chat-${phase}`,
							sessionId: `session-${phase}`,
							turnId: `turn-${phase}`,
							commandId: `launch:${workspaceId}`,
							ciphertext: "encrypted",
							expiresAtMs: 1_000_000,
							createdAtMs: 1,
						},
					),
				);
				await pool.query(
					"UPDATE api_cloud_workspaces SET provider_sandbox_id=workspace_id, runtime_boot_token_hash='boot', runtime_boot_token_expires_at=1000000 WHERE workspace_id=$1",
					[workspaceId],
				);
				const enrolled = await runtime.runPromise(
					store.enrollRuntimeBoot({
						workspaceId,
						bootTokenHash: "boot",
						credentialKeyThumbprint: "credential",
						signingKeyThumbprint: "signing",
						signingPublicJwk: "jwk",
						runtimeCredentialHash: "runtime",
						runtimeCredentialExpiresAtMs: 1_000_000,
						generation: 1,
						gatewayEpoch: 1,
						sealedTranscriptKey: "sealed",
						nowMs: 200,
					}),
				);
				expect(enrolled?.workspace.nextActionAtMs).toBe(pending ? 100 : 30_200);
				const ready = await runtime.runPromise(
					store.markRuntimeRepositoryReady({
						workspaceId,
						currentCredentialHash: "runtime",
						nowMs: 300,
						nextIdleAtMs: 10_000,
					}),
				);
				expect(ready?.nextActionAtMs).toBe(pending ? 100 : 10_000);
				const activity = await runtime.runPromise(
					store.recordActivity(workspaceId, "owner", 400, 11_000, true),
				);
				expect(activity?.nextActionAtMs).toBe(pending ? 100 : 11_000);
				const launch = await runtime.runPromise(
					store.completeLaunchIntent({
						workspaceId,
						commandId: `launch:${workspaceId}`,
						sessionHeadVersion: 6,
						nowMs: 500,
						nextActionAtMs: 12_000,
					}),
				);
				expect(launch).toMatchObject({
					kind: "completed",
					workspace: { nextActionAtMs: pending ? 100 : 12_000 },
				});
				await pool.query(
					'UPDATE api_cloud_workspaces SET request_config=request_config || \'{"cloudMailboxWakePending":true,"cloudMailboxWakeRevision":1}\'::jsonb WHERE workspace_id=$1',
					[workspaceId],
				);
				await runtime.runPromise(
					store.recordMailboxRuntimePoll(workspaceId, "owner", 1, 600, 13_000),
				);
				expect(
					(await runtime.runPromise(store.getWorkspace(workspaceId)))
						?.nextActionAtMs,
				).toBe(pending ? 100 : 13_000);
				await runtime.runPromise(
					store.recordMailboxRuntimeProgress(
						workspaceId,
						"owner",
						1,
						1,
						1,
						false,
						700,
						14_000,
					),
				);
				expect(
					(await runtime.runPromise(store.getWorkspace(workspaceId)))
						?.nextActionAtMs,
				).toBe(pending ? 100 : 14_000);
				await runtime.runPromise(
					store.completeMailboxDrain(workspaceId, "owner", 1, 1, 800, 15_000),
				);
				expect(
					(await runtime.runPromise(store.getWorkspace(workspaceId)))
						?.nextActionAtMs,
				).toBe(pending ? 100 : 15_000);
				// A committed renewal may outlive both its HTTP response and credential expiry.
				const renew = (overrides = {}) =>
					runtime.runPromise(
						store.renewRuntimeCredential({
							workspaceId,
							currentCredentialHash: "runtime",
							requestId: "lost-response",
							nextCredentialHash: "rotated",
							expiresAtMs: 1_000,
							generation: 1,
							gatewayEpoch: 1,
							nowMs: 900,
							verifiedSigningKeyThumbprint: "signing",
							...overrides,
						}),
					);
				const first = await renew();
				expect(first?.credentialHash).toBe("rotated");
				expect(await renew()).toEqual(first);
				const later = 2 * 24 * 60 * 60_000;
				expect(
					await renew({
						nowMs: later,
						verifiedSigningKeyThumbprint: undefined,
					}),
				).toBeNull();
				const recovered = await renew({
					nowMs: later,
					expiresAtMs: later + 10_000,
				});
				expect(recovered).toMatchObject({
					credentialHash: "rotated",
					expiresAtMs: later + 10_000,
				});
				const ack = (currentCredentialHash: string, generation = 1) =>
					runtime.runPromise(
						store.acknowledgeRuntimeBoot({
							workspaceId,
							currentCredentialHash,
							generation,
							gatewayEpoch: 1,
							nowMs: later + 1,
						}),
					);
				expect(await ack("runtime")).toBe(false);
				expect(await ack("rotated", 2)).toBe(false);
				expect(await ack("rotated")).toBe(true);
				expect(
					await renew({
						currentCredentialHash: "rotated",
						requestId: "next-renewal",
						nextCredentialHash: "next-rotated",
						nowMs: later + 2,
						expiresAtMs: later + 20_000,
					}),
				).toMatchObject({ credentialHash: "next-rotated" });
				expect(await ack("rotated")).toBe(false);
				expect(await ack("next-rotated")).toBe(true);
				expect(await renew({ nowMs: later + 3 })).toBeNull();
				expect(
					(await runtime.runPromise(store.getWorkspace(workspaceId)))
						?.nextActionAtMs,
				).toBe(pending ? 100 : 15_000);
			}
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
	30_000,
);
