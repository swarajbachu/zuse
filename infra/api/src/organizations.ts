import {
	ApiPaths,
	ChatSharingDefaults,
	ORGANIZATION_MEMBER_LIMIT,
	Organization,
	OrganizationCreateInput,
	OrganizationDetails,
	OrganizationInvitation,
	OrganizationInviteInput,
	OrganizationMember,
	OrganizationMemberInput,
	OrganizationRevokeInviteInput,
	OrganizationRole,
	OrganizationRoleInput,
} from "@zuse/contracts";
import { Clock, Effect, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { ApiConfiguration } from "./config.ts";
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { requireGithubEnrollment } from "./github-membership.ts";
import { decodeBody, json } from "./http.ts";
import {
	listWorkos,
	organizationSeatsFull,
	requestWorkos,
	reservesSeat,
	WorkosInvitation,
	WorkosMember,
	WorkosOrganization,
	WorkosUser,
} from "./organization-workos.ts";
import { ApiStore } from "./store.ts";

/** Resolve display identity only after the caller has verified membership. */
export const getOrganizationName = Effect.fn("getOrganizationName")(function* (
	organizationId: string,
) {
	const organization = yield* requestWorkos(
		`/organizations/${encodeURIComponent(organizationId)}`,
		WorkosOrganization,
	);
	return organization.name;
});

const sharingDefaults = Effect.fn("organizationSharingDefaults")(function* (
	organization: typeof WorkosOrganization.Type,
) {
	const encoded = organization.metadata?.zuse_chat_sharing;
	if (encoded === undefined)
		return { audience: "organization", permission: "edit" } as const;
	return yield* Effect.try({
		try: () =>
			Schema.decodeUnknownSync(ChatSharingDefaults)(JSON.parse(encoded)),
		catch: () => serviceUnavailable("organization_sharing_defaults_invalid"),
	});
});

/** Callers establish workspace membership; defaults are copied only when creating a chat. */
export const getOrganizationSharingDefaults = Effect.fn(
	"getOrganizationSharingDefaults",
)(function* (organizationId: string) {
	return yield* sharingDefaults(
		yield* requestWorkos(
			`/organizations/${encodeURIComponent(organizationId)}`,
			WorkosOrganization,
		),
	);
});

export const setOrganizationSharingDefaults = Effect.fn(
	"setOrganizationSharingDefaults",
)(function* (
	actorId: string,
	organizationId: string,
	defaults: ChatSharingDefaults,
) {
	const store = yield* ApiStore;
	return yield* store.withOrganizationLock(
		organizationId,
		Effect.gen(function* () {
			yield* requireOrganizationMember(actorId, organizationId, true);
			const path = `/organizations/${encodeURIComponent(organizationId)}`;
			const organization = yield* requestWorkos(path, WorkosOrganization);
			const updated = yield* requestWorkos(path, WorkosOrganization, "PUT", {
				metadata: {
					...organization.metadata,
					zuse_chat_sharing: JSON.stringify(defaults),
				},
			});
			return yield* sharingDefaults(updated);
		}),
	);
});
export const requireOrganizationMembership = Effect.fn(
	"requireOrganizationMembership",
)(function* (accountId: string, organizationId: string) {
	const memberships = yield* listWorkos(
		`/user_management/organization_memberships?user_id=${encodeURIComponent(accountId)}&organization_id=${encodeURIComponent(organizationId)}`,
		WorkosMember,
	);
	const member = memberships.find(
		(m) =>
			m.user_id === accountId &&
			m.organization_id === organizationId &&
			m.status === "active",
	);
	if (member === undefined)
		return yield* forbidden("organization_access_denied");
	const githubManaged = yield* requireGithubEnrollment(
		accountId,
		organizationId,
		member.id,
	);
	if (githubManaged && member.role.slug !== "member")
		return yield* forbidden("organization_access_denied");
	return member;
});

export const requireOrganizationMember = Effect.fn("requireOrganizationMember")(
	function* (accountId: string, organizationId: string, admin = false) {
		const member = yield* requireOrganizationMembership(
			accountId,
			organizationId,
		);
		if (
			member.role.slug !== "admin" &&
			(admin || member.role.slug !== "member")
		)
			return yield* forbidden("organization_access_denied");
		return member;
	},
);

/** Validate named chat grants against live membership, never caller-supplied subjects. */
export const validateOrganizationChatGrants = Effect.fn(
	"validateOrganizationChatGrants",
)(function* (organizationId: string, membershipIds: ReadonlyArray<string>) {
	if (
		membershipIds.length > ORGANIZATION_MEMBER_LIMIT ||
		new Set(membershipIds).size !== membershipIds.length
	)
		return yield* badRequest("invalid_chat_grants");
	if (membershipIds.length === 0) return;
	const members = yield* listWorkos(
		`/user_management/organization_memberships?organization_id=${encodeURIComponent(organizationId)}`,
		WorkosMember,
	);
	if (
		!membershipIds.every((id) =>
			members.some(
				(member) =>
					member.id === id &&
					member.organization_id === organizationId &&
					member.status === "active" &&
					(member.role.slug === "admin" || member.role.slug === "member"),
			),
		)
	)
		return yield* badRequest("invalid_chat_grants");
});

const invitation = (value: typeof WorkosInvitation.Type) =>
	OrganizationInvitation.make({
		id: value.id,
		email: value.email,
		state: value.state,
		expiresAt: value.expires_at,
	});

export const routeOrganizationRequest = Effect.fn("routeOrganizationRequest")(
	function* (request: Request) {
		const path = new URL(request.url).pathname;
		if (
			path !== ApiPaths.organizations &&
			!path.startsWith(`${ApiPaths.organizations}/`)
		)
			return null;
		if (!(yield* ApiConfiguration).organizationWorkspacesEnabled)
			return yield* forbidden("organization_workspaces_disabled");
		const principal = yield* requireWorkos(request);
		const userId = principal.accountId;
		const method = request.method;

		if (path === ApiPaths.organizations && method === "GET") {
			const memberships = yield* listWorkos(
				`/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}`,
				WorkosMember,
			);
			const authorizedMemberships = yield* Effect.filter(
				memberships.filter(
					(m) =>
						m.user_id === userId &&
						m.status === "active" &&
						Schema.is(OrganizationRole)(m.role.slug),
				),
				(member) =>
					requireGithubEnrollment(
						userId,
						member.organization_id,
						member.id,
					).pipe(
						Effect.map((managed) => !managed || member.role.slug === "member"),
						Effect.catch((error) =>
							error.status === 403 ? Effect.succeed(false) : Effect.fail(error),
						),
					),
				{ concurrency: 4 },
			);
			const organizations = yield* Effect.forEach(
				authorizedMemberships,
				(member) =>
					requestWorkos(
						`/organizations/${encodeURIComponent(member.organization_id)}`,
						WorkosOrganization,
					).pipe(
						Effect.map((org) =>
							Organization.make({
								id: org.id,
								name: org.name,
								role: Schema.decodeUnknownSync(OrganizationRole)(
									member.role.slug,
								),
								isCreator: org.metadata?.zuse_creator === userId,
							}),
						),
					),
				{ concurrency: 4 },
			);
			return json(organizations);
		}
		if (path === ApiPaths.organizations && method === "POST") {
			const input = yield* decodeBody(OrganizationCreateInput, request);
			if (input.name.trim().length === 0)
				return yield* badRequest("organization_name_required");
			const store = yield* ApiStore;
			return yield* store.withOrganizationLock(
				`creator:${userId}`,
				Effect.gen(function* () {
					// A retry can finish initial enrollment, but cannot re-enroll a removed admin.
					// One durable provider identity per creator also covers failed enrollment.
					const externalId = `zuse:${userId}:organization`;
					const find = requestWorkos(
						`/organizations/external_id/${encodeURIComponent(externalId)}`,
						WorkosOrganization,
					);
					let org = yield* find.pipe(
						Effect.catch((error) =>
							error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
						),
					);
					if (org === null) {
						// Respect organizations created by earlier versions as well as invited teams.
						const memberships = yield* listWorkos(
							`/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}`,
							WorkosMember,
						);
						for (const membership of memberships) {
							const existing = yield* requestWorkos(
								`/organizations/${encodeURIComponent(membership.organization_id)}`,
								WorkosOrganization,
							);
							if (existing.metadata?.zuse_creator === userId)
								return yield* conflict("organization_limit_reached");
						}
						org = yield* requestWorkos(
							"/organizations",
							WorkosOrganization,
							"POST",
							{
								name: input.name.trim(),
								external_id: externalId,
								metadata: {
									zuse_creator: userId,
									zuse_setup: "pending",
									zuse_creation_operation: input.operationId,
								},
							},
						).pipe(
							Effect.catch((error) =>
								error.status === 409 ? find : Effect.fail(error),
							),
						);
					}
					if (org.metadata?.zuse_creator !== userId)
						return yield* forbidden("organization_access_denied");
					if (
						org.metadata.zuse_setup === "complete" &&
						org.metadata.zuse_creation_operation !== input.operationId
					)
						return yield* conflict("organization_limit_reached");
					if (org.metadata.zuse_setup === "pending") {
						const memberships = yield* listWorkos(
							`/user_management/organization_memberships?organization_id=${encodeURIComponent(org.id)}&user_id=${encodeURIComponent(userId)}`,
							WorkosMember,
						);
						if (memberships.length === 0) {
							yield* requestWorkos(
								"/user_management/organization_memberships",
								WorkosMember,
								"POST",
								{
									organization_id: org.id,
									user_id: userId,
									role_slug: "admin",
								},
							).pipe(
								Effect.catch((error) =>
									error.status === 409
										? requireOrganizationMember(userId, org.id, true)
										: Effect.fail(error),
								),
							);
						}
						yield* requireOrganizationMember(userId, org.id, true);
						const organizationId = org.id;
						// Creation and sharing defaults must serialize metadata writes on
						// the same organization key, using the latest provider snapshot.
						yield* store.withOrganizationLock(
							organizationId,
							Effect.gen(function* () {
								const path = `/organizations/${encodeURIComponent(organizationId)}`;
								const current = yield* requestWorkos(path, WorkosOrganization);
								yield* requestWorkos(path, WorkosOrganization, "PUT", {
									metadata: { ...current.metadata, zuse_setup: "complete" },
								});
							}),
						);
					}
					const member = yield* requireOrganizationMember(userId, org.id);
					return json(
						Organization.make({
							id: org.id,
							name: org.name,
							role: member.role.slug === "admin" ? "admin" : "member",
							isCreator: true,
						}),
					);
				}),
			);
		}
		if (path === ApiPaths.organizationDetails && method === "POST") {
			const { organizationId } = yield* decodeBody(
				Schema.Struct({ organizationId: Organization.fields.id }),
				request,
			);
			const current = yield* requireOrganizationMember(userId, organizationId);
			const org = yield* requestWorkos(
				`/organizations/${encodeURIComponent(organizationId)}`,
				WorkosOrganization,
			);
			const roster = yield* listWorkos(
				`/user_management/organization_memberships?organization_id=${encodeURIComponent(organizationId)}`,
				WorkosMember,
			);
			const members = yield* Effect.forEach(
				roster.filter(
					(m) => m.organization_id === organizationId && m.status === "active",
				),
				(member) =>
					Effect.gen(function* () {
						const user = yield* requestWorkos(
							`/user_management/users/${encodeURIComponent(member.user_id)}`,
							WorkosUser,
						);
						return OrganizationMember.make({
							id: member.id,
							userId: member.user_id,
							email: user.email,
							displayName:
								[user.first_name, user.last_name].filter(Boolean).join(" ") ||
								user.email,
							role: member.role.slug,
							directoryManaged: member.directory_managed ?? false,
							...(user.profile_picture_url
								? { profilePictureUrl: user.profile_picture_url }
								: {}),
							githubManaged:
								(yield* (yield* ApiStore).githubJoining.getEnrollment(
									organizationId,
									member.user_id,
								)) !== null,
						});
					}),
				{ concurrency: 4 },
			);
			const invitations =
				current.role.slug === "admin"
					? yield* listWorkos(
							`/user_management/invitations?organization_id=${encodeURIComponent(organizationId)}`,
							WorkosInvitation,
						)
					: [];
			const now = yield* Clock.currentTimeMillis;
			return json(
				OrganizationDetails.make({
					organization: Organization.make({
						id: org.id,
						name: org.name,
						role: current.role.slug === "admin" ? "admin" : "member",
					}),
					currentUserId: userId,
					members,
					invitations: invitations
						.filter((i) => reservesSeat(i, organizationId, now))
						.map(invitation),
				}),
			);
		}
		if (path === ApiPaths.organizationInvite && method === "POST") {
			const input = yield* decodeBody(OrganizationInviteInput, request);
			const store = yield* ApiStore;
			return yield* store.withOrganizationLock(
				input.organizationId,
				Effect.gen(function* () {
					yield* requireOrganizationMember(userId, input.organizationId, true);
					if (yield* organizationSeatsFull(input.organizationId))
						return yield* conflict("organization_member_limit_reached");
					const result = yield* requestWorkos(
						"/user_management/invitations",
						WorkosInvitation,
						"POST",
						{
							organization_id: input.organizationId,
							email: input.email.trim().toLowerCase(),
							role_slug: input.role,
							inviter_user_id: userId,
							expires_in_days: 7,
						},
					);
					return json(invitation(result));
				}),
			);
		}
		if (path === ApiPaths.organizationRevokeInvite && method === "POST") {
			const input = yield* decodeBody(OrganizationRevokeInviteInput, request);
			yield* requireOrganizationMember(userId, input.organizationId, true);
			const target = yield* requestWorkos(
				`/user_management/invitations/${encodeURIComponent(input.invitationId)}`,
				WorkosInvitation,
			);
			if (target.organization_id !== input.organizationId)
				return yield* forbidden("organization_access_denied");
			if (target.state === "pending")
				yield* requestWorkos(
					`/user_management/invitations/${encodeURIComponent(input.invitationId)}/revoke`,
					WorkosInvitation,
					"POST",
				);
			return json({ ok: true });
		}
		if (
			(path === ApiPaths.organizationSetRole ||
				path === ApiPaths.organizationRemoveMember) &&
			method === "POST"
		) {
			const removing = path === ApiPaths.organizationRemoveMember;
			const input = yield* decodeBody(
				removing ? OrganizationMemberInput : OrganizationRoleInput,
				request,
			);
			const store = yield* ApiStore;
			// Commit the self-service block before the external removal. If its
			// response is lost, authorization still denies the removed member.
			if (removing)
				yield* store.withOrganizationLock(
					input.organizationId,
					Effect.gen(function* () {
						yield* requireOrganizationMember(
							userId,
							input.organizationId,
							true,
						);
						const target = yield* requestWorkos(
							`/user_management/organization_memberships/${encodeURIComponent(input.memberId)}`,
							WorkosMember,
						);
						if (target.organization_id !== input.organizationId)
							return yield* forbidden("organization_access_denied");
						if (target.directory_managed)
							return yield* conflict("organization_member_managed");
						const enrollment = yield* store.githubJoining.getEnrollment(
							input.organizationId,
							target.user_id,
						);
						if (enrollment)
							yield* store.githubJoining.saveEnrollment({
								...enrollment,
								blocked: true,
								reservedUntil: 0,
								revision: crypto.randomUUID(),
							});
						// Admin removal also stops email-domain auto-join from re-adding them.
						const domainEnrollment = yield* store.domainJoining.getEnrollment(
							input.organizationId,
							target.user_id,
						);
						if (domainEnrollment)
							yield* store.domainJoining.saveEnrollment({
								...domainEnrollment,
								blocked: true,
							});
					}),
				);
			return yield* store.withOrganizationLock(
				input.organizationId,
				Effect.gen(function* () {
					yield* requireOrganizationMember(userId, input.organizationId, true);
					const target = yield* requestWorkos(
						`/user_management/organization_memberships/${encodeURIComponent(input.memberId)}`,
						WorkosMember,
					);
					if (target.organization_id !== input.organizationId)
						return yield* forbidden("organization_access_denied");
					const enrollment = yield* store.githubJoining.getEnrollment(
						input.organizationId,
						target.user_id,
					);
					if (enrollment && !removing)
						return yield* conflict("organization_member_managed");
					if (target.directory_managed)
						return yield* conflict("organization_member_managed");
					if (
						target.role.slug === "admin" &&
						(removing || ("role" in input && input.role !== "admin"))
					) {
						const roster = yield* listWorkos(
							`/user_management/organization_memberships?organization_id=${encodeURIComponent(input.organizationId)}`,
							WorkosMember,
						);
						if (
							roster.filter(
								(member) =>
									member.organization_id === input.organizationId &&
									member.status === "active" &&
									member.role.slug === "admin",
							).length <= 1
						)
							return yield* conflict("organization_last_admin");
					}
					if (removing)
						yield* requestWorkos(
							`/user_management/organization_memberships/${encodeURIComponent(target.id)}`,
							Schema.Null,
							"DELETE",
						);
					else if ("role" in input)
						yield* requestWorkos(
							`/user_management/organization_memberships/${encodeURIComponent(target.id)}`,
							WorkosMember,
							"PUT",
							{ role_slug: input.role },
						);
					return json({ ok: true });
				}),
			);
		}
		return yield* notFound();
	},
);
