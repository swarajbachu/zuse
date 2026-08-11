import {
	BillingCheckout,
	type BillingCheckoutRequest,
	BillingPortal,
	CloudChatHistory,
	CloudCredentialConnection,
	type CloudCredentialConnectRequest,
	type CloudCredentialKind,
	CloudCredentialList,
	CloudProject,
	CloudProjectBuild,
	type CloudProjectConnectRequest,
	CloudProjectList,
	type CloudProjectPrepareRequest,
	CloudProviderList,
	CloudWorkspace,
	CloudWorkspaceConnection,
	type CloudWorkspaceCreateRequest,
	CloudWorkspaceLaunch,
	CloudWorkspaceList,
	EntitlementList,
	type EnvironmentId,
	type MachineCreateRequest,
	type MachineDestroyRequest,
	MachineErrorCode,
	MachineList,
	MachineOfferList,
	MachineRecord,
	PRODUCTION_RELAY_URL,
	RelayAccessToken,
	RelayConnectGrant,
	RelayEnvironmentList,
	RelayPaths,
	STAGING_RELAY_URL,
} from "@zuse/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import { AuthService } from "../auth/services/auth-service.ts";
import { MachineRuntimeRole } from "./machine-runtime-role.ts";

export interface MachineControlServiceShape {
	readonly offers: () => Effect.Effect<MachineOfferList, MachineControlError>;
	readonly cloudProviders: () => Effect.Effect<
		CloudProviderList,
		MachineControlError
	>;
	readonly cloudProjects: () => Effect.Effect<
		CloudProjectList,
		MachineControlError
	>;
	readonly connectCloudProject: (
		input: CloudProjectConnectRequest,
	) => Effect.Effect<CloudProject, MachineControlError>;
	readonly prepareCloudProject: (
		input: CloudProjectPrepareRequest,
	) => Effect.Effect<CloudProjectBuild, MachineControlError>;
	readonly cloudWorkspaces: (
		projectId?: string,
	) => Effect.Effect<CloudWorkspaceList, MachineControlError>;
	readonly cloudWorkspace: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspace, MachineControlError>;
	readonly createCloudWorkspace: (
		input: CloudWorkspaceCreateRequest,
	) => Effect.Effect<CloudWorkspaceLaunch, MachineControlError>;
	readonly connectCloudWorkspace: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspaceConnection, MachineControlError>;
	readonly cloudChatHistory: (
		workspaceId: string,
	) => Effect.Effect<CloudChatHistory, MachineControlError>;
	readonly cloudWorkspaceAction: (
		workspaceId: string,
		action: "pause" | "resume" | "archive" | "delete",
	) => Effect.Effect<CloudWorkspace, MachineControlError>;
	readonly cloudCredentials: () => Effect.Effect<
		CloudCredentialList,
		MachineControlError
	>;
	readonly connectCloudCredential: (
		input: CloudCredentialConnectRequest,
	) => Effect.Effect<CloudCredentialConnection, MachineControlError>;
	readonly disconnectCloudCredential: (
		kind: CloudCredentialKind,
	) => Effect.Effect<CloudCredentialConnection, MachineControlError>;
	readonly list: () => Effect.Effect<MachineList, MachineControlError>;
	readonly get: (
		machineId: string,
	) => Effect.Effect<MachineRecord, MachineControlError>;
	readonly create: (
		input: MachineCreateRequest,
	) => Effect.Effect<MachineRecord, MachineControlError>;
	readonly cancel: (
		machineId: string,
	) => Effect.Effect<MachineRecord, MachineControlError>;
	readonly recover: (
		machineId: string,
	) => Effect.Effect<MachineRecord, MachineControlError>;
	readonly destroy: (
		input: MachineDestroyRequest,
	) => Effect.Effect<MachineRecord, MachineControlError>;
	readonly checkout: (
		input: BillingCheckoutRequest,
	) => Effect.Effect<BillingCheckout, MachineControlError>;
	readonly billingPortal: () => Effect.Effect<
		BillingPortal,
		MachineControlError
	>;
	readonly entitlements: () => Effect.Effect<
		EntitlementList,
		MachineControlError
	>;
	readonly environments: () => Effect.Effect<
		RelayEnvironmentList,
		MachineControlError
	>;
	readonly connectEnvironment: (
		environmentId: EnvironmentId,
	) => Effect.Effect<RelayConnectGrant, MachineControlError>;
}

export class MachineControlError extends Schema.TaggedErrorClass<MachineControlError>()(
	"MachineControlError",
	{ code: MachineErrorCode },
) {
	constructor(code: MachineControlError["code"]) {
		super({ code });
	}
}

export class MachineControlService extends Context.Service<
	MachineControlService,
	MachineControlServiceShape
