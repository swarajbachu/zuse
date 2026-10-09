import { organizationControlError } from "@zuse/client-runtime/control-api-error";
import {
	type ActorIdentity,
	MemoizeRpcs,
	OrganizationError,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	type MachineControlError,
	MachineControlService,
} from "../machine/machine-control-service.ts";
import {
	CollaborationService,
	type CollaborationServiceError,
} from "./services/collaboration-service.ts";

const withOrganizations = <A>(
	run: (
		service: MachineControlService["Service"],
	) => Effect.Effect<A, MachineControlError>,
) =>
	Effect.flatMap(MachineControlService, run).pipe(
		Effect.mapError((error) => organizationControlError(error.code)),
	);

const withOrganizationActor = <A>(
	organizationId: string,
	run: (
		service: CollaborationService["Service"],
		actor: ActorIdentity,
	) => Effect.Effect<A, CollaborationServiceError>,
) =>
	Effect.gen(function* () {
		const details = yield* withOrganizations((service) =>
			service.getOrganization(organizationId),
		);
		const collaboration = yield* CollaborationService;
		const { actor } = yield* collaboration.synchronizeOrganization(details);
		return yield* run(collaboration, actor);
	}).pipe(
		Effect.mapError((error) =>
			error._tag === "OrganizationError"
				? error
				: new OrganizationError({
						code:
							error._tag === "CollaborationAccessDeniedError"
								? "not-allowed"
								: error._tag === "CollaborationNotFoundError"
									? "not-found"
									: "unavailable",
					}),
		),
	);

export const OrganizationHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("organizations.githubAuthorize", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.githubAuthorize"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.domains", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.domains"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.domainAdd", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.domainAdd"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.domainRemove", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.domainRemove"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.domainRestore", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.domainRestore"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.githubConnection", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.githubConnection"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.githubSettings", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.githubSettings"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.githubPolicy", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.githubPolicy"](input),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.githubRestore", (input) =>
		withOrganizations((service) =>
			service.organizationAutoJoin["organizations.githubRestore"](input),
		),
	),

	MemoizeRpcs.toLayerHandler("organizations.capabilities", () =>
		withOrganizations((service) => service.organizationCapabilities()),
	),
	MemoizeRpcs.toLayerHandler(
		"organizations.getWorkspaceSharing",
		({ organizationId, chatId }) =>
			withOrganizationActor(organizationId, (service, actor) =>
				Effect.gen(function* () {
					const state = yield* service.getWorkspaceSharing(actor, chatId);
					const members = yield* service.listMembers(actor);
					return { ...state, members };
				}),
			),
	),
	MemoizeRpcs.toLayerHandler(
		"organizations.setWorkspaceGrant",
		({ organizationId, chatId, userId, role }) =>
			withOrganizationActor(organizationId, (service, actor) =>
				Effect.gen(function* () {
					// Requires host ownership, not just organization administrator status.
					yield* service.getWorkspaceSharing(actor, chatId);
					const target = yield* service.resolveActor(actor.teamId, userId);
					if (role === null)
						yield* service.removeWorkspaceGrant(actor, chatId, target.memberId);
					else
						yield* service.setWorkspaceGrant(
							actor,
							chatId,
							target.memberId,
							role,
						);
				}),
			),
	),
	MemoizeRpcs.toLayerHandler(
		"organizations.setWorkspaceSharing",
		({ organizationId, chatId, shared }) =>
			withOrganizationActor(organizationId, (service, actor) =>
				shared
					? service.shareWorkspace(actor, chatId)
					: service.unshareWorkspace(actor, chatId),
			),
	),
	MemoizeRpcs.toLayerHandler("organizations.list", () =>
		withOrganizations((service) => service.listOrganizations()),
	),
	MemoizeRpcs.toLayerHandler("organizations.create", (input) =>
		withOrganizations((service) => service.createOrganization(input)),
	),
	MemoizeRpcs.toLayerHandler("organizations.get", ({ organizationId }) =>
		Effect.gen(function* () {
			const details = yield* withOrganizations((service) =>
				service.getOrganization(organizationId),
			);
			const collaboration = yield* CollaborationService;
			yield* collaboration
				.synchronizeOrganization(details)
				.pipe(
					Effect.mapError(() => new OrganizationError({ code: "unavailable" })),
				);
			return details;
		}),
	),
	MemoizeRpcs.toLayerHandler("organizations.invite", (input) =>
		withOrganizations((service) => service.inviteOrganizationMember(input)),
	),
	MemoizeRpcs.toLayerHandler("organizations.revokeInvite", (input) =>
		withOrganizations((service) => service.revokeOrganizationInvite(input)),
	),
	MemoizeRpcs.toLayerHandler("organizations.setRole", (input) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				yield* restore(
					withOrganizations((service) => service.setOrganizationRole(input)),
				);
				if (input.role !== "admin") {
					const collaboration = yield* CollaborationService;
					yield* collaboration.applyOrganizationMembershipRestriction({
						...input,
						change: input.role === "billing" ? "removed" : "demoted",
					});
				}
			}),
		),
	),
	MemoizeRpcs.toLayerHandler("organizations.removeMember", (input) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				yield* restore(
					withOrganizations((service) =>
						service.removeOrganizationMember(input),
					),
				);
				const collaboration = yield* CollaborationService;
				yield* collaboration.applyOrganizationMembershipRestriction({
					...input,
					change: "removed",
				});
			}),
		),
	),
);
