import { CollaborationAccessDeniedError } from "@zuse/contracts";
import { Context, Effect, Layer, Option } from "effect";
import { AuthService } from "../../auth/services/auth-service.ts";
import { ConnectionIdentity } from "../../lan-auth/services/connection-identity.ts";

/** Host ownership and organization membership are independent permissions. */
export class WorkspaceSharingAuthority extends Context.Service<
	WorkspaceSharingAuthority,
	{
		readonly authorize: (
			subject: string,
		) => Effect.Effect<void, CollaborationAccessDeniedError>;
	}
>()("zuse/collaboration/WorkspaceSharingAuthority") {}

export const WorkspaceSharingAuthorityLive = Layer.effect(
	WorkspaceSharingAuthority,
	Effect.gen(function* () {
		const auth = yield* AuthService;
		return WorkspaceSharingAuthority.of({
			authorize: Effect.fn("WorkspaceSharingAuthority.authorize")(
				function* (subject) {
					const identity = yield* Effect.serviceOption(ConnectionIdentity);
					if (Option.isSome(identity) && identity.value.kind === "local")
						return;
					if (
						Option.isNone(identity) ||
						identity.value.kind !== "account" ||
						identity.value.subject !== subject ||
						identity.value.expiresAt <= Date.now()
					) {
						return yield* new CollaborationAccessDeniedError({
							reason: "host_authorization_required",
						});
					}
					// The account service checks the verified connection against the
					// current host account, including account switches during refresh.
					yield* auth.getAccessToken().pipe(
						Effect.asVoid,
						Effect.mapError(
							() =>
								new CollaborationAccessDeniedError({
									reason: "host_authorization_required",
								}),
						),
					);
				},
			),
		});
	}),
);
