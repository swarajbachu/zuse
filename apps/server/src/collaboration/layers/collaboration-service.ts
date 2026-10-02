import { randomUUID } from "node:crypto";
import {
	ActorIdentity,
	type AuditEventId,
	type ChatId,
	CollaborationAccessDeniedError,
	type CollaborationAuditAction,
	CollaborationAuditEvent,
	CollaborationNotFoundError,
	type CollaborationRole,
	type EnvironmentSharingAudience,
	FolderId,
	type OrganizationDetails,
	Team,
	type TeamId,
	TeamMember,
	type TeamMemberId,
	WorkspaceGrant,
} from "@zuse/contracts";
import { Effect, Layer, PubSub } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	type CollaborationAccessRevocation,
	CollaborationService,
} from "../services/collaboration-service.ts";
import {
	OrganizationAuthority,
	organizationCollaborationRole,
} from "../services/organization-authority.ts";
import { WorkspaceSharingAuthority } from "../services/workspace-sharing-authority.ts";

interface MemberRow {
	readonly id: string;
	readonly team_id: string;
	readonly subject: string;
	readonly organization_membership_id: string | null;
	readonly email: string;
	readonly display_name: string;
	readonly avatar_url: string | null;
	readonly role: CollaborationRole;
	readonly status: "active" | "revoked";
	readonly joined_at: string;
	readonly updated_at: string;
}

interface GrantRow {
	readonly team_id: string;
	readonly chat_id: string;
	readonly member_id: string;
	readonly role: CollaborationRole;
	readonly granted_by_member_id: string;
	readonly created_at: string;
	readonly updated_at: string;
}

interface AuditRow {
	readonly id: string;
	readonly team_id: string;
	readonly actor_member_id: string | null;
	readonly action: CollaborationAuditAction;
	readonly resource_kind: string;
	readonly resource_id: string;
	readonly metadata_json: string;
	readonly created_at: string;
}

const asMember = (row: MemberRow): TeamMember =>
	TeamMember.make({
		id: row.id as TeamMemberId,
		teamId: row.team_id as TeamId,
		subject: row.subject,
		email: row.email,
		displayName: row.display_name,
		avatarUrl: row.avatar_url,
		role: row.role,
		status: row.status,
		joinedAt: new Date(row.joined_at),
		updatedAt: new Date(row.updated_at),
	});

const asActor = (member: TeamMember): ActorIdentity =>
	ActorIdentity.make({
		memberId: member.id,
		teamId: member.teamId,
		subject: member.subject,
		email: member.email,
		displayName: member.displayName,
		avatarUrl: member.avatarUrl,
	});

const asGrant = (row: GrantRow): WorkspaceGrant =>
	WorkspaceGrant.make({
		teamId: row.team_id as TeamId,
		chatId: row.chat_id as ChatId,
		memberId: row.member_id as TeamMemberId,
		role: row.role,
		grantedByMemberId: row.granted_by_member_id as TeamMemberId,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	});

const asAudit = (row: AuditRow): CollaborationAuditEvent => {
	let metadata: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(row.metadata_json) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
		) {
			metadata = parsed as Record<string, unknown>;
		}
	} catch {
		metadata = { decodeError: true };
	}
	return CollaborationAuditEvent.make({
		id: row.id as AuditEventId,
		teamId: row.team_id as TeamId,
		actorMemberId:
			row.actor_member_id === null
				? null
				: (row.actor_member_id as TeamMemberId),
		action: row.action,
		resourceKind: row.resource_kind,
		resourceId: row.resource_id,
		metadata,
		createdAt: new Date(row.created_at),
	});
};

const roleRank: Readonly<Record<CollaborationRole, number>> = {
	viewer: 0,
	driver: 1,
	owner: 2,
};

const denied = (reason: string) =>
	new CollaborationAccessDeniedError({ reason });

