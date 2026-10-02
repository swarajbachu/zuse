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
import { Clock, Effect, Redacted, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { ApiConfiguration } from "./config.ts";
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { decodeBody, json } from "./http.ts";
import { ApiStore } from "./store.ts";

const WorkosOrganization = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

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
const WorkosMember = Schema.Struct({
	id: Schema.String,
	user_id: Schema.String,
	organization_id: Schema.String,
	status: Schema.String,
	role: Schema.Struct({ slug: Schema.String }),
	directory_managed: Schema.optional(Schema.Boolean),
});
const WorkosInvitation = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	organization_id: Schema.NullOr(Schema.String),
	state: OrganizationInvitation.fields.state,
	expires_at: Schema.String,
});
const WorkosUser = Schema.Struct({
	email: Schema.String,
	first_name: Schema.NullOr(Schema.String),
	last_name: Schema.NullOr(Schema.String),
});

/** Server-only WorkOS access. Provider bodies and invitation tokens never leave this boundary. */
const requestWorkos = <A, I>(
	path: string,
	schema: Schema.Codec<A, I>,
	method = "GET",
	body?: unknown,
) =>
	Effect.gen(function* () {
		const config = yield* ApiConfiguration;
		const apiKey = config.workosApiKey;
		if (apiKey === undefined)
			return yield* serviceUnavailable("organizations_not_configured");
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(`https://api.workos.com${path}`, {
					method,
					headers: {
						authorization: `Bearer ${Redacted.value(apiKey)}`,
						"content-type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
				}),
			catch: () => serviceUnavailable("organizations_unavailable"),
		});
		if (!response.ok) {
			if (response.status === 404)
				return yield* notFound("organization_resource_not_found");
			if (response.status === 409)
				return yield* conflict("organization_conflict");
			if (response.status === 400 || response.status === 422)
				return yield* badRequest("organization_invalid_request");
			return yield* serviceUnavailable("organizations_unavailable");
		}
		const payload =
			response.status === 204
				? null
				: yield* Effect.tryPromise({
						try: () => response.json(),
						catch: () => serviceUnavailable("organizations_invalid_response"),
					});
		return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
			Effect.mapError(() =>
				serviceUnavailable("organizations_invalid_response"),
			),
		);
	});

/** Follow provider cursors; never silently authorize against a truncated roster. */
const listWorkos = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
	Effect.gen(function* () {
		const rows: A[] = [];
		let after: string | null = null;
		const cursors = new Set<string>();
		do {
			const query: string = `${path}${path.includes("?") ? "&" : "?"}limit=100${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
			const page: {
				readonly data: ReadonlyArray<A>;
				readonly list_metadata: { readonly after: string | null };
			} = yield* requestWorkos(
				query,
				Schema.Struct({
					data: Schema.Array(schema),
					list_metadata: Schema.Struct({ after: Schema.NullOr(Schema.String) }),
				}),
			);
			rows.push(...page.data);
			after = page.list_metadata.after;
			if (after !== null) {
				if (cursors.has(after) || cursors.size >= 100)
					return yield* serviceUnavailable("organization_roster_too_large");
				cursors.add(after);
			}
		} while (after !== null);
		return rows;
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

const reservesSeat = (
	invite: typeof WorkosInvitation.Type,
	organizationId: string,
	now: number,
) =>
	invite.organization_id === organizationId &&
	invite.state === "pending" &&
	!(Date.parse(invite.expires_at) <= now);

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
		if (path === ApiPaths.organizationAuthorize && method === "POST") {
			const input = yield* decodeBody(
				Schema.Struct({
					organizationId: Organization.fields.id,
					subject: Organization.fields.id,
				}),
				request,
			);
			const caller = yield* requireOrganizationMember(
				userId,
				input.organizationId,
			);
			const target =
				input.subject === userId
					? caller
					: yield* requireOrganizationMember(
							input.subject,
							input.organizationId,
						);
			return json({ membershipId: target.id, role: target.role.slug });
		}
		if (path === ApiPaths.organizations && method === "GET") {
			const memberships = yield* listWorkos(
				`/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}`,
				WorkosMember,
			);
			const organizations = yield* Effect.forEach(
				memberships.filter(
					(m) =>
						m.user_id === userId &&
						m.status === "active" &&
						Schema.is(OrganizationRole)(m.role.slug),
				),
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
					const now = yield* Clock.currentTimeMillis;
					// Read invitations first: an acceptance between reads may temporarily
					// count twice, but must never leave an uncounted seat.
					const invites = yield* listWorkos(
						`/user_management/invitations?organization_id=${encodeURIComponent(input.organizationId)}`,
						WorkosInvitation,
					);
					const roster = yield* listWorkos(
						`/user_management/organization_memberships?organization_id=${encodeURIComponent(input.organizationId)}`,
						WorkosMember,
					);
					const occupied = new Set(
						roster
							.filter(
								(member) =>
									member.organization_id === input.organizationId &&
									member.status === "active",
							)
							.map((member) => member.user_id),
					).size;
					const reserved = invites.filter((invite) =>
						reservesSeat(invite, input.organizationId, now),
					).length;
					if (occupied + reserved >= ORGANIZATION_MEMBER_LIMIT)
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
