import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export const OrganizationDomain = Schema.Struct({
	domain: Schema.String,
	organizationId: Schema.String,
	createdBy: Schema.String,
	/** Proven by a DNS TXT record; only verified domains admit anyone. */
	verified: Schema.optional(Schema.Boolean),
	verificationToken: Schema.optional(Schema.String),
});
export type OrganizationDomain = typeof OrganizationDomain.Type;
/** Provenance for a domain auto-join, and the admin-removal block. */
export const DomainEnrollment = Schema.Struct({
	organizationId: Schema.String,
	accountId: Schema.String,
	domain: Schema.String,
	memberId: Schema.NullOr(Schema.String),
	blocked: Schema.Boolean,
});
export type DomainEnrollment = typeof DomainEnrollment.Type;

export interface DomainJoiningStore {
	getDomain(domain: string): Effect.Effect<OrganizationDomain | null>;
	listDomains(
		organizationId: string,
	): Effect.Effect<ReadonlyArray<OrganizationDomain>>;
	/**
	 * Claims a domain; false when another organization verified it. An
	 * unverified claim proves nothing, so another organization may replace it.
	 */
	claimDomain(domain: OrganizationDomain): Effect.Effect<boolean>;
	/** Updates this organization's claim (e.g. after verification). */
	saveDomain(domain: OrganizationDomain): Effect.Effect<void>;
	removeDomain(organizationId: string, domain: string): Effect.Effect<void>;
	getEnrollment(
		organizationId: string,
		accountId: string,
	): Effect.Effect<DomainEnrollment | null>;
	listEnrollments(
		organizationId: string,
	): Effect.Effect<ReadonlyArray<DomainEnrollment>>;
	saveEnrollment(enrollment: DomainEnrollment): Effect.Effect<void>;
	deleteAccount(accountId: string): Effect.Effect<void>;
}

export const makeDomainJoiningMemory = (): DomainJoiningStore => {
	const domains = new Map<string, OrganizationDomain>();
	const enrollments = new Map<string, DomainEnrollment>();
	return {
		getDomain: (domain) => Effect.sync(() => domains.get(domain) ?? null),
		listDomains: (organizationId) =>
			Effect.sync(() =>
				[...domains.values()].filter(
					(d) => d.organizationId === organizationId,
				),
			),
		claimDomain: (value) =>
			Effect.sync(() => {
				const existing = domains.get(value.domain);
				if (existing?.organizationId === value.organizationId) return true;
				if (existing?.verified) return false;
				domains.set(value.domain, value);
				return true;
			}),
		saveDomain: (value) =>
			Effect.sync(() => {
				if (domains.get(value.domain)?.organizationId === value.organizationId)
					domains.set(value.domain, value);
			}),
		removeDomain: (organizationId, domain) =>
			Effect.sync(() => {
				if (domains.get(domain)?.organizationId === organizationId)
					domains.delete(domain);
			}),
		getEnrollment: (org, account) =>
			Effect.sync(() => enrollments.get(`${org}:${account}`) ?? null),
		listEnrollments: (org) =>
			Effect.sync(() =>
				[...enrollments.values()].filter((e) => e.organizationId === org),
			),
		saveEnrollment: (e) =>
			Effect.sync(() => {
				enrollments.set(`${e.organizationId}:${e.accountId}`, e);
			}),
		deleteAccount: (account) =>
			Effect.sync(() => {
				for (const [key, value] of enrollments)
					if (value.accountId === account) enrollments.delete(key);
			}),
	};
};

export const makeDomainJoiningSql = (
	sql: SqlClient.SqlClient,
): DomainJoiningStore => {
	const durable = <A>(effect: Effect.Effect<A, unknown>) =>
		effect.pipe(Effect.orDie);
	const decode = <A, I>(
		schema: Schema.Codec<A, I>,
		rows: ReadonlyArray<{ data: unknown }>,
	) => rows.map((r) => Schema.decodeUnknownSync(schema)(r.data));
	return {
		getDomain: (domain) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_organization_domains WHERE domain=${domain}`.pipe(
					Effect.map((rows) => decode(OrganizationDomain, rows)[0] ?? null),
				),
			),
		listDomains: (organizationId) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_organization_domains WHERE organization_id=${organizationId} ORDER BY domain`.pipe(
					Effect.map((rows) => decode(OrganizationDomain, rows)),
				),
			),
		claimDomain: (d) =>
			durable(
				sql`INSERT INTO api_organization_domains (domain, organization_id, data) VALUES (${d.domain}, ${d.organizationId}, ${JSON.stringify(d)}::jsonb) ON CONFLICT (domain) DO UPDATE SET organization_id=EXCLUDED.organization_id, data=EXCLUDED.data WHERE api_organization_domains.organization_id <> EXCLUDED.organization_id AND COALESCE((api_organization_domains.data->>'verified')::boolean, false) = false`.pipe(
					Effect.andThen(
						sql<{
							organization_id: string;
						}>`SELECT organization_id FROM api_organization_domains WHERE domain=${d.domain}`,
					),
					Effect.map((rows) => rows[0]?.organization_id === d.organizationId),
				),
			),
		saveDomain: (d) =>
			durable(
				sql`UPDATE api_organization_domains SET data=${JSON.stringify(d)}::jsonb WHERE domain=${d.domain} AND organization_id=${d.organizationId}`.pipe(
					Effect.asVoid,
				),
			),
		removeDomain: (organizationId, domain) =>
			durable(
				sql`DELETE FROM api_organization_domains WHERE domain=${domain} AND organization_id=${organizationId}`.pipe(
					Effect.asVoid,
				),
			),
		getEnrollment: (org, account) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_organization_domain_enrollments WHERE organization_id=${org} AND account_id=${account}`.pipe(
					Effect.map((rows) => decode(DomainEnrollment, rows)[0] ?? null),
				),
			),
		listEnrollments: (org) =>
			durable(
				sql<{
					data: unknown;
				}>`SELECT data FROM api_organization_domain_enrollments WHERE organization_id=${org}`.pipe(
					Effect.map((rows) => decode(DomainEnrollment, rows)),
				),
			),
		saveEnrollment: (e) =>
			durable(
				sql`INSERT INTO api_organization_domain_enrollments (organization_id, account_id, data) VALUES (${e.organizationId}, ${e.accountId}, ${JSON.stringify(e)}::jsonb) ON CONFLICT (organization_id, account_id) DO UPDATE SET data=EXCLUDED.data`.pipe(
					Effect.asVoid,
				),
			),
		deleteAccount: (account) =>
			durable(
				sql`DELETE FROM api_organization_domain_enrollments WHERE account_id=${account}`.pipe(
					Effect.asVoid,
				),
			),
	};
};
