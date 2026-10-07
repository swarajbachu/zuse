import { organizationControlError } from "@zuse/client-runtime/control-api-error";
import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	type MachineControlError,
	MachineControlService,
} from "../machine/machine-control-service.ts";

const withOrganizations = <A>(
	run: (
		service: MachineControlService["Service"],
	) => Effect.Effect<A, MachineControlError>,
) =>
	Effect.flatMap(MachineControlService, run).pipe(
		Effect.mapError((error) => organizationControlError(error.code)),
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
	MemoizeRpcs.toLayerHandler("organizations.list", () =>
		withOrganizations((service) => service.listOrganizations()),
	),
	MemoizeRpcs.toLayerHandler("organizations.create", (input) =>
		withOrganizations((service) => service.createOrganization(input)),
	),
	MemoizeRpcs.toLayerHandler("organizations.get", ({ organizationId }) =>
		withOrganizations((service) => service.getOrganization(organizationId)),
	),
	MemoizeRpcs.toLayerHandler("organizations.invite", (input) =>
		withOrganizations((service) => service.inviteOrganizationMember(input)),
	),
	MemoizeRpcs.toLayerHandler("organizations.revokeInvite", (input) =>
		withOrganizations((service) => service.revokeOrganizationInvite(input)),
	),
	MemoizeRpcs.toLayerHandler("organizations.setRole", (input) =>
		withOrganizations((service) => service.setOrganizationRole(input)),
	),
	MemoizeRpcs.toLayerHandler("organizations.removeMember", (input) =>
		withOrganizations((service) => service.removeOrganizationMember(input)),
	),
);
