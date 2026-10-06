import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

/** Includes the creator; pending invitations reserve seats. */
export const ORGANIZATION_MEMBER_LIMIT = 5;

/** Organization administration is separate from private workspace permissions. */
export const OrganizationRole = Schema.Literals(["admin", "member", "billing"]);
export type OrganizationRole = typeof OrganizationRole.Type;
const Identifier = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
);
export const OrganizationName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(100),
);

export class Organization extends Schema.Class<Organization>("Organization")({
	id: Identifier,
	name: Schema.String,
	role: OrganizationRole,
	isCreator: Schema.optional(Schema.Boolean),
}) {}

export class OrganizationMember extends Schema.Class<OrganizationMember>(
	"OrganizationMember",
)({
	id: Identifier,
	userId: Identifier,
	email: Schema.String,
	displayName: Schema.String,
	role: Schema.String,
	directoryManaged: Schema.Boolean,
	githubManaged: Schema.optional(Schema.Boolean),
	profilePictureUrl: Schema.optional(Schema.String),
}) {}

export class OrganizationInvitation extends Schema.Class<OrganizationInvitation>(
	"OrganizationInvitation",
)({
	id: Identifier,
	email: Schema.String,
	state: Schema.Literals(["pending", "accepted", "revoked", "expired"]),
	expiresAt: Schema.String,
}) {}

export class OrganizationDetails extends Schema.Class<OrganizationDetails>(
	"OrganizationDetails",
)({
	organization: Organization,
	currentUserId: Identifier,
	members: Schema.Array(OrganizationMember),
	invitations: Schema.Array(OrganizationInvitation),
}) {}

export class OrganizationError extends Schema.TaggedErrorClass<OrganizationError>()(
	"OrganizationError",
	{
		code: Schema.Literals([
			"not-allowed",
			"not-found",
			"conflict",
			"invalid-request",
			"unavailable",
			"organization-limit-reached",
			"organization-member-limit-reached",
		]),
	},
) {}

export const OrganizationCreateInput = Schema.Struct({
	name: OrganizationName,
	operationId: Schema.String.check(Schema.isUUID()),
});
export const OrganizationInviteInput = Schema.Struct({
	organizationId: Identifier,
	email: Schema.String.check(
		Schema.isMaxLength(254),
		Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
	),
	role: OrganizationRole,
});
export const OrganizationMemberInput = Schema.Struct({
	organizationId: Identifier,
	memberId: Identifier,
});
export const OrganizationRoleInput = Schema.Struct({
	...OrganizationMemberInput.fields,
	role: OrganizationRole,
});
export const OrganizationRevokeInviteInput = Schema.Struct({
	organizationId: Identifier,
	invitationId: Identifier,
});

export const OrganizationsListRpc = Rpc.make("organizations.list", {
	payload: Schema.Struct({}),
	success: Schema.Array(Organization),
	error: OrganizationError,
});

export const OrganizationsCreateRpc = Rpc.make("organizations.create", {
	payload: OrganizationCreateInput,
	success: Organization,
	error: OrganizationError,
});

export const OrganizationsGetRpc = Rpc.make("organizations.get", {
	payload: Schema.Struct({ organizationId: Identifier }),
	success: OrganizationDetails,
	error: OrganizationError,
});
export const OrganizationsInviteRpc = Rpc.make("organizations.invite", {
	payload: OrganizationInviteInput,
	success: OrganizationInvitation,
	error: OrganizationError,
});
export const OrganizationsRevokeInviteRpc = Rpc.make(
	"organizations.revokeInvite",
	{
		payload: OrganizationRevokeInviteInput,
		success: Schema.Void,
		error: OrganizationError,
	},
);
export const OrganizationsSetRoleRpc = Rpc.make("organizations.setRole", {
	payload: OrganizationRoleInput,
	success: Schema.Void,
	error: OrganizationError,
});
export const OrganizationsRemoveMemberRpc = Rpc.make(
	"organizations.removeMember",
	{
		payload: OrganizationMemberInput,
		success: Schema.Void,
		error: OrganizationError,
	},
);

