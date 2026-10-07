import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import type { ReviewResult } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import type { ReviewComparison } from "../../src/review-domain.ts";
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
		const layer = ReviewStorePg.pipe(
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
			);
			await runtime.dispose();
			runtime = ManagedRuntime.make(layer);
			store = await runtime.runPromise(ReviewStore);
			const recovered = await store.claimPublications(60024, 20);
			expect(recovered[0]?.mayCreate).toBe(false);
			const recoveredPublication = recovered[0];
			if (!recoveredPublication) throw Error("publication missing");
			await store.finishPublication(
				publication.id,
				recoveredPublication.leaseToken,
				"github-123",
				60025,
			);
			expect((await store.getRun(retry.id))?.state).toBe("completed");
			expect(await store.canReadRunArtifacts(retry.id)).toBe(true);
			await store.disableEnrollment("sponsor", shared.id, 60026);
			expect(await store.canReadRunArtifacts(retry.id)).toBe(false);
			expect(await store.getBillingResource("e2b", "attempt")).toEqual({
				accountId: "sponsor",
				providerSandboxId: "sandbox",
			});
			expect(await store.getBillingResource("other", "attempt")).toBeNull();
			await store.releaseRepositoryRefresh(1, refreshToken);
			const nextRefresh = await store.claimRepositoryRefresh(1, 60027);
			expect(nextRefresh).not.toBeNull();
			await expect(
				store.createRun(
					{ ...comparison, headSha: "c".repeat(40) },
					60028,
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