>()("zuse/MachineControlService") {}

export const resolveMachineRelayUrl = (
	env: Readonly<Record<string, string | undefined>> = process.env,
): string =>
	(
		env.ZUSE_RELAY_URL ??
		(env.NODE_ENV === "production" ? PRODUCTION_RELAY_URL : STAGING_RELAY_URL)
	).replace(/\/+$/u, "");

export const mapRelayErrorCode = (
	status: number,
	code: unknown,
): MachineControlError => {
	if (code === "machine_alpha_not_allowed") {
		return new MachineControlError("not-allowed");
	}
	if (code === "invalid_machine_offer") {
		return new MachineControlError("invalid-offer");
	}
	if (code === "entitlement_required") {
		return new MachineControlError("entitlement-required");
	}
	if (code === "cloud_entitlement_required")
		return new MachineControlError("entitlement-required");
	if (code === "cloud_project_not_ready")
		return new MachineControlError("invalid-state");
	if (code === "cloud_credential_connection_required")
		return new MachineControlError("credential-required");
	if (typeof code === "string" && code.startsWith("cloud_branch_in_use:"))
		return new MachineControlError("branch-in-use");
	if (code === "machine_limit_reached") {
		return new MachineControlError("machine-limit-reached");
	}
	if (code === "billing_approval_pending") {
		return new MachineControlError("billing-unavailable");
	}
	if (code === "machine_not_found" || status === 404) {
		return new MachineControlError("not-found");
	}
	if (code === "invalid_machine_state" || code === "machine_not_recoverable") {
		return new MachineControlError("invalid-state");
	}
	if (status === 409) return new MachineControlError("conflict");
	if (status >= 500) return new MachineControlError("provider-unavailable");
	return new MachineControlError("invalid-request");
};

export const MachineControlServiceLive: Layer.Layer<
	MachineControlService,
	never,
	AuthService | MachineRuntimeRole
