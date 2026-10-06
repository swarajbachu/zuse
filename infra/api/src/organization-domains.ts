import {
	ApiPaths,
	OrganizationDomainInput,
	OrganizationGithubInput,
	OrganizationGithubRestoreInput,
} from "@zuse/contracts";
import { Effect } from "effect";
import { requireWorkos } from "./auth.ts";
import { ApiConfiguration } from "./config.ts";
import { conflict, forbidden, notFound } from "./errors.ts";
import { decodeBody, json } from "./http.ts";
import {
	admitOrganizationMember,
	membershipsFor,
	organizationSeatsFull,
	requestWorkos,
	WorkosUser,
} from "./organization-workos.ts";
import { requireOrganizationMember } from "./organizations.ts";
import { ApiStore } from "./store.ts";

/** Shared mailbox providers: owning an address there proves nothing about a team. */
const PUBLIC_EMAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"msn.com",
	"yahoo.com",
	"ymail.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"pm.me",
	"gmx.com",
	"gmx.net",
	"mail.com",
	"zoho.com",
	"yandex.com",
	"yandex.ru",
	"qq.com",
	"163.com",
	"126.com",
	"naver.com",
	"hey.com",
	"fastmail.com",
	"tutanota.com",
]);

/** The team domain an account's verified email proves, if any. */
const verifiedTeamDomain = Effect.fn("verifiedTeamDomain")(function* (
	accountId: string,
) {
	const user = yield* requestWorkos(
		`/user_management/users/${encodeURIComponent(accountId)}`,
		WorkosUser,
	);
	const domain = user.email.split("@")[1]?.trim().toLowerCase();
	return user.email_verified === true &&
		domain !== undefined &&
		domain.length > 0 &&
		!PUBLIC_EMAIL_DOMAINS.has(domain)
		? domain
		: null;
});

/**
 * Join the organization that owns this account's verified email domain. Admin removal blocks rejoining; a manually
 * removed member who never auto-joined is not re-added.
 */
export const syncDomainAutoJoin = Effect.fn("syncDomainAutoJoin")(function* (
	accountId: string,
) {
	const domain = yield* verifiedTeamDomain(accountId);
	if (domain === null) return [];
	const store = yield* ApiStore;
	const owner = yield* store.domainJoining.getDomain(domain);
	if (!owner) return [];
	const organizationId = owner.organizationId;
	const joined = yield* store.withOrganizationLock(
		organizationId,
		Effect.gen(function* () {
			const enrollment = yield* store.domainJoining.getEnrollment(
				organizationId,
				accountId,
			);
			if (enrollment?.blocked) return false;
			const memberships = yield* membershipsFor(accountId, organizationId);
			if (memberships.some((m) => m.status === "active")) return false;
			if (!enrollment && memberships.length > 0) return false;
			if (yield* organizationSeatsFull(organizationId, accountId)) return false;
			// Record provenance first so a lost WorkOS response still lets an
			// admin removal block rejoining.
			const pending = {
				organizationId,
				accountId,
				domain,
				memberId: enrollment?.memberId ?? null,
				blocked: false,
			};
			yield* store.domainJoining.saveEnrollment(pending);
			const member = yield* admitOrganizationMember(
				organizationId,
				accountId,
				memberships,
			);
			yield* store.domainJoining.saveEnrollment({
				...pending,
				memberId: member.id,
			});
			return true;
		}),
	);
	return joined ? [organizationId] : [];
});

export const routeOrganizationDomainRequest = Effect.fn(
	"routeOrganizationDomainRequest",
)(function* (request: Request) {
	const url = new URL(request.url);
	if (
		url.pathname !== ApiPaths.organizationDomains &&
		!url.pathname.startsWith(`${ApiPaths.organizationDomains}/`)
	)
		return null;
	if (!(yield* ApiConfiguration).organizationWorkspacesEnabled)
		return yield* forbidden("organization_workspaces_disabled");
	const { accountId } = yield* requireWorkos(request);
	if (request.method !== "POST") return yield* notFound();
	const domains = (yield* ApiStore).domainJoining;

	if (url.pathname === ApiPaths.organizationDomains) {
		const { organizationId } = yield* decodeBody(
			OrganizationGithubInput,
			request,
		);
		yield* requireOrganizationMember(accountId, organizationId, true);
		const owned = yield* domains.listDomains(organizationId);
		const own = yield* verifiedTeamDomain(accountId);
		const suggestedDomain =
			own !== null && (yield* domains.getDomain(own)) === null ? own : null;
		const blockedMembers = yield* Effect.forEach(
			(yield* domains.listEnrollments(organizationId)).filter((e) => e.blocked),
			(e) =>
				requestWorkos(
					`/user_management/users/${encodeURIComponent(e.accountId)}`,
					WorkosUser,
				).pipe(
					Effect.map((user) => ({
						accountId: e.accountId,
						displayName: user.email,
					})),
				),
			{ concurrency: 4 },
		);
		return json({
			domains: owned.map((d) => d.domain),
			suggestedDomain,
			blockedMembers,
		});
	}
	if (url.pathname === ApiPaths.organizationDomainAdd) {
		const input = yield* decodeBody(OrganizationDomainInput, request);
		yield* requireOrganizationMember(accountId, input.organizationId, true);
		const existing = yield* domains.getDomain(input.domain);
		if (existing?.organizationId === input.organizationId)
			return json({ ok: true });
		if (existing) return yield* conflict("organization_domain_claimed");
		// An admin can only add the domain their own verified email proves.
		if ((yield* verifiedTeamDomain(accountId)) !== input.domain)
			return yield* forbidden("organization_domain_unverified");
		if (
			!(yield* domains.claimDomain({
				domain: input.domain,
				organizationId: input.organizationId,
				createdBy: accountId,
			}))
		)
			return yield* conflict("organization_domain_claimed");
		return json({ ok: true });
	}
	if (url.pathname === ApiPaths.organizationDomainRemove) {
		const input = yield* decodeBody(OrganizationDomainInput, request);
		yield* requireOrganizationMember(accountId, input.organizationId, true);
		yield* domains.removeDomain(input.organizationId, input.domain);
		return json({ ok: true });
	}
	if (url.pathname === ApiPaths.organizationDomainRestore) {
		const input = yield* decodeBody(OrganizationGithubRestoreInput, request);
		yield* requireOrganizationMember(accountId, input.organizationId, true);
		const enrollment = yield* domains.getEnrollment(
			input.organizationId,
			input.accountId,
		);
		if (!enrollment) return yield* notFound();
		yield* domains.saveEnrollment({ ...enrollment, blocked: false });
		return json({ ok: true });
	}
	return yield* notFound();
});