const normalizedEmail = (email: string): string => email.trim().toLowerCase();
export const CollaborationServiceLive = Layer.effect(
	CollaborationService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const revocations =
			yield* PubSub.unbounded<CollaborationAccessRevocation>();
		const catalogChanges = yield* PubSub.unbounded<void>();
		const notifyCatalogChange = PubSub.publish(catalogChanges, undefined).pipe(
			Effect.asVoid,
		);
		const notifyRevocation = (event: CollaborationAccessRevocation) =>
			PubSub.publish(revocations, event).pipe(
				Effect.andThen(notifyCatalogChange),
			);
		const sharingAuthority = yield* WorkspaceSharingAuthority;
		const organizationAuthority = yield* Effect.serviceOption(
			OrganizationAuthority,
		);

		const readMember = (memberId: TeamMemberId) =>
			Effect.gen(function* () {
				const rows = yield* sql<MemberRow>`
					SELECT * FROM collaboration_members WHERE id = ${memberId} LIMIT 1
				`;
				return rows[0] === undefined ? null : asMember(rows[0]);
			});

		const validateActor = (
			actor: ActorIdentity,
			minimum: CollaborationRole,
			verifyOrganization = true,
		) =>
			Effect.gen(function* () {
				const member = yield* readMember(actor.memberId);
				if (
					member === null ||
					member.status !== "active" ||
					member.teamId !== actor.teamId ||
					member.subject !== actor.subject ||
					roleRank[member.role] < roleRank[minimum]
				) {
					return yield* Effect.fail(denied("actor_not_authorized"));
				}
				const teams = yield* sql<{
					readonly organization_id: string | null;
					readonly organization_membership_id: string | null;
				}>`SELECT t.organization_id, m.organization_membership_id FROM collaboration_teams t
					JOIN collaboration_members m ON m.team_id = t.id
					WHERE t.id = ${actor.teamId} AND m.id = ${actor.memberId}`;
				const organizationId = teams[0]?.organization_id;
				if (
					verifyOrganization &&
					organizationId !== null &&
					organizationId !== undefined
				) {
					if (organizationAuthority._tag === "None")
						return yield* denied("organization_authority_unavailable");
					const membership = yield* organizationAuthority.value.membership(
						organizationId,
						actor.subject,
					);
					if (membership.membershipId !== teams[0]?.organization_membership_id)
						return yield* denied("organization_membership_changed");
					const role = membership.role;
					if (roleRank[role] < roleRank[minimum])
						return yield* denied("actor_not_authorized");
					return roleRank[role] < roleRank[member.role]
						? TeamMember.make({ ...member, role })
						: member;
				}
				return member;
			});

		const appendAudit = (input: {
			readonly teamId: TeamId;
			readonly actorMemberId: TeamMemberId | null;
			readonly action: CollaborationAuditAction;
			readonly resourceKind: string;
			readonly resourceId: string;
			readonly metadata?: Record<string, unknown>;
		}) => {
			const id = randomUUID() as AuditEventId;
			const createdAt = new Date().toISOString();
			return sql`
				INSERT INTO collaboration_audit_events
					(id, team_id, actor_member_id, action, resource_kind, resource_id,
					 metadata_json, created_at)
				VALUES (${id}, ${input.teamId}, ${input.actorMemberId}, ${input.action},
					${input.resourceKind}, ${input.resourceId},
					${JSON.stringify(input.metadata ?? {})}, ${createdAt})
			`;
		};

		const resolveActor = (teamId: TeamId, subject: string) =>
			Effect.gen(function* () {
				const rows = yield* sql<MemberRow>`
					SELECT * FROM collaboration_members
					WHERE team_id = ${teamId} AND subject = ${subject} AND status = 'active'
					LIMIT 1
				`;
				if (rows[0] === undefined) {
					return yield* Effect.fail(denied("membership_not_active"));
				}
				return asActor(asMember(rows[0]));
			});

		const synchronizeOrganization = (details: OrganizationDetails) =>
			sql.withTransaction(
				Effect.gen(function* () {
					const current = details.members.find(
						(member) => member.userId === details.currentUserId,
					);
					if (
						current === undefined ||
						new Set(details.members.map((member) => member.userId)).size !==
							details.members.length
					)
						return yield* denied("organization_roster_invalid");
					const now = new Date().toISOString();
					const existing = yield* sql<{
						readonly id: string;
						readonly name: string;
						readonly created_at: string;
					}>`SELECT id, name, created_at FROM collaboration_teams WHERE organization_id = ${details.organization.id}`;
					const teamId = (existing[0]?.id ?? randomUUID()) as TeamId;
					const createdAt = existing[0]?.created_at ?? now;
					yield* sql`INSERT INTO collaboration_teams (id, name, organization_id, created_at, updated_at)
				VALUES (${teamId}, ${details.organization.name}, ${details.organization.id}, ${createdAt}, ${now})
				ON CONFLICT (organization_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`;
					const previous =
						yield* sql<MemberRow>`SELECT * FROM collaboration_members WHERE team_id = ${teamId}`;
					const previousBySubject = new Map(
						previous.map((member) => [member.subject, member]),
					);
					let changed = existing[0]?.name !== details.organization.name;
					const revokedMemberIds: TeamMemberId[] = [];
					const incoming = new Set(
						details.members
							.filter(
								(member) => organizationCollaborationRole(member.role) !== null,
							)
							.map((member) => member.userId),
					);
					for (const member of previous) {
						if (incoming.has(member.subject) || member.status === "revoked")
							continue;
						changed = true;
						revokedMemberIds.push(member.id as TeamMemberId);
						yield* sql`UPDATE collaboration_members SET status = 'revoked', updated_at = ${now} WHERE id = ${member.id}`;
						yield* sql`DELETE FROM collaboration_chat_grants WHERE member_id = ${member.id}`;
					}
					for (const member of details.members) {
						const old = previousBySubject.get(member.userId);
						const role = organizationCollaborationRole(member.role);
						if (role === null) continue;
						const memberId = old?.id ?? randomUUID();
						const membershipChanged =
							old?.organization_membership_id !== member.id;
						changed ||=
							old === undefined ||
							old.status !== "active" ||
							membershipChanged ||
							old.role !== role ||
							old.email !== normalizedEmail(member.email) ||
							old.display_name !== member.displayName;
						yield* sql`INSERT INTO collaboration_members (id, team_id, subject, organization_membership_id, email, display_name, avatar_url, role, status, joined_at, updated_at)
					VALUES (${memberId}, ${teamId}, ${member.userId}, ${member.id}, ${normalizedEmail(member.email)}, ${member.displayName}, NULL, ${role}, 'active', ${membershipChanged ? now : (old?.joined_at ?? now)}, ${now})
					ON CONFLICT (team_id, subject) DO UPDATE SET organization_membership_id = excluded.organization_membership_id, email = excluded.email, display_name = excluded.display_name, role = excluded.role, status = 'active', joined_at = excluded.joined_at, updated_at = excluded.updated_at`;
						if (
							old !== undefined &&
							(membershipChanged || roleRank[role] < roleRank[old.role])
						) {
							yield* sql`DELETE FROM collaboration_chat_grants WHERE member_id = ${memberId}`;
							revokedMemberIds.push(memberId as TeamMemberId);
						}
					}
					const actor = yield* resolveActor(teamId, details.currentUserId);
					if (changed)
						yield* appendAudit({
							teamId,
							actorMemberId: actor.memberId,
							action: "organization.synchronized",
							resourceKind: "organization",
							resourceId: details.organization.id,
						});
					return {
						team: Team.make({
							id: teamId,
							organizationId: details.organization.id,
							name: details.organization.name,
							createdAt: new Date(createdAt),
							updatedAt: new Date(now),
						}),
						actor,
						revokedMemberIds,
						changed,
					};
				}),
			);

		const listMembers = (actor: ActorIdentity) =>
			validateActor(actor, "viewer").pipe(
				Effect.andThen(
					sql<MemberRow>`
						SELECT * FROM collaboration_members
						WHERE team_id = ${actor.teamId}
						ORDER BY status, display_name COLLATE NOCASE, id
					`,
				),
				Effect.map((rows) => rows.map(asMember)),
			);

		const requireWorkspaceRole = (
			actor: ActorIdentity,
			chatId: ChatId,
			minimumRole: CollaborationRole,
		) =>
			Effect.gen(function* () {
				const member = yield* validateActor(actor, "viewer");
				const workspace = yield* sql<{
					readonly team_id: string;
				}>`SELECT team_id FROM collaboration_workspaces WHERE chat_id = ${chatId}`;
				if (workspace[0]?.team_id !== actor.teamId)
					return yield* denied("workspace_role_required");
				if (member.role === "owner") return null;
				const rows = yield* sql<GrantRow>`
					SELECT * FROM collaboration_chat_grants
					WHERE team_id = ${actor.teamId} AND chat_id = ${chatId}
						AND member_id = ${actor.memberId}
					LIMIT 1
				`;
				const row = rows[0];
				if (
					row === undefined ||
					roleRank[row.role] < roleRank[minimumRole] ||
					roleRank[member.role] < roleRank[minimumRole]
				) {
					return yield* Effect.fail(denied("workspace_role_required"));
				}
				return asGrant(row);
			});

		const shareWorkspace = Effect.fn("CollaborationService.shareWorkspace")(
			function* (actor: ActorIdentity, chatId: ChatId) {
				yield* sharingAuthority.authorize(actor.subject);
				yield* validateActor(actor, "owner");
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* validateActor(actor, "owner", false);
						const chats = yield* sql`SELECT id FROM chats WHERE id = ${chatId}`;
						if (chats.length === 0)
							return yield* new CollaborationNotFoundError({
								resource: "chat",
							});
						const workspace = yield* sql<{
							readonly team_id: string;
						}>`SELECT team_id FROM collaboration_workspaces WHERE chat_id = ${chatId}`;
						if (workspace[0] !== undefined) {
							if (workspace[0].team_id !== actor.teamId)
								return yield* denied("workspace_belongs_to_another_team");
							return;
						}
						yield* sql`INSERT INTO collaboration_workspaces (chat_id, team_id) VALUES (${chatId}, ${actor.teamId})`;
						yield* appendAudit({
							teamId: actor.teamId,
							actorMemberId: actor.memberId,
							action: "workspace.shared",
							resourceKind: "chat",
							resourceId: chatId,
						});
					}),
				);
			},
		);

		const unshareWorkspace = Effect.fn("CollaborationService.unshareWorkspace")(
			function* (actor: ActorIdentity, chatId: ChatId) {
				yield* sharingAuthority.authorize(actor.subject);
				yield* validateActor(actor, "owner");
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* validateActor(actor, "owner", false);
						const workspace = yield* sql<{
							readonly team_id: string;
						}>`SELECT team_id FROM collaboration_workspaces WHERE chat_id = ${chatId}`;
						if (workspace[0] === undefined) return;
						if (workspace[0].team_id !== actor.teamId)
							return yield* denied("workspace_belongs_to_another_team");
						yield* sql`DELETE FROM collaboration_workspaces WHERE chat_id = ${chatId} AND team_id = ${actor.teamId}`;
						yield* appendAudit({
							teamId: actor.teamId,
							actorMemberId: actor.memberId,
							action: "workspace.unshared",
							resourceKind: "chat",
							resourceId: chatId,
						});
					}),
				);
			},
		);

		const getWorkspaceSharing = Effect.fn(
			"CollaborationService.getWorkspaceSharing",
		)(function* (actor: ActorIdentity, chatId: ChatId) {
			yield* sharingAuthority.authorize(actor.subject);
			yield* validateActor(actor, "owner");
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* validateActor(actor, "owner", false);
					const chats = yield* sql`SELECT id FROM chats WHERE id = ${chatId}`;
					if (chats.length === 0)
						return yield* new CollaborationNotFoundError({ resource: "chat" });
					const workspace = yield* sql<{
						readonly team_id: string;
					}>`SELECT team_id FROM collaboration_workspaces WHERE chat_id = ${chatId}`;
					if (workspace[0] === undefined) return { shared: false, grants: [] };
					if (workspace[0].team_id !== actor.teamId)
						return yield* denied("workspace_belongs_to_another_team");
					const grants =
						yield* sql<GrantRow>`SELECT * FROM collaboration_chat_grants WHERE chat_id = ${chatId} AND team_id = ${actor.teamId} ORDER BY created_at, member_id`;
					return { shared: true, grants: grants.map(asGrant) };
				}),
			);
		});

		const setWorkspaceGrant = (
			actor: ActorIdentity,
			chatId: ChatId,
			memberId: TeamMemberId,
			role: CollaborationRole,
		) =>
			Effect.gen(function* () {
				yield* validateActor(actor, "owner");
				const chats = yield* sql<{ readonly id: string }>`
					SELECT id FROM chats WHERE id = ${chatId} LIMIT 1
				`;
				if (chats[0] === undefined) {
					return yield* Effect.fail(
						new CollaborationNotFoundError({ resource: "chat" }),
					);
				}
				const now = new Date().toISOString();
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* validateActor(actor, "owner", false);
						const target = yield* readMember(memberId);
						if (
							target === null ||
							target.teamId !== actor.teamId ||
							target.status !== "active"
						) {
							return yield* denied("grant_target_not_active");
						}
						if (roleRank[role] > roleRank[target.role]) {
							return yield* denied("grant_exceeds_team_role");
						}
						const workspace = yield* sql<{
							readonly team_id: string;
						}>`SELECT team_id FROM collaboration_workspaces WHERE chat_id = ${chatId}`;
						if (workspace[0] === undefined)
							return yield* denied("workspace_not_shared");
						if (workspace[0].team_id !== actor.teamId)
							return yield* denied("workspace_belongs_to_another_team");
						yield* sql`
							INSERT INTO collaboration_chat_grants
								(team_id, chat_id, member_id, role, granted_by_member_id,
								 created_at, updated_at)
							VALUES (${actor.teamId}, ${chatId}, ${memberId}, ${role},
								${actor.memberId}, ${now}, ${now})
							ON CONFLICT (chat_id, member_id) DO UPDATE SET
								role = excluded.role,
								granted_by_member_id = excluded.granted_by_member_id,
								updated_at = excluded.updated_at
						`;
						yield* appendAudit({
							teamId: actor.teamId,
							actorMemberId: actor.memberId,
							action: "workspace.grant_set",
							resourceKind: "chat",
							resourceId: chatId,
							metadata: { memberId, role },
						});
					}),
				);
				const rows = yield* sql<GrantRow>`
					SELECT * FROM collaboration_chat_grants
					WHERE team_id = ${actor.teamId} AND chat_id = ${chatId}
						AND member_id = ${memberId}
					LIMIT 1
				`;
				const saved = rows[0];
				if (saved === undefined) {
					return yield* Effect.fail(
						new CollaborationNotFoundError({ resource: "workspace_grant" }),
					);
				}
				return asGrant(saved);
			});

		const removeWorkspaceGrant = (
			actor: ActorIdentity,
			chatId: ChatId,
			memberId: TeamMemberId,
		) =>
			Effect.gen(function* () {
				yield* validateActor(actor, "owner");
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* validateActor(actor, "owner", false);
						yield* sql`
							DELETE FROM collaboration_chat_grants
							WHERE team_id = ${actor.teamId} AND chat_id = ${chatId}
								AND member_id = ${memberId}
						`;
						yield* appendAudit({
							teamId: actor.teamId,
							actorMemberId: actor.memberId,
							action: "workspace.grant_removed",
							resourceKind: "chat",
							resourceId: chatId,
							metadata: { memberId },
						});
					}),
				);
			});

		const listWorkspaceGrants = (actor: ActorIdentity, chatId: ChatId) =>
			Effect.gen(function* () {
				yield* requireWorkspaceRole(actor, chatId, "viewer");
				const rows = yield* sql<GrantRow>`
					SELECT * FROM collaboration_chat_grants
					WHERE team_id = ${actor.teamId} AND chat_id = ${chatId}
					ORDER BY created_at, member_id
				`;
				return rows.map(asGrant);
			});

		const listAuditEvents = (actor: ActorIdentity, limit = 100) =>
			Effect.gen(function* () {
				yield* validateActor(actor, "owner");
				const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
				const rows = yield* sql<AuditRow>`
					SELECT * FROM collaboration_audit_events
					WHERE team_id = ${actor.teamId}
					ORDER BY created_at DESC, id DESC
					LIMIT ${safeLimit}
				`;
				return rows.map(asAudit);
			});

		return CollaborationService.of({
			connectionAudience: sql<EnvironmentSharingAudience[number]>`
				SELECT DISTINCT t.organization_id AS "organizationId",
					m.organization_membership_id AS "membershipId", m.subject,
					(m.role = 'owner') AS "adminOnly"
				FROM collaboration_members m
				JOIN collaboration_teams t ON t.id = m.team_id
				JOIN collaboration_workspaces w ON w.team_id = m.team_id
				WHERE m.status = 'active' AND t.organization_id IS NOT NULL
					AND m.organization_membership_id IS NOT NULL
					AND (m.role = 'owner' OR EXISTS (
						SELECT 1 FROM collaboration_chat_grants g
						WHERE g.chat_id = w.chat_id AND g.member_id = m.id
					))
				ORDER BY t.organization_id, m.subject
				LIMIT 1001
			`.pipe(
				Effect.map((rows) =>
					rows.length > 1000
						? []
						: rows.map((row) => ({
								...row,
								adminOnly: Boolean(row.adminOnly),
							})),
				),
				Effect.catchTag("SqlError", Effect.die),
			),
			subscribeCatalogChanges: PubSub.subscribe(catalogChanges),
			visibleWorkspaces: (subject) =>
				Effect.gen(function* () {
					const members =
						yield* sql<MemberRow>`SELECT DISTINCT m.* FROM collaboration_members m
					JOIN collaboration_workspaces w ON w.team_id = m.team_id
					WHERE m.subject = ${subject} AND m.status = 'active'`;
					const groups = yield* Effect.forEach(
						members,
						(row) =>
							Effect.gen(function* () {
								const member = yield* validateActor(
									asActor(asMember(row)),
									"viewer",
								);
								// Recheck the projection after the network lookup; a concurrent
								// local revocation or membership replacement must win.
								const visible = yield* sql<{
									readonly chat_id: string;
									readonly project_id: string;
								}>`
						SELECT w.chat_id, c.project_id FROM collaboration_workspaces w
						JOIN chats c ON c.id = w.chat_id
						JOIN collaboration_members m ON m.team_id = w.team_id
						LEFT JOIN collaboration_chat_grants g ON g.team_id = w.team_id AND g.chat_id = w.chat_id AND g.member_id = m.id
						WHERE m.id = ${member.id} AND m.status = 'active'
						AND m.organization_membership_id IS ${row.organization_membership_id}
						AND ((${member.role === "owner"} AND m.role = 'owner') OR g.member_id IS NOT NULL)
						ORDER BY w.chat_id`;
								return visible.map((item) => ({
									chatId: item.chat_id as ChatId,
									projectId: FolderId.make(item.project_id),
								}));
							}).pipe(
								Effect.catchTag("CollaborationAccessDeniedError", () =>
									Effect.succeed([]),
								),
							),
						{ concurrency: 4 },
					);
					return groups.flat();
				}).pipe(Effect.catchTag("SqlError", Effect.die)),
			applyOrganizationMembershipRestriction: (input) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							const rows =
								yield* sql<MemberRow>`SELECT m.* FROM collaboration_members m
						JOIN collaboration_teams t ON t.id = m.team_id
						WHERE t.organization_id = ${input.organizationId}
						AND m.organization_membership_id = ${input.memberId} AND m.status = 'active'`;
							const member = rows[0];
							// Repeating a member role assignment must not erase a driver's grants.
							if (
								member === undefined ||
								(input.change === "demoted" && member.role !== "owner")
							)
								return null;
							const now = new Date().toISOString();
							yield* sql`UPDATE collaboration_members SET
						status = ${input.change === "removed" ? "revoked" : "active"},
						role = ${input.change === "demoted" ? "driver" : member.role}, updated_at = ${now}
						WHERE id = ${member.id}`;
							yield* sql`DELETE FROM collaboration_chat_grants WHERE member_id = ${member.id}`;
							yield* appendAudit({
								teamId: member.team_id as TeamId,
								actorMemberId: null,
								action: "organization.synchronized",
								resourceKind: "organization",
								resourceId: input.organizationId,
								metadata: {
									membershipId: input.memberId,
									change: input.change,
								},
							});
							return member.id as TeamMemberId;
						}),
					)
					.pipe(
						Effect.flatMap((memberId) =>
							memberId === null
								? Effect.void
								: notifyRevocation({ kind: "member", memberId }),
						),
						Effect.uninterruptible,
						Effect.catchTag("SqlError", Effect.die),
					),
			subscribeAccessRevocations: PubSub.subscribe(revocations),
			synchronizeOrganization: (details) =>
				synchronizeOrganization(details).pipe(
					Effect.tap(({ changed }) =>
						changed ? notifyCatalogChange : Effect.void,
					),
					Effect.tap(({ revokedMemberIds }) =>
						Effect.forEach(
							revokedMemberIds,
							(memberId) => notifyRevocation({ kind: "member", memberId }),
							{ discard: true },
						),
					),
					Effect.map(({ team, actor }) => ({ team, actor })),
					Effect.uninterruptible,
					Effect.catchTag("SqlError", Effect.die),
				),
			resolveActor: (...args) =>
				resolveActor(...args).pipe(Effect.catchTag("SqlError", Effect.die)),
			listMembers: (...args) =>
				listMembers(...args).pipe(Effect.catchTag("SqlError", Effect.die)),
			setWorkspaceGrant: (...args) =>
				setWorkspaceGrant(...args).pipe(
					Effect.tap(() => notifyCatalogChange),
					Effect.uninterruptible,
					Effect.catchTag("SqlError", Effect.die),
				),
			shareWorkspace: (...args) =>
				shareWorkspace(...args).pipe(
					Effect.tap(() => notifyCatalogChange),
					Effect.uninterruptible,
					Effect.catchTag("SqlError", Effect.die),
				),
			removeWorkspaceGrant: (...args) =>
				removeWorkspaceGrant(...args).pipe(
					Effect.tap(() =>
						notifyRevocation({
							kind: "grant",
							chatId: args[1],
							memberId: args[2],
						}),
					),
					Effect.uninterruptible,
					Effect.catchTag("SqlError", Effect.die),
				),
			unshareWorkspace: (...args) =>
				unshareWorkspace(...args).pipe(
					Effect.tap(() =>
						notifyRevocation({ kind: "workspace", chatId: args[1] }),
					),
					Effect.uninterruptible,
					Effect.catchTag("SqlError", Effect.die),
				),
			listWorkspaceGrants: (...args) =>
				listWorkspaceGrants(...args).pipe(
					Effect.catchTag("SqlError", Effect.die),
				),
			getWorkspaceSharing: (...args) =>
				getWorkspaceSharing(...args).pipe(
					Effect.catchTag("SqlError", Effect.die),
				),
			requireWorkspaceRole: (...args) =>
				requireWorkspaceRole(...args).pipe(
					Effect.catchTag("SqlError", Effect.die),
				),
			listAuditEvents: (...args) =>
				listAuditEvents(...args).pipe(Effect.catchTag("SqlError", Effect.die)),
		});
	}),
);
