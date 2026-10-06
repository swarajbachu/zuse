import {
	ApiPaths,
	Organization,
	type OrganizationCreateInput,
	OrganizationDetails,
	type OrganizationDomainInput,
	OrganizationDomainSettings,
	OrganizationGithubAuthorization,
	OrganizationGithubConnection,
	type OrganizationGithubInput,
	type OrganizationGithubPolicyInput,
	type OrganizationGithubRestoreInput,
	OrganizationGithubSettings,
	OrganizationInvitation,
	type OrganizationInviteInput,
	type OrganizationMemberInput,
	type OrganizationRevokeInviteInput,
	type OrganizationRoleInput,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";

/** Membership administration is account-scoped; organization IDs stay in the payload. */
export type OrganizationControlRequest<E> = <A>(
	path: string,
	schema: Schema.Codec<A, unknown>,
	body?: unknown,
) => Effect.Effect<A, E>;

const acknowledgement = Schema.Struct({ ok: Schema.Literal(true) });

export const makeOrganizationControlClient = <E>(
	request: OrganizationControlRequest<E>,
) => ({
	...makeOrganizationAutoJoinControlClient(request),
	"organizations.list": (_input: Record<string, never>) =>
		request(ApiPaths.organizations, Schema.Array(Organization)),
	"organizations.get": (input: { organizationId: string }) =>
		request(ApiPaths.organizationDetails, OrganizationDetails, input),
	"organizations.create": (input: typeof OrganizationCreateInput.Type) =>
		request(ApiPaths.organizations, Organization, input),
	"organizations.invite": (input: typeof OrganizationInviteInput.Type) =>
		request(ApiPaths.organizationInvite, OrganizationInvitation, input),
	"organizations.revokeInvite": (
		input: typeof OrganizationRevokeInviteInput.Type,
	) =>
		request(ApiPaths.organizationRevokeInvite, acknowledgement, input).pipe(
			Effect.asVoid,
		),
	"organizations.setRole": (input: typeof OrganizationRoleInput.Type) =>
		request(ApiPaths.organizationSetRole, acknowledgement, input).pipe(
			Effect.asVoid,
		),
	"organizations.removeMember": (input: typeof OrganizationMemberInput.Type) =>
		request(ApiPaths.organizationRemoveMember, acknowledgement, input).pipe(
			Effect.asVoid,
		),
});

export const makeOrganizationAutoJoinControlClient = <E>(
	request: OrganizationControlRequest<E>,
) => ({
	"organizations.githubAuthorize": (_input: Record<string, never>) =>
		request(
			ApiPaths.organizationGithubAuthorize,
			OrganizationGithubAuthorization,
			{},
		),
	"organizations.githubConnection": (_input: Record<string, never>) =>
		request(
			ApiPaths.organizationGithubConnection,
			OrganizationGithubConnection,
			{},
		),
	"organizations.githubSettings": (
		input: typeof OrganizationGithubInput.Type,
	) =>
		request(
			ApiPaths.organizationGithubSettings,
			OrganizationGithubSettings,
			input,
		),
	"organizations.githubPolicy": (
		input: typeof OrganizationGithubPolicyInput.Type,
	) =>
		request(ApiPaths.organizationGithubPolicy, acknowledgement, input).pipe(
			Effect.asVoid,
		),
	"organizations.githubRestore": (
		input: typeof OrganizationGithubRestoreInput.Type,
	) =>
		request(ApiPaths.organizationGithubRestore, acknowledgement, input).pipe(
			Effect.asVoid,
		),
	"organizations.domains": (input: typeof OrganizationGithubInput.Type) =>
		request(ApiPaths.organizationDomains, OrganizationDomainSettings, input),
	"organizations.domainAdd": (input: typeof OrganizationDomainInput.Type) =>
		request(ApiPaths.organizationDomainAdd, acknowledgement, input).pipe(
			Effect.asVoid,
		),
	"organizations.domainVerify": (input: typeof OrganizationDomainInput.Type) =>
		request(
			ApiPaths.organizationDomainVerify,
			Schema.Struct({ verified: Schema.Boolean }),
			input,
		),
	"organizations.domainRemove": (input: typeof OrganizationDomainInput.Type) =>
		request(ApiPaths.organizationDomainRemove, acknowledgement, input).pipe(
			Effect.asVoid,
		),
	"organizations.domainRestore": (
		input: typeof OrganizationGithubRestoreInput.Type,
	) =>
		request(ApiPaths.organizationDomainRestore, acknowledgement, input).pipe(
			Effect.asVoid,
		),
});