export const OrganizationGithubInput = Schema.Struct({
	organizationId: Identifier,
});
export const OrganizationGithubPolicyInput = Schema.Struct({
	organizationId: Identifier,
	installationId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	enabled: Schema.Boolean,
});
export const OrganizationGithubRestoreInput = Schema.Struct({
	organizationId: Identifier,
	accountId: Identifier,
});
export const OrganizationGithubSettings = Schema.Struct({
	installations: Schema.Array(
		Schema.Struct({
			installationId: Schema.Number,
			login: Schema.String,
			avatarUrl: Schema.optional(Schema.String),
			enabled: Schema.Boolean,
			suspended: Schema.Boolean,
		}),
	),
	blockedMembers: Schema.Array(
		Schema.Struct({ accountId: Identifier, displayName: Schema.String }),
	),
});
/** The GitHub account linked to this Zuse account for auto-join, if any. */
export const OrganizationGithubConnection = Schema.Struct({
	connected: Schema.Boolean,
	login: Schema.optional(Schema.String),
});
export const OrganizationsGithubConnectionRpc = Rpc.make(
	"organizations.githubConnection",
	{
		payload: Schema.Struct({}),
		success: OrganizationGithubConnection,
		error: OrganizationError,
	},
);
export const OrganizationGithubAuthorization = Schema.Struct({
	url: Schema.String,
	attemptId: Schema.String,
});
/** Links a GitHub account through Zuse's GitHub App; any email works. */
export const OrganizationsGithubAuthorizeRpc = Rpc.make(
	"organizations.githubAuthorize",
	{
		payload: Schema.Struct({}),
		success: OrganizationGithubAuthorization,
		error: OrganizationError,
	},
);
const EmailDomain = Schema.String.check(
	Schema.isMaxLength(253),
	Schema.isPattern(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u),
);
const BlockedMember = Schema.Struct({
	accountId: Identifier,
	displayName: Schema.String,
});
export const OrganizationDomainSettings = Schema.Struct({
	/** Domains whose verified emails auto-join this organization. */
	domains: Schema.Array(Schema.String),
	/** The admin's own email domain, when it can still be added. */
	suggestedDomain: Schema.NullOr(Schema.String),
	blockedMembers: Schema.Array(BlockedMember),
});
export const OrganizationDomainInput = Schema.Struct({
	organizationId: Identifier,
	domain: EmailDomain,
});
export const OrganizationsDomainsRpc = Rpc.make("organizations.domains", {
	payload: OrganizationGithubInput,
	success: OrganizationDomainSettings,
	error: OrganizationError,
});
/** Turns on auto-join for the domain the admin's verified email uses. */
export const OrganizationsDomainAddRpc = Rpc.make("organizations.domainAdd", {
	payload: OrganizationDomainInput,
	success: Schema.Void,
	error: OrganizationError,
});
export const OrganizationsDomainRemoveRpc = Rpc.make(
	"organizations.domainRemove",
	{
		payload: OrganizationDomainInput,
		success: Schema.Void,
		error: OrganizationError,
	},
);
export const OrganizationsDomainRestoreRpc = Rpc.make(
	"organizations.domainRestore",
	{
		payload: OrganizationGithubRestoreInput,
		success: Schema.Void,
		error: OrganizationError,
	},
);
export const OrganizationsGithubSettingsRpc = Rpc.make(
	"organizations.githubSettings",
	{
		payload: OrganizationGithubInput,
		success: OrganizationGithubSettings,
		error: OrganizationError,
	},
);
export const OrganizationsGithubPolicyRpc = Rpc.make(
	"organizations.githubPolicy",
	{
		payload: OrganizationGithubPolicyInput,
		success: Schema.Void,
		error: OrganizationError,
	},
);
export const OrganizationsGithubRestoreRpc = Rpc.make(
	"organizations.githubRestore",
	{
		payload: OrganizationGithubRestoreInput,
		success: Schema.Void,
		error: OrganizationError,
	},
);
