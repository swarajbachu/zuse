import {
	ApiAccessToken,
	ApiConnectGrant,
	ApiEnvironmentList,
	ApiPaths,
	BillingCheckout,
	type BillingCheckoutRequest,
	BillingPortal,
	CloudAccountImage,
	type CloudAccountImageBuildRequest,
	type CloudAuthConfigureRequest,
	CloudAuthLoginOperation,
	type CloudAuthProvider,
	CloudAuthProviderStatus,
	CloudAuthStatus,
	CloudBillingSummary,
	CloudBillingUsagePage,
	CloudChatList,
	type CloudCommandEnvelope,
	CloudGithubStatus,
	CloudProject,
	CloudProjectBuild,
	type CloudProjectConnectRequest,
	CloudProjectList,
	type CloudProjectPrepareRequest,
	CloudProviderList,
	CloudTranscriptCheckpointResult,
	CloudTranscriptMessagePageResult,
	CloudWorkspace,
	CloudWorkspaceConnection,
	type CloudWorkspaceCreateRequest,
	CloudWorkspaceDataKey,
	CloudWorkspaceLaunch,
	CloudWorkspaceList,
	CloudWorkspacePreviewUrl,
	CloudWorkspaceSshAccess,
	CommandAcceptance,
	CommandChangePage,
	CommandStatus,
	EntitlementList,
	type EnvironmentId,
	type MachineCreateRequest,
	type MachineDestroyRequest,
	MachineErrorCode,
	MachineList,
	MachineOfferList,
	MachineRecord,
	PRODUCTION_API_URL,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import {
	Context,
	Duration,
	Effect,
	Layer,
	Schedule,
	Schema,
	Stream,
} from "effect";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import { AuthService } from "../auth/services/auth-service.ts";
import { MachineRuntimeRole } from "./machine-runtime-role.ts";

export interface MachineControlServiceShape {
	readonly cloudAccountImage: () => Effect.Effect<
		CloudAccountImage,
		MachineControlError
	>;
	readonly buildCloudAccountImage: (
		input: CloudAccountImageBuildRequest,
	) => Effect.Effect<CloudAccountImage, MachineControlError>;
	readonly cloudAuthStatus: () => Effect.Effect<
		CloudAuthStatus,
		MachineControlError
	>;
	readonly provisionCloudAuth: () => Effect.Effect<
		CloudAuthStatus,
		MachineControlError
	>;
	readonly configureCloudAuth: (
		input: CloudAuthConfigureRequest,
	) => Effect.Effect<CloudAuthProviderStatus, MachineControlError>;
	readonly startCloudAuthLogin: (
		providerId: "codex" | "grok",
	) => Effect.Effect<CloudAuthLoginOperation, MachineControlError>;
	readonly pollCloudAuthLogin: (
		operationId: string,
	) => Effect.Effect<CloudAuthLoginOperation, MachineControlError>;
	readonly cancelCloudAuthLogin: (
		operationId: string,
	) => Effect.Effect<CloudAuthLoginOperation, MachineControlError>;
	readonly disconnectCloudAuth: (
		providerId: CloudAuthProvider,
	) => Effect.Effect<CloudAuthProviderStatus, MachineControlError>;
	readonly cloudGithubStatus: () => Effect.Effect<
		CloudGithubStatus,
		MachineControlError
	>;
	readonly installCloudGithub: () => Effect.Effect<
		{ readonly url: string },
		MachineControlError
	>;
	readonly disconnectCloudGithub: (
		installationId: number,
	) => Effect.Effect<{ readonly ok: boolean }, MachineControlError>;
	readonly cloudBillingSummary: () => Effect.Effect<
		CloudBillingSummary,
		MachineControlError
	>;
	readonly cloudBillingUsage: (
		cursor?: string,
		limit?: number,
	) => Effect.Effect<CloudBillingUsagePage, MachineControlError>;
	readonly setCloudBillingCap: (
		overageCapMicros: number,
		idempotencyKey: string,
	) => Effect.Effect<CloudBillingSummary, MachineControlError>;
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
	readonly removeCloudProject: (
		projectId: string,
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
	readonly enqueueCloudCommand: (
		envelope: CloudCommandEnvelope,
	) => Effect.Effect<CommandAcceptance, MachineControlError>;
	readonly cloudWorkspaceDataKey: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspaceDataKey, MachineControlError>;
	readonly cloudCommandStatus: (
		workspaceId: string,
		commandId: string,
	) => Effect.Effect<CommandStatus, MachineControlError>;
	readonly watchCloudCommands: (
		workspaceId: string,
		afterRevision: number,
	) => Effect.Effect<CommandChangePage, MachineControlError>;
	readonly cancelCloudCommand: (
		workspaceId: string,
		commandId: string,
	) => Effect.Effect<CommandStatus, MachineControlError>;
	readonly cloudTranscriptCheckpoint: (
		workspaceId: string,
		sessionId: string,
		cursor?: { readonly epoch: string; readonly version: number },
	) => Effect.Effect<CloudTranscriptCheckpointResult, MachineControlError>;
	readonly cloudTranscriptMessagePage: (
		workspaceId: string,
		sessionId: string,
		cursor: { readonly epoch: string; readonly version: number },
		beforeSequence: number,
	) => Effect.Effect<CloudTranscriptMessagePageResult, MachineControlError>;
	readonly watchCloudWorkspace: (
		workspaceId: string,
		afterRevision?: number,
	) => Stream.Stream<CloudWorkspace, MachineControlError>;
	readonly createCloudWorkspace: (
		input: CloudWorkspaceCreateRequest,
	) => Effect.Effect<CloudWorkspaceLaunch, MachineControlError>;
	readonly connectCloudWorkspace: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspaceConnection, MachineControlError>;
	readonly cloudChats: (
		projectId?: string,
		scope?: "active" | "archived" | "all",
	) => Effect.Effect<CloudChatList, MachineControlError>;
	readonly cloudWorkspaceAction: (
		workspaceId: string,
		action: "pause" | "resume" | "restart" | "archive" | "unarchive" | "delete",
		options?: Readonly<{ recoverRuntime?: boolean; commandId?: string }>,
	) => Effect.Effect<CloudWorkspace, MachineControlError>;
	readonly cloudWorkspaceSshAccess: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspaceSshAccess, MachineControlError>;
	readonly cloudWorkspacePreviewUrl: (
		workspaceId: string,
		port: number,
	) => Effect.Effect<CloudWorkspacePreviewUrl, MachineControlError>;
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
		ApiEnvironmentList,
		MachineControlError
	>;
	readonly connectEnvironment: (
		environmentId: EnvironmentId,
	) => Effect.Effect<ApiConnectGrant, MachineControlError>;
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

/**
 * Adapt API's REST workspace resource into a revision-ordered control-plane
 * stream. Polling and retry live here once per RPC subscription, never in UI
 * components or stores.
 */
export const streamCloudWorkspaceLifecycle = (
	read: Effect.Effect<CloudWorkspace, MachineControlError>,
	afterRevision?: number,
): Stream.Stream<CloudWorkspace, MachineControlError> =>
	Stream.fromEffect(read).pipe(
		Stream.repeat(Schedule.spaced("500 millis")),
		Stream.retry(
			Schedule.exponential("250 millis").pipe(
				Schedule.modifyDelay(({ duration }) =>
					Effect.succeed(
						Duration.millis(Math.min(Duration.toMillis(duration), 10_000)),
					),
				),
				Schedule.jittered,
			),
		),
		Stream.mapAccum(
			() => afterRevision ?? -1,
			(appliedRevision, workspace) => {
				if (workspace.revision <= appliedRevision) return [appliedRevision, []];
				return [workspace.revision, [workspace]];
			},
		),
	);

export const resolveMachineApiUrl = (
	env: Readonly<Record<string, string | undefined>> = process.env,
): string => (env.ZUSE_API_URL ?? PRODUCTION_API_URL).replace(/\/+$/u, "");

export const mapApiErrorCode = (
	status: number,
	code: unknown,
): MachineControlError => {
	if (code === "machine_alpha_not_allowed") {
		return new MachineControlError("not-allowed");
	}
	if (code === "cloud_beta_access_required") {
		return new MachineControlError("beta-access-required");
	}
	if (code === "cloud_beta_access_unavailable") {
		return new MachineControlError("beta-access-unavailable");
	}
	if (code === "invalid_machine_offer") {
		return new MachineControlError("invalid-offer");
	}
	if (code === "entitlement_required") {
		return new MachineControlError("entitlement-required");
	}
	if (code === "cloud_entitlement_required")
		return new MachineControlError("entitlement-required");
	if (
		code === "cloud_project_not_ready" ||
		code === "cloud_image_rebuild_required"
	)
		return new MachineControlError("invalid-state");
	if (code === "cloud_workspace_unavailable")
		return new MachineControlError("invalid-state");
	if (code === "cloud_credential_connection_required")
		return new MachineControlError("credential-required");
	if (typeof code === "string" && code.startsWith("cloud_branch_in_use:"))
		return new MachineControlError("branch-in-use");
	if (code === "machine_limit_reached") {
		return new MachineControlError("machine-limit-reached");
	}
	if (code === "tunnel_unavailable") {
		return new MachineControlError("tunnel-unavailable");
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
	// An expired or rejected credential must surface as an auth fault, not a
	// generic failure — clients stop retrying and prompt for sign-in instead
	// of looping a reconnect that can never succeed.
	if (status === 401 || status === 403) {
		return new MachineControlError("not-allowed");
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
		const apiUrl = resolveMachineApiUrl();
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
						fetch(`${apiUrl}${path}`, {
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
								readonly code?: unknown;
							}>,
					);
					return yield* Effect.fail(
						mapApiErrorCode(response.status, payload.error ?? payload.code),
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
			cloudAccountImage: () =>
				request(ApiPaths.cloudAccountImage, CloudAccountImage),
			buildCloudAccountImage: (input) =>
				request(
					ApiPaths.cloudAccountImageBuild,
					CloudAccountImage,
					"POST",
					input,
				),
			cloudAuthStatus: () => request(ApiPaths.cloudAuth, CloudAuthStatus),
			provisionCloudAuth: () =>
				request(ApiPaths.cloudAuthProvision, CloudAuthStatus, "POST", {}),
			configureCloudAuth: (input) =>
				request(
					ApiPaths.cloudAuthConfigure,
					CloudAuthProviderStatus,
					"POST",
					input,
				),
			startCloudAuthLogin: (providerId) =>
				request(ApiPaths.cloudAuthLoginStart, CloudAuthLoginOperation, "POST", {
					providerId,
				}),
			pollCloudAuthLogin: (operationId) =>
				request(
					ApiPaths.cloudAuthLoginPoll(operationId),
					CloudAuthLoginOperation,
				),
			cancelCloudAuthLogin: (operationId) =>
				request(
					ApiPaths.cloudAuthLoginCancel(operationId),
					CloudAuthLoginOperation,
					"POST",
					{},
				),
			disconnectCloudAuth: (providerId) =>
				request(
					ApiPaths.cloudAuthDisconnect(providerId),
					CloudAuthProviderStatus,
					"DELETE",
				),
			cloudGithubStatus: () => request(ApiPaths.cloudGithub, CloudGithubStatus),
			installCloudGithub: () =>
				request(
					ApiPaths.cloudGithubInstall,
					Schema.Struct({ url: Schema.String }),
					"POST",
					{},
				),
			disconnectCloudGithub: (installationId) =>
				request(
					ApiPaths.cloudGithubDisconnect(installationId),
					Schema.Struct({ ok: Schema.Boolean }),
					"DELETE",
				),
			cloudBillingSummary: () =>
				request(ApiPaths.cloudBillingSummary, CloudBillingSummary),
			cloudBillingUsage: (cursor, limit) => {
				const query = new URLSearchParams();
				if (cursor !== undefined) query.set("cursor", cursor);
				if (limit !== undefined) query.set("limit", String(limit));
				const suffix = query.size === 0 ? "" : `?${query.toString()}`;
				return request(
					`${ApiPaths.cloudBillingUsage}${suffix}`,
					CloudBillingUsagePage,
				);
			},
			setCloudBillingCap: (overageCapMicros, idempotencyKey) =>
				request(ApiPaths.cloudBillingCap, CloudBillingSummary, "POST", {
					overageCapMicros,
					idempotencyKey,
				}),
			cloudProviders: () => request(ApiPaths.cloudProviders, CloudProviderList),
			cloudProjects: () => request(ApiPaths.cloudProjects, CloudProjectList),
			connectCloudProject: (input) =>
				request(ApiPaths.cloudProjects, CloudProject, "POST", input),
			removeCloudProject: (projectId) =>
				request(ApiPaths.cloudProject(projectId), CloudProject, "DELETE"),
			prepareCloudProject: (input) =>
				request(
					ApiPaths.cloudProjectPrepare(input.projectId),
					CloudProjectBuild,
					"POST",
					input,
				),
			cloudWorkspaces: (projectId) =>
				request(
					projectId === undefined
						? ApiPaths.cloudWorkspaces
						: `${ApiPaths.cloudWorkspaces}?projectId=${encodeURIComponent(projectId)}`,
					CloudWorkspaceList,
				),
			cloudWorkspace: (workspaceId) =>
				request(ApiPaths.cloudWorkspace(workspaceId), CloudWorkspace),
			enqueueCloudCommand: (envelope) =>
				request(
					ApiPaths.cloudWorkspaceCommands(envelope.workspaceId),
					CommandAcceptance,
					"POST",
					envelope,
				),
			cloudWorkspaceDataKey: (workspaceId) =>
				request(
					ApiPaths.cloudWorkspaceDataKey(workspaceId),
					CloudWorkspaceDataKey,
				),
			cloudCommandStatus: (workspaceId, commandId) =>
				request(
					ApiPaths.cloudWorkspaceCommand(workspaceId, commandId),
					CommandStatus,
				),
			watchCloudCommands: (workspaceId, afterRevision) =>
				request(
					`${ApiPaths.cloudWorkspaceCommandWatch(workspaceId)}?afterRevision=${afterRevision}`,
					CommandChangePage,
				),
			cancelCloudCommand: (workspaceId, commandId) =>
				request(
					ApiPaths.cloudWorkspaceCommand(workspaceId, commandId),
					CommandStatus,
					"DELETE",
				),
			cloudTranscriptCheckpoint: (workspaceId, sessionId, cursor) =>
				request(
					`${ApiPaths.cloudWorkspaceTranscriptCheckpoint(workspaceId, sessionId)}${
						cursor === undefined
							? ""
							: `?epoch=${encodeURIComponent(cursor.epoch)}&version=${cursor.version}`
					}`,
					CloudTranscriptCheckpointResult,
				),
			cloudTranscriptMessagePage: (
				workspaceId,
				sessionId,
				cursor,
				beforeSequence,
			) =>
				request(
					`${ApiPaths.cloudWorkspaceTranscriptMessagePage(workspaceId, sessionId)}?epoch=${encodeURIComponent(cursor.epoch)}&version=${cursor.version}&beforeSequence=${beforeSequence}`,
					CloudTranscriptMessagePageResult,
				),
			watchCloudWorkspace: (workspaceId, afterRevision) =>
				streamCloudWorkspaceLifecycle(
					request(ApiPaths.cloudWorkspace(workspaceId), CloudWorkspace),
					afterRevision,
				),
			createCloudWorkspace: (input) =>
				request(ApiPaths.cloudWorkspaces, CloudWorkspaceLaunch, "POST", input),
			connectCloudWorkspace: (workspaceId) =>
				request(
					ApiPaths.cloudWorkspaceConnectionTicket(workspaceId),
					CloudWorkspaceConnection,
					"POST",
					{},
				),
			cloudChats: (projectId, scope) =>
				request(
					`${ApiPaths.cloudChats}?${new URLSearchParams({
						...(projectId === undefined ? {} : { projectId }),
						...(scope === undefined ? {} : { scope }),
					}).toString()}`,
					CloudChatList,
				),
			cloudWorkspaceAction: (workspaceId, action, options) =>
				request(
					ApiPaths.cloudWorkspaceAction(workspaceId, action),
					CloudWorkspace,
					"POST",
					{ workspaceId, ...options },
				),
			cloudWorkspaceSshAccess: (workspaceId) =>
				request(
					ApiPaths.cloudWorkspaceSshAccess(workspaceId),
					CloudWorkspaceSshAccess,
					"POST",
					{ workspaceId },
				),
			cloudWorkspacePreviewUrl: (workspaceId, port) =>
				request(
					ApiPaths.cloudWorkspacePreviewUrl(workspaceId),
					CloudWorkspacePreviewUrl,
					"POST",
					{ port },
				),
			offers: () => request(ApiPaths.machineOffers, MachineOfferList),
			list: () => request(ApiPaths.machines, MachineList),
			get: (machineId) => request(ApiPaths.machine(machineId), MachineRecord),
			create: (input) =>
				request(ApiPaths.machines, MachineRecord, "POST", input),
			cancel: (machineId) =>
				request(ApiPaths.machineCancel(machineId), MachineRecord, "POST", {}),
			recover: (machineId) =>
				request(ApiPaths.machineRecover(machineId), MachineRecord, "POST", {}),
			destroy: (input) =>
				request(
					ApiPaths.machineDestroy(input.machineId),
					MachineRecord,
					"POST",
					input,
				),
			checkout: (input) =>
				request(ApiPaths.billingCheckout, BillingCheckout, "POST", input),
			billingPortal: () =>
				request(ApiPaths.billingPortal, BillingPortal, "POST", {}),
			entitlements: () =>
				request(ApiPaths.billingEntitlements, EntitlementList),
			environments: () => request(ApiPaths.environments, ApiEnvironmentList),
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
					const tokenUrl = `${apiUrl}${ApiPaths.dpopToken}`;
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
							mapApiErrorCode(tokenResponse.status, undefined),
						);
					}
					const accessPayload = yield* Effect.tryPromise({
						try: (): Promise<unknown> => tokenResponse.json(),
						catch: () => new MachineControlError("provider-unavailable"),
					});
					const access = yield* Schema.decodeUnknownEffect(ApiAccessToken)(
						accessPayload,
					).pipe(
						Effect.mapError(
							() => new MachineControlError("provider-unavailable"),
						),
					);
					const connectUrl = `${apiUrl}${ApiPaths.connect(environmentId)}`;
					// Always demand a managed (tunnel/public-TLS) endpoint. Without
					// this the api may fall back to the environment's advertised
					// endpoint, which for a default `zuse serve` is its own loopback —
					// a remote client would then dial 127.0.0.1 on the wrong machine.
					const response = yield* Effect.tryPromise({
						try: async () =>
							fetch(connectUrl, {
								method: "POST",
								headers: {
									authorization: `DPoP ${access.accessToken}`,
									dpop: await dpopProof("POST", connectUrl),
									"content-type": "application/json",
								},
								body: JSON.stringify({
									wireProtocolVersion: WIRE_PROTOCOL_VERSION,
									requireManaged: true,
								}),
							}),
						catch: () => new MachineControlError("provider-unavailable"),
					});
					if (!response.ok) {
						const failure = yield* Effect.promise(
							() =>
								response.json().catch(() => ({})) as Promise<{
									readonly error?: unknown;
								}>,
						);
						return yield* Effect.fail(
							mapApiErrorCode(response.status, failure.error),
						);
					}
					const payload = yield* Effect.tryPromise({
						try: (): Promise<unknown> => response.json(),
						catch: () => new MachineControlError("provider-unavailable"),
					});
					return yield* Schema.decodeUnknownEffect(ApiConnectGrant)(
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
