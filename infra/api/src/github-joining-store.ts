import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export const GithubIdentity = Schema.Struct({
	accountId: Schema.String,
	githubUserId: Schema.Number,
	login: Schema.String,
	organizationIds: Schema.Array(Schema.Number),
	verificationId: Schema.String,
});
export type GithubIdentity = typeof GithubIdentity.Type;
export const GithubJoinPolicy = Schema.Struct({
	organizationId: Schema.String,
	installationId: Schema.Number,
	githubOrgId: Schema.Number,
	login: Schema.String,
	enabled: Schema.Boolean,
	revision: Schema.String,
});
export type GithubJoinPolicy = typeof GithubJoinPolicy.Type;
export const GithubEnrollment = Schema.Struct({
	organizationId: Schema.String,
	accountId: Schema.String,
	githubUserId: Schema.Number,
	installationId: Schema.Number,
	githubOrgId: Schema.Number,
	blocked: Schema.Boolean,
	memberId: Schema.NullOr(Schema.String),
	reservedUntil: Schema.Number,
	revision: Schema.String,
});
export type GithubEnrollment = typeof GithubEnrollment.Type;
export interface GithubPolicyFilter {
	readonly organizationId?: string;
	readonly installationId?: number;
	readonly githubOrgIds?: ReadonlyArray<number>;
	readonly installationIds?: ReadonlyArray<number>;
}
export interface GithubJoiningStore {
	getIdentity(accountId: string): Effect.Effect<GithubIdentity | null>;
	saveIdentity(identity: GithubIdentity): Effect.Effect<boolean>;
	/** Replace an installation's roster with a complete, freshly read one. */
	replaceRoster(
		installationId: number,
		githubUserIds: ReadonlySet<number>,
	): Effect.Effect<void>;
	/** Installations whose last complete roster includes this GitHub user. */
	installationsWithMember(
		githubUserId: number,
	): Effect.Effect<ReadonlyArray<number>>;
	/** Linked identities whose GitHub account is in an installation's roster. */
	identitiesInRoster(
		installationId: number,
	): Effect.Effect<ReadonlyArray<GithubIdentity>>;
	listPolicies(
		filter?: GithubPolicyFilter,
	): Effect.Effect<ReadonlyArray<GithubJoinPolicy>>;
	savePolicy(policy: GithubJoinPolicy): Effect.Effect<void>;
	getEnrollment(
		organizationId: string,
		accountId: string,
	): Effect.Effect<GithubEnrollment | null>;
	listEnrollments(
		organizationId?: string,
		installationId?: number,
	): Effect.Effect<ReadonlyArray<GithubEnrollment>>;
	saveEnrollment(enrollment: GithubEnrollment): Effect.Effect<void>;
	deleteAccount(accountId: string): Effect.Effect<void>;
}
export const makeGithubJoiningMemory = (): GithubJoiningStore => {
	const identities = new Map<string, GithubIdentity>();
	const rosters = new Map<number, ReadonlySet<number>>();
	const policies = new Map<string, GithubJoinPolicy>();
	const enrollments = new Map<string, GithubEnrollment>();
	return {
		getIdentity: (id) => Effect.sync(() => identities.get(id) ?? null),
		saveIdentity: (value) =>
			Effect.sync(() => {
				if (
					[...identities.values()].some(
						(i) =>
							i.githubUserId === value.githubUserId &&
							i.accountId !== value.accountId,
					)
				)
					return false;
				identities.set(value.accountId, value);
				return true;
			}),
		replaceRoster: (installationId, ids) =>
			Effect.sync(() => {
				rosters.set(installationId, new Set(ids));
			}),
		installationsWithMember: (githubUserId) =>
			Effect.sync(() =>
				[...rosters]
					.filter(([, members]) => members.has(githubUserId))
					.map(([installationId]) => installationId),
			),
		identitiesInRoster: (installationId) =>
			Effect.sync(() => {
				const members = rosters.get(installationId);
				return [...identities.values()].filter(
					(i) => members?.has(i.githubUserId) === true,
				);
			}),
		listPolicies: (filter = {}) =>
			Effect.sync(() =>
				[...policies.values()].filter(
					(p) =>
						(filter.githubOrgIds === undefined ||
							filter.githubOrgIds.includes(p.githubOrgId)) &&
						(filter.installationIds === undefined ||
							filter.installationIds.includes(p.installationId)) &&
						(filter.organizationId === undefined ||
							p.organizationId === filter.organizationId) &&
						(filter.installationId === undefined ||
							p.installationId === filter.installationId),
				),
			),
		savePolicy: (p) =>
			Effect.sync(() => {
				policies.set(`${p.organizationId}:${p.installationId}`, p);
			}),
		getEnrollment: (org, account) =>
			Effect.sync(() => enrollments.get(`${org}:${account}`) ?? null),
		listEnrollments: (org, installationId) =>
			Effect.sync(() =>
				[...enrollments.values()].filter(
					(e) =>
						(org === undefined || e.organizationId === org) &&
						(installationId === undefined ||
							e.installationId === installationId),
				),
			),
		saveEnrollment: (e) =>
			Effect.sync(() => {
				enrollments.set(`${e.organizationId}:${e.accountId}`, e);
			}),
		deleteAccount: (account) =>
			Effect.sync(() => {
				identities.delete(account);
				for (const [key, value] of enrollments)
					if (value.accountId === account) enrollments.delete(key);
			}),
	};
};
export const makeGithubJoiningSql = (
	sql: SqlClient.SqlClient,
): GithubJoiningStore => {
	const durable = <A>(effect: Effect.Effect<A, unknown>) =>
		effect.pipe(Effect.orDie);
	const decode = <A, I>(
		schema: Schema.Codec<A, I>,
		rows: ReadonlyArray<{ data: unknown }>,
	) => rows.map((r) => Schema.decodeUnknownSync(schema)(r.data));
	return {
		getIdentity: (account) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_github_identities WHERE account_id=${account}`.pipe(
					Effect.map((rows) => decode(GithubIdentity, rows)[0] ?? null),
				),
			),
		// An account may switch GitHub accounts; one GitHub account never links to
		// two Zuse accounts (the unique github_user_id index enforces races).
		saveIdentity: (i) =>
			sql<{
				account_id: string;
			}>`SELECT account_id FROM api_github_identities WHERE github_user_id=${i.githubUserId}`.pipe(
				Effect.flatMap((rows) =>
					rows.some((row) => row.account_id !== i.accountId)
						? Effect.succeed(false)
						: sql`INSERT INTO api_github_identities (account_id, github_user_id, data) VALUES (${i.accountId}, ${i.githubUserId}, ${JSON.stringify(i)}::jsonb) ON CONFLICT (account_id) DO UPDATE SET github_user_id=EXCLUDED.github_user_id, data=EXCLUDED.data`.pipe(
								Effect.as(true),
							),
				),
				Effect.catch(() => Effect.succeed(false)),
			),
		replaceRoster: (installationId, ids) => {
			const members = JSON.stringify([...ids]);
			return durable(
				sql
					.withTransaction(
						sql`DELETE FROM api_github_org_members WHERE installation_id=${installationId} AND NOT (github_user_id = ANY (SELECT jsonb_array_elements_text(${members}::jsonb)::bigint))`.pipe(
							Effect.andThen(
								sql`INSERT INTO api_github_org_members (installation_id, github_user_id) SELECT ${installationId}, jsonb_array_elements_text(${members}::jsonb)::bigint ON CONFLICT DO NOTHING`,
							),
						),
					)
					.pipe(Effect.asVoid),
			);
		},
		installationsWithMember: (githubUserId) =>
			durable(
				sql<{
					installation_id: string | number;
				}>`SELECT installation_id FROM api_github_org_members WHERE github_user_id=${githubUserId}`.pipe(
					Effect.map((rows) => rows.map((r) => Number(r.installation_id))),
				),
			),
		identitiesInRoster: (installationId) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT i.data FROM api_github_identities i JOIN api_github_org_members m ON m.github_user_id = i.github_user_id WHERE m.installation_id=${installationId}`.pipe(
					Effect.map((rows) => decode(GithubIdentity, rows)),
				),
			),
		listPolicies: (filter = {}) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_github_join_policies WHERE (${filter.organizationId ?? null}::text IS NULL OR organization_id=${filter.organizationId ?? null}) AND (${filter.installationId ?? null}::bigint IS NULL OR installation_id=${filter.installationId ?? null}) AND ${filter.githubOrgIds === undefined ? sql`TRUE` : sql.in("github_org_id", filter.githubOrgIds)} AND ${filter.installationIds === undefined ? sql`TRUE` : filter.installationIds.length === 0 ? sql`FALSE` : sql.in("installation_id", filter.installationIds)}`.pipe(
					Effect.map((rows) => decode(GithubJoinPolicy, rows)),
				),
			),
		savePolicy: (p) =>
			durable(
				sql`INSERT INTO api_github_join_policies (organization_id, installation_id, github_org_id, data) VALUES (${p.organizationId}, ${p.installationId}, ${p.githubOrgId}, ${JSON.stringify(p)}::jsonb) ON CONFLICT (organization_id, installation_id) DO UPDATE SET data=EXCLUDED.data, github_org_id=EXCLUDED.github_org_id`.pipe(
					Effect.asVoid,
				),
			),
		getEnrollment: (org, account) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_github_enrollments WHERE organization_id=${org} AND account_id=${account}`.pipe(
					Effect.map((rows) => decode(GithubEnrollment, rows)[0] ?? null),
				),
			),
		listEnrollments: (org, installationId) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_github_enrollments WHERE (${org ?? null}::text IS NULL OR organization_id=${org ?? null}) AND (${installationId ?? null}::bigint IS NULL OR installation_id=${installationId ?? null})`.pipe(
					Effect.map((rows) => decode(GithubEnrollment, rows)),
				),
			),
		saveEnrollment: (e) =>
			durable(
				sql`INSERT INTO api_github_enrollments (organization_id, account_id, installation_id, data) VALUES (${e.organizationId}, ${e.accountId}, ${e.installationId}, ${JSON.stringify(e)}::jsonb) ON CONFLICT (organization_id, account_id) DO UPDATE SET data=EXCLUDED.data, installation_id=EXCLUDED.installation_id`.pipe(
					Effect.asVoid,
				),
			),
		deleteAccount: (account) =>
			durable(
				sql`DELETE FROM api_github_identities WHERE account_id=${account}`.pipe(
					Effect.andThen(
						sql`DELETE FROM api_github_enrollments WHERE account_id=${account}`,
					),
					Effect.asVoid,
				),
			),
	};
};
