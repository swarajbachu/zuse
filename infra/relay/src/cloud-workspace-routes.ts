import {
	CloudCredentialConnectRequest,
	CloudCredentialKind,
	CloudProjectConnectRequest,
	CloudProjectPrepareRequest,
	CloudWorkspaceCreateRequest,
	MachineEnrollRequest,
	RelayPaths,
} from "@zuse/contracts";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { Clock, Effect, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { CloudCredentialVault } from "./cloud-credential-vault.ts";
import { hasUsableCloudWorkspaceEntitlement } from "./cloud-entitlement.ts";
import {
	type CloudProjectBuildRecord,
	type CloudProjectRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	sha256Hex,
	verifyEnvironmentLinkProof,
} from "./crypto.ts";
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	type RelayError,
	serviceUnavailable,
	unauthorized,
} from "./errors.ts";
import { MachineControlConfiguration } from "./machine-config.ts";
import { MachineStore } from "./machine-store.ts";
import type { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import { RelayStore } from "./store.ts";
import type { WorkosVerifier } from "./workos.ts";

export type CloudWorkspaceRouteContext =
	| CloudWorkspaceStore
	| CloudCredentialVault
	| MachineStore
	| SandboxProviders
	| SandboxOfferConfiguration
	| RelayConfiguration
	| RelayStore
	| WorkosVerifier;

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
const decodeBody = <A, I>(
	schema: Schema.Codec<A, I>,
	request: Request,
): Effect.Effect<A, RelayError> =>
	Effect.tryPromise({
		try: (): Promise<unknown> => request.json(),
		catch: () => badRequest("invalid_json"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError(() => badRequest("invalid_request")),
	);

const normalizeRepository = (
	raw: string,
): {
	readonly identity: string;
	readonly url: string;
	readonly name: string;
} | null => {
	try {
		const url = new URL(raw);
		if (
			url.protocol !== "https:" ||
			url.username.length > 0 ||
			url.password.length > 0
		)
			return null;
		const parts = url.pathname
			.replace(/^\/+|\/+$/gu, "")
			.replace(/\.git$/u, "")
			.split("/");
		if (
			parts.length !== 2 ||
			parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
		)
			return null;
		const [owner, repository] = parts as [string, string];
		return {
			identity: `${url.hostname.toLowerCase()}/${owner.toLowerCase()}/${repository.toLowerCase()}`,
			url: `https://${url.hostname}/${owner}/${repository}.git`,
			name: repository,
		};
	} catch {
		return null;
	}
};

const isSafeCloudEnvironment = (
	environment: Readonly<Record<string, string>>,
): boolean =>
	Object.entries(environment).every(
		([key, value]) =>
			/^[A-Z_][A-Z0-9_]*$/u.test(key) &&
			!/TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API_KEY/u.test(key) &&
			value.length <= 8_192,
	);

const publicProject = (
	project: CloudProjectRecord,
	builds: ReadonlyArray<CloudProjectBuildRecord>,
) => ({
	projectId: project.projectId,
	repositoryIdentity: project.repositoryIdentity,
	repositoryUrl: project.repositoryUrl,
	displayName: project.displayName,
	defaultBranch: project.defaultBranch,
	visibility: project.visibility,
	state: project.state,
	activeBuilds: Object.fromEntries(
		builds
			.filter((build) => build.state === "ready")
			.map((build) => [build.provider, build.buildId]),
	),
	createdAt: project.createdAtMs,
	updatedAt: project.updatedAtMs,
});
const publicBuild = (build: CloudProjectBuildRecord) => ({
	buildId: build.buildId,
	projectId: build.projectId,
	providerId: build.provider,
	state: build.state,
	sourceCommit: build.sourceCommit,
	templateVersion: build.templateVersion,
	configurationDigest: build.configurationDigest,
	createdAt: build.createdAtMs,
	updatedAt: build.updatedAtMs,
});
const publicWorkspace = (workspace: CloudWorkspaceRecord) => ({
	workspaceId: workspace.workspaceId,
	projectId: workspace.projectId,
	buildId: workspace.buildId,
	providerId: workspace.provider,
	branch: workspace.branch,
	baseRef: workspace.baseRef,
	state: workspace.state,
	desiredState: workspace.desiredState,
	statusCode: workspace.statusCode,
	environmentId: workspace.environmentId,
	createdAt: workspace.createdAtMs,
	updatedAt: workspace.updatedAtMs,
	lastActivityAt: workspace.lastActivityAtMs,
	warmRetentionDeadline: workspace.warmRetentionDeadlineMs,
	recoveryAvailable:
		workspace.recoveryBundleKey !== undefined || workspace.state === "archived",
});
const publicCredential = (credential: {
	readonly kind: "github" | "claude" | "codex";
	readonly state: "connected" | "disconnected" | "error";
	readonly credentialVersion: number;
	readonly accountLabel?: string;
	readonly updatedAtMs: number;
}) => ({
	kind: credential.kind,
	state: credential.state,
	version: credential.credentialVersion,
	accountLabel: credential.accountLabel,
	updatedAt: credential.updatedAtMs,
});

const selectedProvider = Effect.fn("selectedCloudProvider")(function* (
	requested?: string,
) {
	const providers = yield* SandboxProviders;
	const config = yield* MachineControlConfiguration;
	const available = providers.availableProviders.filter(
		(provider) =>
			config.availableSandboxProviderIds?.has(provider.providerId) ?? true,
	);
	if (requested !== undefined) {
		if (
			config.availableSandboxProviderIds !== undefined &&
			!config.availableSandboxProviderIds.has(requested)
		)
			return yield* Effect.fail(
				serviceUnavailable("cloud_provider_unavailable"),
			);
		return yield* providers
			.get(requested)
			.pipe(
				Effect.mapError(() => serviceUnavailable("cloud_provider_unavailable")),
			);
	}
	if (available.length === 1) return available[0] as (typeof available)[number];
	const preferred = available.find(
		(provider) => provider.providerId === providers.defaultProviderId,
	);
	if (preferred !== undefined) return preferred;
	return yield* Effect.fail(badRequest("cloud_provider_required"));
});

const hasEntitlement = Effect.fn("hasCloudWorkspaceEntitlement")(function* (
	accountId: string,
	nowMs: number,
) {
	const machineStore = yield* MachineStore;
	const config = yield* MachineControlConfiguration;
	let entitlements = yield* machineStore.listEntitlements(accountId);
	if (
		config.manualEntitlementsEnabled &&
		config.allowlistedAccountIds.has(accountId) &&
		!entitlements.some((item) => item.kind === "cloud-workspace")
	) {
		yield* machineStore.upsertEntitlement({
			entitlementId: `manual-cloud-workspace:${accountId}`,
			accountId,
			kind: "cloud-workspace",
			offerId: "cloud-workspace-standard-v1",
			provider: "manual",
			status: "active",
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
		});
		entitlements = yield* machineStore.listEntitlements(accountId);
	}
	return hasUsableCloudWorkspaceEntitlement(entitlements, nowMs);
});

export const routeCloudWorkspaceRequest = (
	request: Request,
): Effect.Effect<Response | null, RelayError, CloudWorkspaceRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		if (!path.startsWith("/v1/cloud/")) return null;
		const nowMs = yield* Clock.currentTimeMillis;
		const store = yield* CloudWorkspaceStore;
		if (method === "POST" && path === RelayPaths.cloudWorkspaceEnroll) {
			const authorization = request.headers.get("authorization");
			const token = authorization?.startsWith("Bearer ")
				? authorization.slice("Bearer ".length)
				: undefined;
			if (token === undefined)
				return yield* Effect.fail(
					unauthorized("workspace_enrollment_required"),
				);
			const body = yield* decodeBody(MachineEnrollRequest, request);
			const workspace = yield* store.getWorkspace(body.machineId);
			if (
				workspace === null ||
				workspace.enrollmentTokenHash !== (yield* sha256Hex(token)) ||
				(workspace.enrollmentExpiresAtMs ?? 0) <= nowMs ||
				workspace.desiredState !== "ready"
			)
				return yield* Effect.fail(
					unauthorized("workspace_enrollment_rejected"),
				);
			if (
				workspace.providerEndpointHttpBaseUrl === undefined ||
				workspace.providerEndpointWsBaseUrl === undefined
			)
				return yield* Effect.fail(
					serviceUnavailable("workspace_endpoint_unavailable"),
				);
			if (
				workspace.enrolledEnvironmentPublicKey !== undefined &&
				(workspace.enrolledEnvironmentPublicKey !== body.environmentPublicKey ||
					workspace.environmentId !== body.environmentId)
			)
				return yield* Effect.fail(conflict("workspace_identity_conflict"));
			const relayConfig = yield* RelayConfiguration;
			yield* verifyEnvironmentLinkProof({
				proof: body.proof,
				environmentPublicJwk: yield* parseJwk(body.environmentPublicKey),
				expectedChallenge: token,
				expectedEnvironmentId: body.environmentId,
				relayIssuer: relayConfig.relayIssuer,
			});
			const relayStore = yield* RelayStore;
			const endpoint = {
				httpBaseUrl: workspace.providerEndpointHttpBaseUrl,
				wsBaseUrl: workspace.providerEndpointWsBaseUrl,
			};
			const claimed = yield* relayStore.registerEnvironment(
				{
					environmentId: body.environmentId,
					accountId: workspace.accountId,
					providerKind: "cloud",
					label: body.label ?? workspace.branch,
					environmentPublicKey: body.environmentPublicKey,
					httpBaseUrl: endpoint.httpBaseUrl,
					wsBaseUrl: endpoint.wsBaseUrl,
					linkedAtMs: nowMs,
				},
				null,
				"preserve-identity",
			);
			if (!claimed)
				return yield* Effect.fail(conflict("workspace_identity_conflict"));
			const credentialSecret = yield* randomToken("zenv");
			yield* relayStore.insertCredential({
				credentialId: yield* randomToken("cred", 8),
				environmentId: body.environmentId,
				accountId: workspace.accountId,
				credentialHash: yield* sha256Hex(credentialSecret),
				createdAtMs: nowMs,
			});
			const requestedCredentialKinds = Array.isArray(
				workspace.requestConfig.credentialKinds,
			)
				? workspace.requestConfig.credentialKinds
						.map((kind) =>
							Schema.decodeUnknownOption(CloudCredentialKind)(kind),
						)
						.flatMap((decoded) =>
							decoded._tag === "Some" ? [decoded.value] : [],
						)
				: [];
			const vault = yield* CloudCredentialVault;
			const cloudCredentials = yield* Effect.forEach(
				requestedCredentialKinds,
				(kind) =>
					Effect.gen(function* () {
						const connection = yield* store.getCredential(
							workspace.accountId,
							kind,
						);
						if (
							connection?.state !== "connected" ||
							connection.encryptedPayload === undefined
						)
							return yield* Effect.fail(
								conflict("cloud_credential_connection_required"),
							);
						const payload = yield* vault
							.decrypt(
								workspace.accountId,
								kind,
								connection.credentialVersion,
								connection.encryptedPayload,
							)
							.pipe(
								Effect.mapError(() =>
									serviceUnavailable("cloud_credential_delivery_failed"),
								),
							);
						return {
							kind,
							credentialType: payload.credentialType,
							secret: payload.secret,
							version: connection.credentialVersion,
						};
					}),
			);
			yield* store.saveWorkspace({
				...workspace,
				environmentId: body.environmentId,
				enrolledEnvironmentPublicKey: body.environmentPublicKey,
				enrollmentTokenHash: undefined,
				enrollmentExpiresAtMs: undefined,
				state: "setup",
				statusCode: "setup-running",
				nextActionAtMs: nowMs,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return json({
				environmentId: body.environmentId,
				endpoint,
				relayIssuer: relayConfig.relayIssuer,
				environmentCredential: credentialSecret,
				mintPublicKey: relayConfig.mintPublicKey,
				cloudCredentials,
			});
		}
		const principal = yield* requireWorkos(request);

		if (method === "GET" && path === RelayPaths.cloudProviders) {
			const providers = yield* SandboxProviders;
			const config = yield* MachineControlConfiguration;
			const available = providers.availableProviders.filter(
				(provider) =>
					config.availableSandboxProviderIds?.has(provider.providerId) ?? true,
			);
			return json({
				providers: available.map((provider) => ({
					providerId: provider.providerId,
					displayName: provider.displayName,
				})),
				automaticPlacementProviderId: available.some(
					(provider) => provider.providerId === providers.defaultProviderId,
				)
					? providers.defaultProviderId
					: undefined,
			});
		}
		if (method === "GET" && path === RelayPaths.cloudProjects) {
			const projects = yield* store.listProjects(principal.accountId);
			const result = yield* Effect.forEach(projects, (project) =>
				store
					.listBuilds(project.projectId)
					.pipe(Effect.map((builds) => publicProject(project, builds))),
			);
			return json({ projects: result });
		}
		if (method === "POST" && path === RelayPaths.cloudProjects) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const body = yield* decodeBody(CloudProjectConnectRequest, request);
			const repository = normalizeRepository(body.repositoryUrl);
			if (
				repository === null ||
				!/^[A-Za-z0-9._/-]+$/u.test(body.defaultBranch) ||
				!isSafeCloudEnvironment(body.cloudEnvironment ?? {})
			)
				return yield* Effect.fail(badRequest("invalid_repository"));
			if ((body.secretBindings?.length ?? 0) > 0)
				return yield* Effect.fail(
					conflict("cloud_project_secret_vault_required"),
				);
			const configurationDigest = yield* sha256Hex(
				JSON.stringify({
					setupCommand: body.setupCommand ?? null,
					cloudEnvironment: body.cloudEnvironment ?? {},
					secretBindings: [...(body.secretBindings ?? [])].sort(),
				}),
			);
			const project: CloudProjectRecord = {
				projectId: yield* randomToken("project", 12),
				accountId: principal.accountId,
				repositoryIdentity: repository.identity,
				repositoryUrl: repository.url,
				displayName: body.displayName ?? repository.name,
				defaultBranch: body.defaultBranch,
				visibility: body.visibility,
				gitConnectionKind: "github-app",
				setupCommand: body.setupCommand,
				cloudEnvironment: body.cloudEnvironment ?? {},
				secretBindings: body.secretBindings ?? [],
				configurationDigest,
				state: "connected",
				idempotencyKey: body.idempotencyKey,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			return json(publicProject(yield* store.connectProject(project), []), 201);
		}
		const prepareMatch = path.match(
			/^\/v1\/cloud\/projects\/([^/]+)\/prepare$/u,
		);
		if (method === "POST" && prepareMatch !== null) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const projectId = decodeURIComponent(prepareMatch[1] as string);
			const body = yield* decodeBody(CloudProjectPrepareRequest, request);
			if (body.projectId !== projectId)
				return yield* Effect.fail(badRequest("project_mismatch"));
			const project = yield* store.getProject(projectId);
			if (project === null || project.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			if (project.visibility === "private") {
				const gitCredential = yield* store.getCredential(
					principal.accountId,
					"github",
				);
				if (
					gitCredential?.state !== "connected" ||
					gitCredential.encryptedPayload === undefined
				)
					return yield* Effect.fail(
						conflict("cloud_credential_connection_required"),
					);
			}
			const provider = yield* selectedProvider(body.providerId);
			const build: CloudProjectBuildRecord = {
				buildId: yield* randomToken("build", 12),
				projectId,
				accountId: principal.accountId,
				provider: provider.providerId,
				templateVersion: provider.templateVersion,
				configurationDigest: project.configurationDigest,
				state: "queued",
				idempotencyKey: body.idempotencyKey,
				nextActionAtMs: nowMs,
				revision: 0,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			const created = yield* store.createBuild(build);
			if (created.buildId === build.buildId)
				yield* store.saveProject({
					...project,
					state: "preparing",
					updatedAtMs: nowMs,
				});
			const response = json(publicBuild(created), 202);
			response.headers.set("x-zuse-reconcile-cloud-build", created.buildId);
			return response;
		}
		if (method === "GET" && path === RelayPaths.cloudWorkspaces) {
			return json({
				workspaces: (yield* store.listWorkspaces(
					principal.accountId,
					url.searchParams.get("projectId") ?? undefined,
				)).map(publicWorkspace),
			});
		}
		if (method === "POST" && path === RelayPaths.cloudWorkspaces) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const body = yield* decodeBody(CloudWorkspaceCreateRequest, request);
			const project = yield* store.getProject(body.projectId);
			if (project === null || project.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const provider = yield* selectedProvider(body.providerId);
			const build = yield* store.getActiveBuild(
				project.projectId,
				provider.providerId,
			);
			if (build === null || build.snapshotId === undefined)
				return yield* Effect.fail(conflict("cloud_project_not_ready"));
			const workspaceId = yield* randomToken("workspace", 12);
			const branch = body.branch ?? `zuse/${workspaceId.slice(-8)}`;
			if (
				!/^[A-Za-z0-9._/-]+$/u.test(branch) ||
				!/^[A-Za-z0-9._/#-]+$/u.test(body.baseRef)
			)
				return yield* Effect.fail(badRequest("invalid_git_ref"));
			const requestedCredentialKinds = [
				...(body.credentialKinds ?? []),
				...(project.visibility === "private" ? (["github"] as const) : []),
			].filter((kind, index, items) => items.indexOf(kind) === index);
			for (const kind of requestedCredentialKinds) {
				const credential = yield* store.getCredential(
					principal.accountId,
					kind,
				);
				if (
					credential?.state !== "connected" ||
					credential.encryptedPayload === undefined
				)
					return yield* Effect.fail(
						conflict("cloud_credential_connection_required"),
					);
			}
			const requestedSecretBindings = body.secretBindings ?? [];
			if (
				requestedSecretBindings.some(
					(binding) => !project.secretBindings.includes(binding),
				)
			)
				return yield* Effect.fail(badRequest("cloud_secret_not_allowed"));
			const workspace: CloudWorkspaceRecord = {
				workspaceId,
				accountId: principal.accountId,
				projectId: project.projectId,
				buildId: build.buildId,
				provider: provider.providerId,
				branch,
				baseRef: body.baseRef,
				state: "queued",
				desiredState: "ready",
				statusCode: "provisioning-queued",
				credentialEpoch: yield* store.credentialEpoch(principal.accountId),
				idempotencyKey: body.idempotencyKey,
				requestConfig: {
					agent: body.agent,
					model: body.model,
					credentialKinds: requestedCredentialKinds,
					secretBindings: requestedSecretBindings,
					permissions: body.permissions ?? [],
					firstMessage: body.firstMessage,
				},
				nextActionAtMs: nowMs,
				revision: 0,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				lastActivityAtMs: nowMs,
			};
			const outcome = yield* store.createWorkspace(workspace);
			if (outcome.kind === "branch-in-use")
				return yield* Effect.fail(
					conflict(`cloud_branch_in_use:${outcome.workspace.workspaceId}`),
				);
			const response = json(
				publicWorkspace(outcome.workspace),
				outcome.kind === "created" ? 201 : 200,
			);
			if (outcome.kind === "created")
				response.headers.set(
					"x-zuse-reconcile-cloud-workspace",
					outcome.workspace.workspaceId,
				);
			return response;
		}
		const actionMatch = path.match(
			/^\/v1\/cloud\/workspaces\/([^/]+)\/(pause|resume|archive|delete)$/u,
		);
		if (method === "POST" && actionMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(actionMatch[1] as string),
			);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const action = actionMatch[2] as
				| "pause"
				| "resume"
				| "archive"
				| "delete";
			const desiredState =
				action === "resume"
					? "ready"
					: action === "delete"
						? "deleted"
						: action === "archive"
							? "archived"
							: "paused";
			const updated: CloudWorkspaceRecord = {
				...workspace,
				desiredState,
				statusCode: `${action}-queued`,
				nextActionAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			yield* store.saveWorkspace(updated);
			const response = json(publicWorkspace(updated));
			response.headers.set(
				"x-zuse-reconcile-cloud-workspace",
				updated.workspaceId,
			);
			return response;
		}
		if (method === "GET" && path === RelayPaths.cloudCredentials) {
			return json({
				credentials: (yield* store.listCredentials(principal.accountId)).map(
					publicCredential,
				),
			});
		}
		if (method === "POST" && path === RelayPaths.cloudCredentials) {
			const body = yield* decodeBody(CloudCredentialConnectRequest, request);
			if (
				body.secret.length < 8 ||
				body.secret.length > 32_768 ||
				(body.accountLabel?.length ?? 0) > 200 ||
				(body.kind === "github" &&
					body.credentialType !== "repository-token") ||
				(body.kind !== "github" && body.credentialType === "repository-token")
			)
				return yield* Effect.fail(badRequest("invalid_cloud_credential"));
			const vault = yield* CloudCredentialVault;
			if (!vault.enabled)
				return yield* Effect.fail(
					serviceUnavailable("cloud_credential_vault_unavailable"),
				);
			const existing = yield* store.getCredential(
				principal.accountId,
				body.kind,
			);
			const version = (existing?.credentialVersion ?? 0) + 1;
			const encryptedPayload = yield* vault
				.encrypt(principal.accountId, body.kind, version, {
					credentialType: body.credentialType,
					secret: body.secret,
				})
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_credential_store_failed"),
					),
				);
			const saved = yield* store.saveCredential({
				connectionId:
					existing?.connectionId ??
					(yield* randomToken("cloud_credential", 12)),
				accountId: principal.accountId,
				kind: body.kind,
				state: "connected",
				accountLabel: body.accountLabel,
				encryptedPayload,
				encryptionKeyVersion: "v1",
				credentialVersion: version,
				createdAtMs: existing?.createdAtMs ?? nowMs,
				updatedAtMs: nowMs,
			});
			return json(publicCredential(saved), existing === null ? 201 : 200);
		}
		const credentialDisconnectMatch = path.match(
			/^\/v1\/cloud\/credentials\/([^/]+)\/disconnect$/u,
		);
		if (method === "POST" && credentialDisconnectMatch !== null) {
			const decoded = Schema.decodeUnknownOption(CloudCredentialKind)(
				decodeURIComponent(credentialDisconnectMatch[1] as string),
			);
			if (decoded._tag === "None")
				return yield* Effect.fail(badRequest("invalid_cloud_credential"));
			const disconnected = yield* store.disconnectCredential(
				principal.accountId,
				decoded.value,
				nowMs,
			);
			if (disconnected === null)
				return yield* Effect.fail(notFound("cloud_credential_not_found"));
			return json(publicCredential(disconnected));
		}
		return yield* Effect.fail(notFound("cloud_route_not_found"));
	});
