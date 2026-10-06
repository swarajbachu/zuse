import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { ApiStore, ApiStorePg } from "../../src/store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"GitHub enrollment intent survives a failed external operation with single-connection pools",
	async () => {
		const schema = `github_join_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pools = [
			new Pool({
				connectionString: url,
				max: 1,
				options: `-c search_path=${schema}`,
			}),
			new Pool({
				connectionString: url,
				max: 1,
				options: `-c search_path=${schema}`,
			}),
		];
		const runtimes = pools.map((pool) =>
			ManagedRuntime.make(
				ApiStorePg.pipe(
					Layer.provideMerge(
						PgClient.layerFrom(
							PgClient.fromPool({ acquire: Effect.succeed(pool) }),
						),
					),
				),
			),
		);
		try {
			for (const migration of [
				"0035_github_organization_joining.sql",
				"0036_organization_auto_join.sql",
			])
				await pools[0]?.query(
					await readFile(
						new URL(`../../drizzle/migrations/${migration}`, import.meta.url),
						"utf8",
					),
				);
			const first = runtimes[0];
			const second = runtimes[1];
			if (!first || !second) throw new Error("missing runtime");
			const a = await first.runPromise(ApiStore);
			const b = await second.runPromise(ApiStore);
			const identity = {
				accountId: "alice",
				githubUserId: 10,
				login: "alice",
				organizationIds: [99],
				verificationId: "one",
			};
			expect(
				await first.runPromise(a.githubJoining.saveIdentity(identity)),
			).toBe(true);
			// One GitHub account never links to two Zuse accounts.
			expect(
				await second.runPromise(
					b.githubJoining.saveIdentity({ ...identity, accountId: "other" }),
				),
			).toBe(false);
			// An account may switch to another GitHub account.
			expect(
				await first.runPromise(
					a.githubJoining.saveIdentity({ ...identity, githubUserId: 12 }),
				),
			).toBe(true);
			expect(
				await second.runPromise(b.githubJoining.getIdentity("alice")),
			).toMatchObject({ githubUserId: 12 });
			// Rosters replace atomically and are visible to other workers.
			await first.runPromise(
				a.githubJoining.replaceRoster(123, new Set([10, 11])),
			);
			await first.runPromise(
				a.githubJoining.replaceRoster(123, new Set([10, 12])),
			);
			expect(
				await second.runPromise(b.githubJoining.installationsWithMember(10)),
			).toEqual([123]);
			expect(
				await second.runPromise(b.githubJoining.installationsWithMember(11)),
			).toEqual([]);
			expect(
				await second.runPromise(b.githubJoining.identitiesInRoster(123)),
			).toMatchObject([{ accountId: "alice", githubUserId: 12 }]);
			// An unverified claim proves nothing and can be taken over; a verified
			// one belongs to its organization.
			const domain = {
				domain: "acme.dev",
				organizationId: "org",
				createdBy: "alice",
				verified: false,
				verificationToken: "token",
			};
			expect(await first.runPromise(a.domainJoining.claimDomain(domain))).toBe(
				true,
			);
			expect(
				await second.runPromise(
					b.domainJoining.claimDomain({ ...domain, organizationId: "rival" }),
				),
			).toBe(true);
			expect(await first.runPromise(a.domainJoining.claimDomain(domain))).toBe(
				true,
			);
			await first.runPromise(
				a.domainJoining.saveDomain({ ...domain, verified: true }),
			);
			expect(
				await second.runPromise(
					b.domainJoining.claimDomain({ ...domain, organizationId: "rival" }),
				),
			).toBe(false);
			expect(
				await second.runPromise(b.domainJoining.getDomain("acme.dev")),
			).toMatchObject({ organizationId: "org", verified: true });
			const enrollment = {
				organizationId: "org",
				accountId: "alice",
				githubUserId: 10,
				installationId: 123,
				githubOrgId: 99,
				blocked: false,
				memberId: null,
				reservedUntil: Date.now() + 600_000,
				revision: "intent",
			};
			await first.runPromise(
				a.withOrganizationLock(
					"org",
					a.githubJoining.saveEnrollment(enrollment),
				),
			);
			await first.runPromise(
				a
					.withOrganizationLock(
						"org",
						a.githubJoining
							.saveEnrollment({ ...enrollment, memberId: "provider-created" })
							.pipe(Effect.andThen(Effect.fail("lost-provider-response"))),
					)
					.pipe(Effect.result),
			);
			expect(
				await second.runPromise(b.githubJoining.getEnrollment("org", "alice")),
			).toEqual(enrollment);
			await first.runPromise(
				a.githubJoining.savePolicy({
					organizationId: "org",
					installationId: 123,
					githubOrgId: 99,
					login: "acme",
					enabled: true,
					revision: "initial",
				}),
			);
			expect(
				await second.runPromise(
					b.githubJoining.listPolicies({ installationIds: [456] }),
				),
			).toEqual([]);
			expect(
				await second.runPromise(
					b.githubJoining.listPolicies({ installationIds: [123] }),
				),
			).toHaveLength(1);
			// Separate workers serialize read-modify-write operations on the same org.
			const append = (api: typeof a, suffix: string) =>
				api.withOrganizationLock(
					"org",
					Effect.gen(function* () {
						const value = yield* api.githubJoining.getEnrollment(
							"org",
							"alice",
						);
						if (!value) throw new Error("missing enrollment");
						yield* Effect.sleep("10 millis");
						yield* api.githubJoining.saveEnrollment({
							...value,
							revision: value.revision + suffix,
						});
					}),
				);
			await Promise.all([
				first.runPromise(append(a, "A")),
				second.runPromise(append(b, "B")),
			]);
			expect(
				(await second.runPromise(b.githubJoining.getEnrollment("org", "alice")))
					?.revision,
			).toMatch(/^intent(AB|BA)$/);
		} finally {
			for (const runtime of runtimes) await runtime.dispose();
			for (const pool of pools) if (!pool.ended) await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
	20_000,
);