> = Layer.effect(
	MachineControlService,
	Effect.gen(function* () {
		const auth = yield* AuthService;
		const runtimeRole = yield* MachineRuntimeRole;
		const relayUrl = resolveMachineRelayUrl();
		const dpopKeys = generateKeyPair("ES256", { extractable: true });
		const dpopProof = async (method: string, url: string): Promise<string> => {
			const keys = await dpopKeys;
			const jwk = (await exportJWK(keys.publicKey)) as JWK;
			return new SignJWT({
				htm: method,
				htu: url,
				jti: crypto.randomUUID(),
			})
				.setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
				.setIssuedAt()
				.sign(keys.privateKey);
		};

		const request = <A, I>(
			path: string,
			schema: Schema.Codec<A, I>,
			method = "GET",
			body?: unknown,
		): Effect.Effect<A, MachineControlError> =>
			Effect.gen(function* () {
				if (runtimeRole !== "control-plane") {
					return yield* Effect.fail(new MachineControlError("not-allowed"));
				}
				const token = yield* auth
					.getAccessToken()
					.pipe(Effect.mapError(() => new MachineControlError("not-allowed")));
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(`${relayUrl}${path}`, {
							method,
							headers: {
								authorization: `Bearer ${token}`,
								...(body === undefined
									? {}
									: { "content-type": "application/json" }),
							},
							body: body === undefined ? undefined : JSON.stringify(body),
						}),
					catch: () => new MachineControlError("provider-unavailable"),
				});
				if (!response.ok) {
					const payload = yield* Effect.promise(
						() =>
							response.json().catch(() => ({})) as Promise<{
								readonly error?: unknown;
							}>,
					);
					return yield* Effect.fail(
						mapRelayErrorCode(response.status, payload.error),
					);
				}
				const payload = yield* Effect.tryPromise({
					try: (): Promise<unknown> => response.json(),
					catch: () => new MachineControlError("provider-unavailable"),
				});
				return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
					Effect.mapError(
						() => new MachineControlError("provider-unavailable"),
					),
				);
			});

		return MachineControlService.of({
			cloudProviders: () =>
				request(RelayPaths.cloudProviders, CloudProviderList),
			cloudProjects: () => request(RelayPaths.cloudProjects, CloudProjectList),
			connectCloudProject: (input) =>
				request(RelayPaths.cloudProjects, CloudProject, "POST", input),
			prepareCloudProject: (input) =>
				request(
					RelayPaths.cloudProjectPrepare(input.projectId),
					CloudProjectBuild,
					"POST",
					input,
				),
			cloudWorkspaces: (projectId) =>
				request(
					projectId === undefined
						? RelayPaths.cloudWorkspaces
						: `${RelayPaths.cloudWorkspaces}?projectId=${encodeURIComponent(projectId)}`,
					CloudWorkspaceList,
				),
			cloudWorkspace: (workspaceId) =>
				request(RelayPaths.cloudWorkspace(workspaceId), CloudWorkspace),
			createCloudWorkspace: (input) =>
				request(
					RelayPaths.cloudWorkspaces,
					CloudWorkspaceLaunch,
					"POST",
					input,
				),
			connectCloudWorkspace: (workspaceId) =>
				request(
					RelayPaths.cloudWorkspaceConnectionGrant(workspaceId),
					CloudWorkspaceConnection,
					"POST",
					{},
				),
			cloudChatHistory: (workspaceId) =>
				request(
					RelayPaths.cloudWorkspaceHistory(workspaceId),
					CloudChatHistory,
				),
			cloudWorkspaceAction: (workspaceId, action) =>
				request(
					RelayPaths.cloudWorkspaceAction(workspaceId, action),
					CloudWorkspace,
					"POST",
					{},
				),
			cloudCredentials: () =>
				request(RelayPaths.cloudCredentials, CloudCredentialList),
			connectCloudCredential: (input) =>
				request(
					RelayPaths.cloudCredentials,
					CloudCredentialConnection,
					"POST",
					input,
				),
			disconnectCloudCredential: (kind) =>
				request(
					RelayPaths.cloudCredentialDisconnect(kind),
					CloudCredentialConnection,
					"POST",
					{},
				),
			offers: () => request(RelayPaths.machineOffers, MachineOfferList),
			list: () => request(RelayPaths.machines, MachineList),
			get: (machineId) => request(RelayPaths.machine(machineId), MachineRecord),
			create: (input) =>
				request(RelayPaths.machines, MachineRecord, "POST", input),
			cancel: (machineId) =>
				request(RelayPaths.machineCancel(machineId), MachineRecord, "POST", {}),
			recover: (machineId) =>
				request(
					RelayPaths.machineRecover(machineId),
					MachineRecord,
					"POST",
					{},
				),
			destroy: (input) =>
				request(
					RelayPaths.machineDestroy(input.machineId),
					MachineRecord,
					"POST",
					input,
				),
			checkout: (input) =>
				request(RelayPaths.billingCheckout, BillingCheckout, "POST", input),
			billingPortal: () =>
				request(RelayPaths.billingPortal, BillingPortal, "POST", {}),
			entitlements: () =>
				request(RelayPaths.billingEntitlements, EntitlementList),
			environments: () =>
				request(RelayPaths.environments, RelayEnvironmentList),
			connectEnvironment: (environmentId) =>
				Effect.gen(function* () {
					if (runtimeRole !== "control-plane") {
						return yield* Effect.fail(new MachineControlError("not-allowed"));
					}
					const workosToken = yield* auth
						.getAccessToken()
						.pipe(
							Effect.mapError(() => new MachineControlError("not-allowed")),
						);
					const tokenUrl = `${relayUrl}${RelayPaths.dpopToken}`;
					const tokenResponse = yield* Effect.tryPromise({
						try: async () =>
							fetch(tokenUrl, {
								method: "POST",
								headers: {
									authorization: `Bearer ${workosToken}`,
									dpop: await dpopProof("POST", tokenUrl),
								},
							}),
						catch: () => new MachineControlError("provider-unavailable"),
					});
					if (!tokenResponse.ok) {
						return yield* Effect.fail(
							mapRelayErrorCode(tokenResponse.status, undefined),
						);
					}
					const accessPayload = yield* Effect.tryPromise({
						try: (): Promise<unknown> => tokenResponse.json(),
						catch: () => new MachineControlError("provider-unavailable"),
					});
					const access = yield* Schema.decodeUnknownEffect(RelayAccessToken)(
						accessPayload,
					).pipe(
						Effect.mapError(
							() => new MachineControlError("provider-unavailable"),
						),
					);
					const connectUrl = `${relayUrl}${RelayPaths.connect(environmentId)}`;
					const response = yield* Effect.tryPromise({
						try: async () =>
							fetch(connectUrl, {
								method: "POST",
								headers: {
									authorization: `DPoP ${access.accessToken}`,
									dpop: await dpopProof("POST", connectUrl),
								},
							}),
						catch: () => new MachineControlError("provider-unavailable"),
					});
					if (!response.ok) {
						return yield* Effect.fail(
							mapRelayErrorCode(response.status, undefined),
						);
					}
					const payload = yield* Effect.tryPromise({
						try: (): Promise<unknown> => response.json(),
						catch: () => new MachineControlError("provider-unavailable"),
					});
					return yield* Schema.decodeUnknownEffect(RelayConnectGrant)(
						payload,
					).pipe(
						Effect.mapError(
							() => new MachineControlError("provider-unavailable"),
						),
					);
				}),
		});
	}),
);
