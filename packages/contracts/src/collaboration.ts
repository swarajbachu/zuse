import { Schema } from "effect";

import { AuditEventId, ChatId, TeamId, TeamMemberId } from "./ids.ts";

/** Stable workspace author established by a trusted transport, never client claims. */
export const WorkspaceActor = Schema.Struct({
	subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	membershipId: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(128),
	),
});
export type WorkspaceActor = typeof WorkspaceActor.Type;

/**
 * Team-wide authority. Resource grants may reduce a member's authority for a
 * private chat, but can never elevate it above this role.
 */
export const CollaborationRole = Schema.Literals(["owner", "driver", "viewer"]);
export type CollaborationRole = typeof CollaborationRole.Type;

/** Sharing is resource access, independent of membership and billing authority. */
export const ChatAccessPermission = Schema.Literals(["view", "edit"]);
export type ChatAccessPermission = typeof ChatAccessPermission.Type;

export const ChatSharingDefaults = Schema.Struct({
	audience: Schema.Literals(["private", "organization"]),
	permission: ChatAccessPermission,
});
export type ChatSharingDefaults = typeof ChatSharingDefaults.Type;

export const ChatSharingPolicy = Schema.Struct({
	...ChatSharingDefaults.fields,
	/** Independent of lifecycle/activity writes; legacy policies start at zero. */
	revision: Schema.optional(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	),
	creatorSubject: Schema.NonEmptyString,
	/** Membership identity prevents removed/rejoined users inheriting old grants. */
	creatorMembershipId: Schema.NonEmptyString,
	grants: Schema.Array(
		Schema.Struct({
			membershipId: Schema.NonEmptyString,
			permission: ChatAccessPermission,
		}),
	),
});
export type ChatSharingPolicy = typeof ChatSharingPolicy.Type;

export const ChatSharingUpdate = Schema.Struct({
	...ChatSharingDefaults.fields,
	grants: ChatSharingPolicy.fields.grants,
	expectedRevision: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
	),
});
export type ChatSharingUpdate = typeof ChatSharingUpdate.Type;

export const ChatSharingState = Schema.Struct({
	policy: ChatSharingPolicy,
	revision: Schema.Number,
	canManageSharing: Schema.Boolean,
});
export type ChatSharingState = typeof ChatSharingState.Type;

export const TeamMemberStatus = Schema.Literals(["active", "revoked"]);
export type TeamMemberStatus = typeof TeamMemberStatus.Type;

/** Identity established by a trusted transport/OIDC boundary, never client claims. */
export class ActorIdentity extends Schema.Class<ActorIdentity>("ActorIdentity")(
	{
		memberId: TeamMemberId,
		teamId: TeamId,
		subject: Schema.String,
		email: Schema.String,
		displayName: Schema.String,
		avatarUrl: Schema.NullOr(Schema.String),
	},
) {}

export class Team extends Schema.Class<Team>("Team")({
	id: TeamId,
	organizationId: Schema.NullOr(Schema.String),
	name: Schema.String,
	createdAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
}) {}

export class TeamMember extends Schema.Class<TeamMember>("TeamMember")({
	id: TeamMemberId,
	teamId: TeamId,
	subject: Schema.String,
	email: Schema.String,
	displayName: Schema.String,
	avatarUrl: Schema.NullOr(Schema.String),
	role: CollaborationRole,
	status: TeamMemberStatus,
	joinedAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
}) {}

/** Private-by-default access grant for Zuse's chat/worktree collaboration unit. */
export class WorkspaceGrant extends Schema.Class<WorkspaceGrant>(
	"WorkspaceGrant",
)({
	teamId: TeamId,
	chatId: ChatId,
	memberId: TeamMemberId,
	role: CollaborationRole,
	grantedByMemberId: TeamMemberId,
	createdAt: Schema.DateFromString,
	updatedAt: Schema.DateFromString,
}) {}

export const CollaborationAuditAction = Schema.Literals([
	"team.created",
	"organization.synchronized",
	"member.joined",
	"member.role_changed",
	"member.revoked",
	"invite.created",
	"invite.accepted",
	"invite.revoked",
	"workspace.grant_set",
	"workspace.shared",
	"workspace.unshared",
	"workspace.grant_removed",
]);
export type CollaborationAuditAction = typeof CollaborationAuditAction.Type;

export class CollaborationAuditEvent extends Schema.Class<CollaborationAuditEvent>(
	"CollaborationAuditEvent",
)({
	id: AuditEventId,
	teamId: TeamId,
	actorMemberId: Schema.NullOr(TeamMemberId),
	action: CollaborationAuditAction,
	resourceKind: Schema.String,
	resourceId: Schema.String,
	metadata: Schema.Record(Schema.String, Schema.Unknown),
	createdAt: Schema.DateFromString,
}) {}

export class CollaborationAccessDeniedError extends Schema.TaggedErrorClass<CollaborationAccessDeniedError>()(
	"CollaborationAccessDeniedError",
	{ reason: Schema.String },
) {}

export class CollaborationNotFoundError extends Schema.TaggedErrorClass<CollaborationNotFoundError>()(
	"CollaborationNotFoundError",
	{ resource: Schema.String },
) {}

export class CollaborationConflictError extends Schema.TaggedErrorClass<CollaborationConflictError>()(
	"CollaborationConflictError",
	{ reason: Schema.String },
) {}

export type CollaborationError =
	| CollaborationAccessDeniedError
	| CollaborationNotFoundError
	| CollaborationConflictError;
