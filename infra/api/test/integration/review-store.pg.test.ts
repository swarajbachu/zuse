import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import type { ReviewResult } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import type { ReviewComparison } from "../../src/review-domain.ts";
import {
	ReviewLifecycleStore,
	ReviewLifecycleStorePg,
} from "../../src/review-lifecycle-store.ts";
import {
	type ReviewAuthorization,
	ReviewStore,
	ReviewStorePg,
} from "../../src/review-store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"review routing, leases, spend provenance and publication intent survive concurrent workers and restart",
	async () => {
		const schema = `review_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		const layer = Layer.merge(ReviewStorePg, ReviewLifecycleStorePg).pipe(
			Layer.provide(
				PgClient.layerFrom(
					PgClient.fromPool({ acquire: Effect.succeed(pool) }),
				),
			),
		);
		let runtime = ManagedRuntime.make(layer);
		try {
			await pool.query(
				await readFile(
					new URL(
						"../../drizzle/migrations/0039_review_control_plane.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			let store = await runtime.runPromise(ReviewStore);
			const auth = (
				id: string,
				kind: "personal" | "shared",
				ownerId: string,
			): ReviewAuthorization => ({
				id,
				actorId: ownerId,
				ownerId,
				request: {
					repositoryId: 1,
					kind,
					acknowledgedCharges: true,
					modelConnectionId: "conn",
					agentProvider: "codex",
					model: "model",
					worker: { provider: "e2b", size: "small", maxRuntimeMs: 600000 },
				},
				expiresAtMs: 999999,
			});
			await store.createAuthorization(auth("shared-auth", "shared", "sponsor"));
			await expect(
				store.completeAuthorization(
					"shared-auth",
					{
						githubUserId: 8,
						repositoryId: 1,
						repositoryFullName: "org/repo",
						installationId: 2,
						admin: false,
					},
					1,
				),
			).rejects.toThrow();
			const shared = await store.completeAuthorization(
				"shared-auth",
				{
					githubUserId: 8,
					repositoryId: 1,
					repositoryFullName: "org/repo",
					installationId: 2,
					admin: true,
				},
				2,
			);
			await store.createAuthorization(
				auth("personal-auth", "personal", "author"),
			);
			const personal = await store.completeAuthorization(
				"personal-auth",
				{
					githubUserId: 42,
					repositoryId: 1,
					repositoryFullName: "org/repo",
					installationId: 2,
					admin: false,
				},
				3,
			);
			await expect(
				store.completeAuthorization(
					"personal-auth",
					{
						githubUserId: 42,
						repositoryId: 1,
						repositoryFullName: "org/repo",
						installationId: 2,
						admin: false,
					},
					4,
				),
			).rejects.toThrow();
			const eventPayload = { installationId: 2, pullNumber: 3 };
			await store.enqueueEvent(
				"delivery-a",
				1,
				"pull_request",
				eventPayload,
				1000,
			);
			await store.enqueueEvent(
				"delivery-b",
				1,
				"pull_request",
				eventPayload,
				21000,
			);
			expect(
				await store.enqueueEvent(
					"delivery-b",
					1,
					"pull_request",
					eventPayload,
					22000,
				),
			).toBe(false);
			expect(await store.claimEvents(31000, 10)).toHaveLength(0);
			const debounced = await store.claimEvents(51000, 10);
			expect(debounced).toHaveLength(1);
			const delivered = debounced[0];
			if (!delivered) throw Error("missing debounced event");
			await store.finishEvent(
				delivered.deliveryId,
				delivered.leaseToken,
				51001,
			);
			await store.enqueueEvent(
				"bounded-a",
				1,
				"push",
				{ installationId: 2, baseRef: "main" },
				100000,
			);
			for (let i = 1; i <= 4; i++)
				await store.enqueueEvent(
					`bounded-${i}`,
					1,
					"push",
					{ installationId: 2, baseRef: "main" },
					100000 + i * 25000,
				);
			const bounded = await store.claimEvents(220000, 10);
			expect(bounded).toHaveLength(1);
			expect(bounded[0]?.deliveryId).toBe("bounded-a");
			const capped = bounded[0];
			if (!capped) throw Error("missing bounded event");
			await store.finishEvent(capped.deliveryId, capped.leaseToken, 220001);
			const comparison: ReviewComparison = {
				repositoryId: 1,
				repositoryFullName: "org/repo",
				installationId: 2,
				pullNumber: 5,
				authorGithubUserId: 42,
				baseRef: "main",
				baseSha: "a".repeat(40),
				headSha: "b".repeat(40),
				fork: false,
			};
			const refreshToken = await store.claimRepositoryRefresh(1, 9);
			if (!refreshToken) throw Error("refresh missing");
			await expect(store.createRun(comparison, 10)).rejects.toThrow(
				"review_refresh_lease_lost",
			);
			expect(await store.claimRepositoryRefresh(1, 10)).toBeNull();
			const runs = await Promise.all(
				Array.from({ length: 8 }, () =>
					store.createRun(comparison, 10, "automatic", refreshToken),
				),
			);
			expect(new Set(runs.map((r) => r?.id)).size).toBe(1);
			const run = runs[0];
			if (!run) throw Error("run missing");
			expect(run.ownerId).toBe("author");
			expect(await store.listRuns("sponsor", undefined, 50)).toEqual([]);
			const claims = await Promise.all(
				Array.from({ length: 4 }, () => store.claimRun(run.id, 11)),
			);
			expect(claims.filter(Boolean)).toHaveLength(1);
			const claim = claims.find((c) => c !== null);
			if (!claim) throw Error("claim missing");
			await store.blockRun(run.id, claim.leaseToken, "quota_exhausted", 12);
			expect((await store.getRun(run.id))?.ownerId).toBe("author");
			expect((await store.getRun(run.id))?.state).toBe("blocked");
			expect(await store.disableEnrollment("sponsor", personal.id, 13)).toBe(
				false,
			);
			expect(await store.disableEnrollment("author", personal.id, 14)).toBe(
				true,
			);
			expect((await store.getRun(run.id))?.state).toBe("cancelled");
			expect(
				(await store.createRun(comparison, 15, "automatic", refreshToken))?.id,
			).toBe(run.id);
			const retry = await store.createRun(
				comparison,
				16,
				"manual-1",
				refreshToken,
			);
			if (!retry) throw Error("retry missing");
			expect(retry.ownerId).toBe("sponsor");
			const lease = await store.claimRun(retry.id, 17);
			if (!lease) throw Error("lease missing");
			expect(
				await store.recordAttempt({
					id: "attempt",
					runId: retry.id,
					leaseToken: lease.leaseToken,
					provider: "e2b",
					maximumLifetimeMs: 300000,
					nowMs: 18,
				}),
			).toBe(true);
			expect(
				await store.attachSandbox("attempt", lease.leaseToken, "sandbox", 19),
			).toBe(true);
			expect(
				await store.recordAttempt({
					id: "duplicate",
					runId: retry.id,
					leaseToken: lease.leaseToken,
					provider: "e2b",
					maximumLifetimeMs: 300000,
					nowMs: 20,
				}),
			).toBe(false);
			await pool.query(
				"INSERT INTO api_review_native_connections(id,owner_actor_id,state,data,lease_token,lease_expires_at_ms) VALUES('conn','sponsor','ready','{}',$1,999999)",
				[lease.leaseToken],
			);
			await pool.query(
				"UPDATE api_review_attempts SET lifecycle=$1::jsonb WHERE id='attempt'",
				[JSON.stringify({ bootHash: "worker-hash", deadlineMs: 1000 })],
			);
			const native = await runtime.runPromise(ReviewLifecycleStore);
			expect(
				await native.authenticateAttempt("attempt", "forged-hash", 21),
			).toBeNull();
			expect(
				await native.authenticateAttempt("another-attempt", "worker-hash", 21),
			).toBeNull();
			expect(
				await native.authenticateAttempt("attempt", "worker-hash", 1001),
			).toBeNull();
			expect(
				(await native.authenticateAttempt("attempt", "worker-hash", 21))
					?.ownerId,
			).toBe("sponsor");
			await pool.query(
				"UPDATE api_review_runs SET lease_token='replacement' WHERE id=$1",
				[retry.id],
			);
			expect(
				await native.authenticateAttempt("attempt", "worker-hash", 21),
			).toBeNull();
			await pool.query(
				"UPDATE api_review_runs SET lease_token=$1 WHERE id=$2",
				[lease.leaseToken, retry.id],
			);
			await pool.query(
				"UPDATE api_review_native_connections SET state='revoked' WHERE id='conn'",
			);
			expect(
				await native.authenticateAttempt("attempt", "worker-hash", 21),
			).toBeNull();
			await pool.query(
				"UPDATE api_review_native_connections SET state='ready' WHERE id='conn'",
			);
			const result: ReviewResult = {
				snapshot: {
					repositoryId: 1,
					baseRef: "main",
					baseSha: comparison.baseSha,
					headSha: comparison.headSha,
					mergeBaseSha: comparison.baseSha,
				},
				status: "completed",
				findings: [],
				coverage: {
					eligibleFiles: 1,
					reviewedFiles: 1,
					excludedFiles: 0,
					unreviewedPaths: [],
					contextLimited: false,
				},
			};
			expect(
				await store.acceptResult(retry.id, "stale-token", result, 21),
			).toBe(false);
			expect(
				await store.acceptResult(
					retry.id,
					lease.leaseToken,
					{
						...result,
						snapshot: { ...result.snapshot, headSha: "c".repeat(40) },
					},
					21,
				),
			).toBe(false);
			expect(
				await store.acceptResult(retry.id, lease.leaseToken, result, 21),
			).toBe(true);
			const publications = await store.claimPublications(22, 20);
			expect(publications).toHaveLength(1);
			expect(publications[0]?.mayCreate).toBe(true);
			const publication = publications[0];
			if (!publication) throw Error("publication missing");

			await store.finishPublication(
				publication.id,
				publication.leaseToken,
				null,
				23,
				"unwritten",
			);
			const beforeWrite = await store.claimPublications(60024, 20);
			expect(beforeWrite[0]?.mayCreate).toBe(true);
			const beforeWritePublication = beforeWrite[0];
			if (!beforeWritePublication) throw Error("publication missing");
			await store.finishPublication(
				publication.id,
				beforeWritePublication.leaseToken,
				null,
				60025,
			);

			await runtime.dispose();
			runtime = ManagedRuntime.make(layer);
			store = await runtime.runPromise(ReviewStore);
			const recovered = await store.claimPublications(120026, 20);
			expect(recovered[0]?.mayCreate).toBe(false);
			const recoveredPublication = recovered[0];
			if (!recoveredPublication) throw Error("publication missing");
			await store.finishPublication(
				publication.id,
				recoveredPublication.leaseToken,
				"github-123",
				120027,
			);
			expect((await store.getRun(retry.id))?.state).toBe("completed");
			await pool.query(
				"UPDATE api_review_runs SET state='publishing' WHERE id=$1",
				[retry.id],
			);
			await pool.query(
				"UPDATE api_review_publications SET state='pending',available_at_ms=120028 WHERE id=$1",
				[publication.id],
			);
			const stale = (await store.claimPublications(120028, 20))[0];
			if (!stale) throw Error("stale publication missing");
			await store.finishPublication(
				stale.id,
				stale.leaseToken,
				"github-raced",
				120029,
				"superseded",
			);
			expect((await store.getRun(retry.id))?.state).toBe("superseded");
			expect(
				(
					await pool.query(
						"SELECT github_id FROM api_review_publications WHERE id=$1",
						[stale.id],
					)
				).rows[0].github_id,
			).toBe("github-raced");

			expect(await store.canReadRunArtifacts(retry.id)).toBe(true);
			await store.disableEnrollment("sponsor", shared.id, 120030);
			expect(await store.canReadRunArtifacts(retry.id)).toBe(false);
			expect(await store.getBillingResource("e2b", "attempt")).toEqual({
				accountId: "sponsor",
				providerSandboxId: "sandbox",
			});
			expect(await store.getBillingResource("other", "attempt")).toBeNull();
			await store.releaseRepositoryRefresh(1, refreshToken);
			const nextRefresh = await store.claimRepositoryRefresh(1, 120031);
			expect(nextRefresh).not.toBeNull();
			await expect(
				store.createRun(
					{ ...comparison, headSha: "c".repeat(40) },
					120032,
					"automatic",
					refreshToken,
				),
			).rejects.toThrow("review_refresh_lease_lost");
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
