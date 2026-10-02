import {
	CollaborationAccessDeniedError,
	type CollaborationRole,
} from "@zuse/contracts";
import { Context, Effect, Layer } from "effect";
import { ConnectionIdentity } from "../../lan-auth/services/connection-identity.ts";
import { MachineControlService } from "../../machine/machine-control-service.ts";

/** Live authority for WorkOS-backed teams; local SQLite membership is a projection. */
export class OrganizationAuthority extends Context.Service<
	OrganizationAuthority,
	{
		readonly membership: (
			organizationId: string,
			subject: string,
		) => Effect.Effect<
			{ readonly role: CollaborationRole; readonly membershipId: string },
			CollaborationAccessDeniedError
		>;
	}
>()("zuse/collaboration/OrganizationAuthority") {}

export const organizationCollaborationRole = (
	role: string,
): CollaborationRole | null =>
	role === "admin" ? "owner" : role === "member" ? "driver" : null;

export const OrganizationAuthorityLive = Layer.effect(
	OrganizationAuthority,
	Effect.gen(function* () {
		const api = yield* MachineControlService;
		return OrganizationAuthority.of({
			membership: Effect.fn("OrganizationAuthority.membership")(
				function* (organizationId, subject) {
					const membership = yield* api
						.organizationMembership(organizationId, subject)
						.pipe(
							// This narrow server-to-server membership check is performed
							// by the host, not as a delegated guest account operation.
							Effect.provideService(ConnectionIdentity, { kind: "local" }),
							Effect.mapError(
								() =>
									new CollaborationAccessDeniedError({
										reason: "organization_authority_unavailable",
									}),
							),
						);
					const role = organizationCollaborationRole(membership.role);
					if (role === null)
						return yield* new CollaborationAccessDeniedError({
							reason: "organization_content_access_denied",
						});
					return {
						membershipId: membership.membershipId,
						role,
					};
				},
			),
		});
	}),
);
