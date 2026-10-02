import type {
	ActorIdentity,
	ChatId,
	CollaborationAccessDeniedError,
	CollaborationAuditEvent,
	CollaborationConflictError,
	CollaborationNotFoundError,
	CollaborationRole,
	EnvironmentSharingAudience,
	FolderId,
	OrganizationDetails,
	Team,
	TeamId,
	TeamMember,
	TeamMemberId,
	WorkspaceGrant,
} from "@zuse/contracts";
import { Context, type Effect, type PubSub, type Scope } from "effect";

export type CollaborationAccessRevocation =
	| { readonly kind: "workspace"; readonly chatId: ChatId }
	| { readonly kind: "member"; readonly memberId: TeamMemberId }
	| {
			readonly kind: "grant";
			readonly chatId: ChatId;
			readonly memberId: TeamMemberId;
	  };

export type CollaborationServiceError =
	| CollaborationAccessDeniedError
	| CollaborationConflictError
	| CollaborationNotFoundError;

export interface CollaborationServiceShape {
	/** Host-only discovery projection; no paths, chat titles, or authority credentials. */
	readonly connectionAudience: Effect.Effect<EnvironmentSharingAudience>;
	/** Wake catalog subscriptions after committed grants, sharing, or membership changes. */
	readonly subscribeCatalogChanges: Effect.Effect<
		PubSub.Subscription<void>,
		never,
		Scope.Scope
	>;
	/** Verified account subject only; private/ungranted workspaces are excluded. */
	readonly visibleWorkspaces: (subject: string) => Effect.Effect<
		ReadonlyArray<{
			readonly chatId: ChatId;
			readonly projectId: FolderId;
		}>
	>;
	/** Apply only after the trusted account API confirms this membership mutation. */
	readonly applyOrganizationMembershipRestriction: (input: {
		readonly organizationId: string;
		readonly memberId: string;
		readonly change: "removed" | "demoted";
	}) => Effect.Effect<void>;
	/** Subscribe before checking access so revocation cannot race subscription startup. */
	readonly subscribeAccessRevocations: Effect.Effect<
		PubSub.Subscription<CollaborationAccessRevocation>,
		never,
		Scope.Scope
	>;
	/** Accepts a complete roster fetched by the trusted account API, never client-supplied claims. */
	readonly synchronizeOrganization: (
		details: OrganizationDetails,
	) => Effect.Effect<
		{ readonly team: Team; readonly actor: ActorIdentity },
		CollaborationServiceError
	>;
	readonly resolveActor: (
		teamId: TeamId,
		subject: string,
	) => Effect.Effect<ActorIdentity, CollaborationAccessDeniedError>;
	readonly listMembers: (
		actor: ActorIdentity,
	) => Effect.Effect<ReadonlyArray<TeamMember>, CollaborationAccessDeniedError>;
	readonly setWorkspaceGrant: (
		actor: ActorIdentity,
		chatId: ChatId,
		memberId: TeamMemberId,
		role: CollaborationRole,
	) => Effect.Effect<WorkspaceGrant, CollaborationServiceError>;
	/** Explicit host-owner opt-in. Organization ownership alone cannot claim a local chat. */
	readonly shareWorkspace: (
		actor: ActorIdentity,
		chatId: ChatId,
	) => Effect.Effect<void, CollaborationServiceError>;
	readonly unshareWorkspace: (
		actor: ActorIdentity,
		chatId: ChatId,
	) => Effect.Effect<void, CollaborationServiceError>;
	readonly removeWorkspaceGrant: (
		actor: ActorIdentity,
		chatId: ChatId,
		memberId: TeamMemberId,
	) => Effect.Effect<void, CollaborationServiceError>;
	readonly listWorkspaceGrants: (
		actor: ActorIdentity,
		chatId: ChatId,
	) => Effect.Effect<ReadonlyArray<WorkspaceGrant>, CollaborationServiceError>;
	readonly getWorkspaceSharing: (
		actor: ActorIdentity,
		chatId: ChatId,
	) => Effect.Effect<
		{
			readonly shared: boolean;
			readonly grants: ReadonlyArray<WorkspaceGrant>;
		},
		CollaborationServiceError
	>;
	readonly requireWorkspaceRole: (
		actor: ActorIdentity,
		chatId: ChatId,
		minimumRole: CollaborationRole,
	) => Effect.Effect<WorkspaceGrant | null, CollaborationAccessDeniedError>;
	readonly listAuditEvents: (
		actor: ActorIdentity,
		limit?: number,
	) => Effect.Effect<
		ReadonlyArray<CollaborationAuditEvent>,
		CollaborationAccessDeniedError
	>;
}

export class CollaborationService extends Context.Service<
	CollaborationService,
	CollaborationServiceShape
>()("zuse/CollaborationService") {}
