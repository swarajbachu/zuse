import {
	RpcAccessDeniedError,
	RpcAuthorization,
	WORKSPACE_SCOPE_HEADER,
	WorkspaceScopeHeader,
} from "@zuse/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthService } from "../../auth/services/auth-service.ts";
import { RequestWorkspace } from "../../machine/request-workspace.ts";
import { ConnectionIdentity } from "../services/connection-identity.ts";
import { authorizeWorkspaceRpc } from "./workspace-rpc-authorization.ts";

export const RpcAuthorizationLive = Layer.effect(
	RpcAuthorization,
	Effect.gen(function* () {
		const auth = yield* AuthService;
		const sql = yield* SqlClient.SqlClient;
		return RpcAuthorization.of((effect, { rpc, payload, headers }) =>
			Effect.gen(function* () {
				const scope = yield* Schema.decodeUnknownEffect(WorkspaceScopeHeader)(
					headers[WORKSPACE_SCOPE_HEADER] ?? "personal",
				).pipe(
					Effect.mapError(
						() => new RpcAccessDeniedError({ code: "access-denied" }),
					),
				);
				const request = Effect.provideService(effect, RequestWorkspace, scope);
				if (
					scope !== "personal" &&
					!rpc._tag.startsWith("cloud.") &&
					![
						"plugins.request",
						"machines.checkout",
						"machines.billingPortal",
						"machines.prepaidBalance",
						"machines.prepaidCheckout",
						"machines.entitlements",
					].includes(rpc._tag)
				)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				const identity = yield* Effect.serviceOption(ConnectionIdentity);
				if (
					rpc._tag === "plugins.local.request" &&
					(Option.isNone(identity) || identity.value.kind !== "local")
				)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				// Arbitrary repository reads may use the host's private GitHub credentials.
				if (
					rpc._tag === "github.observe" &&
					(Option.isNone(identity) || identity.value.kind !== "local")
				)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				if (
					rpc._tag === "deviceBridge.setEnabled" &&
					Option.isSome(identity) &&
					identity.value.kind !== "local"
				)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				if (Option.isSome(identity) && identity.value.kind === "workspace")
					return yield* authorizeWorkspaceRpc(
						request,
						identity.value,
						rpc._tag,
						payload,
					).pipe(Effect.provideService(SqlClient.SqlClient, sql));

				if (Option.isNone(identity) || identity.value.kind !== "account")
					return yield* request;
				const account = identity.value;
				const authorize = Effect.gen(function* () {
					if (account.expiresAt <= Date.now())
						return yield* new RpcAccessDeniedError({
							code: "credential-expired",
						});
					const session = yield* auth.getSession();
					if (
						session._tag !== "SignedIn" ||
						session.session.user.id !== account.subject
					)
						return yield* new RpcAccessDeniedError({ code: "access-denied" });
				});
				yield* authorize;

				return yield* Effect.raceFirst(
					request,
					Effect.forever(
						Effect.suspend(() =>
							Effect.sleep(
								Math.max(0, Math.min(20_000, account.expiresAt - Date.now())),
							),
						).pipe(Effect.andThen(authorize)),
					),
				);
			}),
		);
	}),
);
