import { cloudCommandEnvelopeEligibility } from "@zuse/cloud-commands";
import {
	ApiPaths,
	ChatSharingDefaults,
	ChatSharingPolicy,
	ChatSharingUpdate,
	CLOUD_COMMAND_PROTOCOL_VERSION,
	CLOUD_RUNTIME_API_ASSETS_CAPABILITY,
	CLOUD_RUNTIME_GITHUB_EXECUTION_CAPABILITY,
	CLOUD_RUNTIME_MACHINE_FORK_CAPABILITY,
	CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH,
	CLOUD_RUNTIME_WORKSPACE_AUTHORIZATION_CAPABILITY,
	CloudAccountImageBuildRequest,
	CloudAccountImageDeleteRequest,
	CloudAuthConfigureRequest,
	CloudAuthLoginStartRequest,
	CloudAuthProvider,
	CloudCommandEnvelope,
	CloudGithubCredentialRequest,
	CloudProjectConnectRequest,
	CloudProjectPrepareRequest,
	CloudProviderConnectionInput,
	CloudRuntimeAccessRequest,
	CloudRuntimeCommandAck,
	CloudRuntimeTurnEventUpload,
	CloudSnapshotImportRequest,
	CloudTranscriptCheckpointUpload,
	CloudTranscriptMessagePageUpload,
	CloudWorkspaceActionRequest,
	CloudWorkspaceCreateRequest,
	CloudWorkspaceResumeRequest,
	CloudWorkspaceRuntimeSummary,
	CloudWorkspaceStartupTimings,
	CodexGrantRequest,
	DEFAULT_RUNTIME_MODE,
	DEVICE_BRIDGE_VERSION,
	DeviceBridgeAction,
	ProviderGrantRequest,
	RuntimeAcknowledgment,
	RuntimeMode,
	WorkspaceSettingsUpdate,
} from "@zuse/contracts";
import { POKEMON_BRANCH_CATALOG } from "@zuse/pokemon-data/branch-catalog";
import { allocatePokemonName } from "@zuse/pokemon-data/name-allocator";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { cloudRuntimeCommandTurnId } from "@zuse/utils/cloud-api";
import { measureCloudStage } from "@zuse/utils/cloud-timing";
import {
	bytesToBase64Url,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { CompactEncrypt, importJWK, type JWK } from "jose";
import { getApiAsset } from "./api-assets.ts";
import { decodeApiMessageContent } from "./api-message-content.ts";
import {
	apiMessageSealContext,
	apiTurnReceiptDigestContext,
	apiWebhookPayloadSealContext,
	digestApiString,
	openApiMessageString,
	sealApiString,
} from "./api-sealing.ts";
import { requireWorkos } from "./auth.ts";
import {
	cancelCloudAuthLogin,
	cloudAuthStatus,
	configureCloudAuth,
	disconnectCloudAuth,
	issueCodexGrant,
	issueProviderGrant,
	pollCloudAuthLogin,
	provisionCloudAuth,
	startCloudAuthLogin,
} from "./cloud-auth-authority.ts";
import {
	type CloudBillingCapacity,
	cloudBillingCapacity,
} from "./cloud-billing-capacity.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { hasUsableCloudWorkspaceEntitlement } from "./cloud-entitlement.ts";
import {
	githubAuthorizationCallback,
	githubAuthorizationUrl,
	githubBotCredential,
	githubInstallationGrants,
	githubWebhook,
	makeGithubInstallUrl,
	refreshGithubConnections,
} from "./cloud-github-app.ts";
import {
	disconnectGithubInstallation,
	githubUserCredential,
	githubUserIdentity,
} from "./cloud-github-user.ts";
import {
	attachCloudMailboxBillingDirective,
	attachCloudMailboxCommandDirective,
	attachCloudMailboxLifecycleDirective,
} from "./cloud-mailbox-directive.ts";
import {
	accountSandboxProviders,
	CloudProviderConnections,
	type ConnectedSandboxProvider,
	connectionIdFor,
	hasProviderConnection,
	listProviderConnections,
	publicProviderConnections,
	resolveResourceProvider,
	saveProviderConnection,
} from "./cloud-provider-connections.ts";
import { runtimeControlPathAllowed } from "./cloud-runtime-control.ts";
import {
	importedSnapshot,
	snapshotBuildCompatible,
	snapshotLogins,
	snapshotRepositoryLayout,
	snapshotSettings,
} from "./cloud-snapshot.ts";
import {
	assertSnapshotUsable,
	deleteRetainedSnapshot,
} from "./cloud-snapshot-storage.ts";
import { SNAPSHOT_MONTH_MICROS } from "./cloud-snapshot-store.ts";
import {
	cloudTranscriptMessagePageObjectKey,
	cloudTranscriptObjectKey,
	createCloudTranscriptKey,
	getCloudTranscriptObject,
	MAX_CLOUD_TRANSCRIPT_CIPHERTEXT_BYTES,
	MAX_CLOUD_TRANSCRIPT_PAGE_CIPHERTEXT_BYTES,
	openCloudTranscriptKey,
	putCloudTranscriptObject,
} from "./cloud-transcript.ts";
import {
	cloudWorkspaceActorPermission,
	cloudWorkspacePermission,
} from "./cloud-workspace-access.ts";
import {
	CloudWorkspaceLaunchIntentCipher,
	hasCloudWorkspaceInitialMessage,
	makeCloudWorkspaceLaunchIntent,
	selectCloudWorkspaceInitialMessageDelivery,
} from "./cloud-workspace-launch-intent.ts";
import {
	cloudWorkspaceLayout,
	cloudWorkspaceRepositoryPath,
} from "./cloud-workspace-paths.ts";
import {
	cloudWorkspaceHasRetainedRuntimeData,
	MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
	withoutRuntimeBootstrapReceipt,
} from "./cloud-workspace-reconciler.ts";
import {
	cloudWorkspaceGatewayEpoch,
	cloudWorkspaceRuntimeGeneration,
} from "./cloud-workspace-runtime-fence.ts";
import {
	type CloudProjectBuildRecord,
	type CloudProjectRecord,
	type CloudWorkspaceLifecycleAction,
	type CloudWorkspaceRecord,
	type CloudWorkspaceRuntimeSummaryRecord,
	CloudWorkspaceStore,
	mailboxLifecycleToDeliver,
	runtimeBootstrapReceiptFromConfig,
	workspaceAcceptsCloudCommandMailbox,
	workspaceDeletionRequested,
	workspaceDestructionFence,
	workspaceSupportsCloudCommandMailbox,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	runtimeCredentialKeyThumbprint,
	runtimeSigningKeyThumbprint,
	sha256Hex,
	signWorkspaceClientTicket,
	signWorkspaceRuntimeTicket,
	verifyRuntimeRenewalProof,
	verifyWorkspaceClientTicket,
	verifyWorkspaceRuntimeTicket,
} from "./crypto.ts";
import { forwardDeviceBridge } from "./device-bridge.ts";
import {
	type ApiError,
	badRequest,
	conflict,
	forbidden,
	notFound,
	serviceUnavailable,
	unauthorized,
} from "./errors.ts";
import { githubCallbackPageHeaders } from "./github-callback-page.ts";
import { decodeBody, json } from "./http.ts";
import { MachineControlConfiguration } from "./machine-config.ts";
import { MachineStore } from "./machine-store.ts";
import {
	getOrganizationSharingDefaults,
	setOrganizationSharingDefaults,
	validateOrganizationChatGrants,
} from "./organizations.ts";
import { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import { ApiStore } from "./store.ts";
import type { WorkosVerifier } from "./workos.ts";
import { requireWorkspaceAccess } from "./workspace-authorization.ts";
import {
	WORKSPACE_GATEWAY_PENDING_PROTOCOL,
	WORKSPACE_GATEWAY_PROTOCOL,
	type WorkspaceGatewayProtocol,
	workspaceGatewayProtocol,
} from "./workspace-gateway-protocol.ts";
import {
	workspaceAccessForPath,
	workspaceScopeForOwner,
} from "./workspace-scope.ts";

export type CloudWorkspaceRouteContext =
	| ApiStore
	| CloudWorkspaceStore
	| CloudWorkspaceLaunchIntentCipher
	| MachineStore
	| SandboxProviders
	| SandboxOfferConfiguration
	| ApiConfiguration
	| WorkosVerifier
	| CloudBillingStore;

// The RPC socket may reconnect without another user action. A signed ticket is
// reusable during this short lease; expiry affects only new connections.
const WORKSPACE_CLIENT_TICKET_TTL_MS = 60_000;
const RUNTIME_CREDENTIAL_TTL_MS = 15 * 60_000;
const ARCHIVED_WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
// SSH bridge access: the hashed ticket is staged inside the sandbox (like the
// runtime boot token) and verified by the runtime's /ssh WebSocket route.
const WORKSPACE_SSH_TICKET_TTL_MS = 12 * 60 * 60_000;
const escapeHtml = (value: string): string =>
	value.replace(
		/[&<>"']/gu,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
const githubCallbackPage = (input: {
	readonly title: string;
	readonly message: string;
}) =>
	// These values currently originate from fixed copy and GitHub login names,
	// but escaping here keeps this public callback safe if its copy evolves.
	new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><body style="margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;min-height:100vh;place-items:center"><main style="max-width:420px;padding:24px"><h1 style="font-size:18px">${escapeHtml(input.title)}</h1><p style="color:#aaa;line-height:1.5">${escapeHtml(input.message)}</p></main></body></html>`,
		{
			status: 400,
			headers: githubCallbackPageHeaders,
		},
	);
export const decodeRuntimeSummary = (
	request: Request,
): Effect.Effect<CloudWorkspaceRuntimeSummary, ApiError> =>
	Effect.gen(function* () {
		const body = yield* Effect.tryPromise({
			try: (): Promise<unknown> => request.json(),
			catch: () => badRequest("invalid_json"),
		});
		const decoded = yield* Schema.decodeUnknownEffect(
			CloudWorkspaceRuntimeSummary,
			{ onExcessProperty: "error" },
		)(body).pipe(Effect.mapError(() => badRequest("invalid_runtime_summary")));
		if (
			!Number.isSafeInteger(decoded.summaryRevision) ||
			decoded.summaryRevision <= 0 ||
			!Number.isSafeInteger(decoded.lastActivityAt) ||
			decoded.lastActivityAt < 0 ||
			!Number.isSafeInteger(decoded.sessionHeadVersion) ||
			decoded.sessionHeadVersion < 0 ||
			decoded.title.length === 0 ||
			decoded.title.length > 500
		)
			return yield* Effect.fail(badRequest("invalid_runtime_summary"));
		return decoded;
	});

const bearer = (request: Request): string | undefined => {
	const authorization = request.headers.get("authorization");
	return authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: undefined;
};

const gatewayCredential = (
	request: Request,
):
	| {
			readonly protocol: WorkspaceGatewayProtocol;
			readonly credential: string;
	  }
	| undefined => {
	const values = request.headers
		.get("sec-websocket-protocol")
		?.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const protocol = workspaceGatewayProtocol(values?.[0]);
	const credential = values?.[1];
	return protocol !== undefined && credential !== undefined
		? { protocol, credential }
		: undefined;
};

const gatewayUrl = (apiIssuer: string, workspaceId: string): string => {
	const url = new URL(ApiPaths.cloudWorkspaceGateway(workspaceId), apiIssuer);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
};

export const normalizeRepository = (
	raw: string,
): {
	readonly identity: string;
	readonly url: string;
	readonly name: string;
} | null => {
	try {
		const trimmed = raw.trim();
		const url = new URL(
			/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)
				? trimmed
				: `https://${trimmed}`,
		);
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

export const currentActiveCloudProjectBuilds = (
	builds: ReadonlyArray<CloudProjectBuildRecord>,
	currentTemplateVersions: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> =>
	Object.fromEntries(
		builds
			.filter(
				(build) =>
					build.state === "ready" &&
					snapshotBuildCompatible(
						build,
						currentTemplateVersions.get(build.provider),
					),
			)
			.sort((left, right) => left.updatedAtMs - right.updatedAtMs)
			.map((build) => [build.provider, build.buildId]),
	);

export const selectCloudWorkspaceBuild = (
	accountBuild: CloudProjectBuildRecord | null,
	projectBuild: CloudProjectBuildRecord | null,
	projectBuilds: ReadonlyArray<CloudProjectBuildRecord>,
	currentTemplateVersion: string,
):
	| {
			readonly build: CloudProjectBuildRecord;
			readonly preparedSnapshotAvailable: boolean;
	  }
	| undefined => {
	const candidates = [
		accountBuild,
		projectBuild,
		...[...projectBuilds].sort(
			(left, right) => right.createdAtMs - left.createdAtMs,
		),
	].filter((build): build is CloudProjectBuildRecord => build !== null);
	const preparedBuild = candidates.find(
		(build) =>
			build.snapshotId !== undefined &&
			snapshotBuildCompatible(build, currentTemplateVersion),
	);
	const build = preparedBuild ?? candidates[0];
	return build === undefined
		? undefined
		: { build, preparedSnapshotAvailable: preparedBuild !== undefined };
};

const publicProject = (
	project: CloudProjectRecord,
	builds: ReadonlyArray<CloudProjectBuildRecord>,
	currentTemplateVersions: ReadonlyMap<string, string>,
) => {
	const latestByProvider = new Map<string, CloudProjectBuildRecord>();
	for (const build of builds) {
		const current = latestByProvider.get(build.provider);
		if (current === undefined || build.createdAtMs > current.createdAtMs)
			latestByProvider.set(build.provider, build);
	}
	return {
		projectId: project.projectId,
		repositoryIdentity: project.repositoryIdentity,
		repositoryUrl: project.repositoryUrl,
		displayName: project.displayName,
		defaultBranch: project.defaultBranch,
		visibility: project.visibility,
		state: project.state,
		activeBuilds: currentActiveCloudProjectBuilds(
			builds,
			currentTemplateVersions,
		),
		latestBuilds: Object.fromEntries(
			[...latestByProvider.values()].map((build) => [
				build.provider,
				{
					buildId: build.buildId,
					providerId: build.provider,
					state: build.state,
					errorCode: build.lastErrorCode,
					createdAt: build.createdAtMs,
					updatedAt: build.updatedAtMs,
				},
			]),
		),
		createdAt: project.createdAtMs,
		updatedAt: project.updatedAtMs,
	};
};

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

const buildMode = (build: CloudProjectBuildRecord | undefined) =>
	build?.idempotencyKey.startsWith("account-image:rebuild:")
		? ("rebuild" as const)
		: build === undefined
			? undefined
			: ("update" as const);

const accountImageRepositories = (
	projects: ReadonlyArray<CloudProjectRecord>,
) =>
	projects.map((project) => ({
		projectId: project.projectId,
		repositoryIdentity: project.repositoryIdentity,
		displayName: project.displayName,
		defaultBranch: project.defaultBranch,
	}));

const storedBuildRepositories = (
	build: CloudProjectBuildRecord,
	fallback: ReturnType<typeof accountImageRepositories>,
) => {
	const repositories = build.settings?.repositories;
	if (!Array.isArray(repositories)) return fallback;
	return repositories.flatMap((value) => {
		if (typeof value !== "object" || value === null) return [];
		const entry = value as Record<string, unknown>;
		return typeof entry.projectId === "string" &&
			typeof entry.repositoryIdentity === "string" &&
			typeof entry.displayName === "string" &&
			typeof entry.defaultBranch === "string"
			? [
					{
						projectId: entry.projectId,
						repositoryIdentity: entry.repositoryIdentity,
						displayName: entry.displayName,
						defaultBranch: entry.defaultBranch,
					},
				]
			: [];
	});
};

/** Keep creation and freshness checks on the same content-based configuration. */
export const cloudAccountImageConfiguration = (input: {
	readonly mode: "update" | "rebuild";
	readonly templateVersion: string;
	readonly codexAuthDeliveryVersion: number;
	readonly providerAuthDeliveryVersion: number;
	readonly projects: readonly Pick<
		CloudProjectRecord,
		"projectId" | "configurationDigest"
	>[];
}) => ({
	mode: input.mode,
	templateVersion: input.templateVersion,
	codexAuthDeliveryVersion: input.codexAuthDeliveryVersion,
	providerAuthDeliveryVersion: input.providerAuthDeliveryVersion,
	repositories: input.projects
		.map((project) => ({
			projectId: project.projectId,
			configurationDigest: project.configurationDigest,
		}))
		.sort((left, right) => left.projectId.localeCompare(right.projectId)),
});

export const isCloudAccountImageOutdated = (input: {
	readonly imagePromotedAtMs: number;
	readonly configurationChanged?: boolean;
	readonly imageTemplateVersion: string;
	readonly currentTemplateVersion: string | undefined;
	readonly projects: ReadonlyArray<{
		readonly state: string;
		readonly updatedAtMs: number;
	}>;
	readonly providers: ReadonlyArray<{
		readonly providerId?: string;
		readonly verifiedAt?: number;
	}>;
	readonly codexAuthDeliveryVersion?: 1;
	readonly requiredCodexAuthDeliveryVersion?: 1;
	readonly providerAuthDeliveryVersion?: 1;
	readonly requiredProviderAuthDeliveryVersion?: 1;
}) =>
	(input.configurationChanged ??
		input.projects.some(
			(project) =>
				project.state !== "ready" ||
				project.updatedAtMs > input.imagePromotedAtMs,
		)) ||
	input.providers.some(
		(status) =>
			input.providerAuthDeliveryVersion !== 1 &&
			!(
				input.codexAuthDeliveryVersion === 1 && status.providerId === "codex"
			) &&
			status.verifiedAt !== undefined &&
			status.verifiedAt > input.imagePromotedAtMs,
	) ||
	input.imageTemplateVersion !== input.currentTemplateVersion ||
	(input.requiredCodexAuthDeliveryVersion === 1 &&
		input.codexAuthDeliveryVersion !== 1) ||
	(input.requiredProviderAuthDeliveryVersion === 1 &&
		input.providerAuthDeliveryVersion !== 1);

export const selectActiveAccountImageBuild = (
	builds: ReadonlyArray<CloudProjectBuildRecord>,
	currentTemplateVersion: string | undefined,
) =>
	builds.find(
		(candidate) =>
			candidate.state === "ready" &&
			candidate.snapshotId !== undefined &&
			snapshotBuildCompatible(candidate, currentTemplateVersion),
	);

export const codexAuthModeForAccountBuild = (
	build: CloudProjectBuildRecord,
	brokerEnrollmentEnabled: boolean,
): "legacy-image" | "broker-v1" => {
	if (
		!brokerEnrollmentEnabled ||
		build.settings?.codexAuthDeliveryVersion !== 1
	)
		return "legacy-image";
	const providers = build.settings.providers;
	if (!Array.isArray(providers)) return "legacy-image";
	return providers.some(
		(provider) =>
			typeof provider === "object" &&
			provider !== null &&
			Reflect.get(provider, "providerId") === "codex" &&
			Reflect.get(provider, "method") === "subscription",
	)
		? "broker-v1"
		: "legacy-image";
};

export const providerAuthModeForAccountBuild = (
	build: CloudProjectBuildRecord,
	brokerEnrollmentEnabled: boolean,
): "legacy-image" | "broker-v1" =>
	brokerEnrollmentEnabled && build.settings?.providerAuthDeliveryVersion === 1
		? "broker-v1"
		: "legacy-image";

const cloudAccountImage = Effect.fn("cloudAccountImage")(function* (
	accountId: string,
	requestedProviderId?: string,
	includeBuildLogs = true,
) {
	const store = yield* CloudWorkspaceStore;
	const apiConfiguration = yield* ApiConfiguration;
	const sandboxProviders = yield* SandboxProviders;
	// Each provider owns its image; omitted selections retain the account default.
	const provider = (yield* accountSandboxProviders(accountId)).find(
		(candidate) =>
			candidate.providerId ===
			(requestedProviderId ?? sandboxProviders.defaultProviderId),
	);
	const projects = yield* store.listProjects(accountId);
	const builds =
		provider === undefined
			? []
			: [
					...(yield* store.listAccountBuilds(accountId, provider.providerId)),
				].sort((left, right) => right.createdAtMs - left.createdAtMs);
	const snapshotRecords =
		provider?.providerId === "box" && provider.connectionId === undefined
			? yield* (yield* CloudBillingStore).snapshots.list(accountId, false)
			: [];
	const storage =
		snapshotRecords.find((r) => r.state === "retained") ??
		snapshotRecords.find(
			(r) => r.state === "deleting" && r.retainedAtMs !== undefined,
		);
	const unavailable = new Set(
		snapshotRecords
			.filter((r) => r.state === "deleting" || r.state === "deleted")
			.map((r) => r.snapshotId),
	);
	const usableBuilds = builds.filter(
		(b) => b.snapshotId === undefined || !unavailable.has(b.snapshotId),
	);
	const latest = builds[0];
	const building = builds.find(
		(candidate) =>
			candidate.state === "queued" ||
			candidate.state === "building" ||
			candidate.state === "sanitizing",
	);
	const active = selectActiveAccountImageBuild(
		usableBuilds,
		provider?.templateVersion,
	);
	const auth = yield* cloudAuthStatus(accountId);
	const providers = auth.providers.map((status) => ({
		providerId: status.providerId,
		state:
			status.state === "unsupported-for-sandbox"
				? ("error" as const)
				: status.state,
		method: status.method,
		verifiedAt: status.verifiedAt,
	}));
	const authBroken =
		!importedSnapshot(active) &&
		providers.some(
			(status) =>
				active?.settings?.providerAuthDeliveryVersion !== 1 &&
				!(
					active?.settings?.codexAuthDeliveryVersion === 1 &&
					status.providerId === "codex"
				) &&
				status.method !== undefined &&
				(status.state === "expired" || status.state === "error"),
		);
	const currentConfigurationDigest =
		active === undefined
			? undefined
			: yield* sha256Hex(
					JSON.stringify(
						cloudAccountImageConfiguration({
							mode: buildMode(active) ?? "update",
							templateVersion: active.templateVersion,
							codexAuthDeliveryVersion:
								active.settings?.codexAuthDeliveryVersion === 1 ? 1 : 0,
							providerAuthDeliveryVersion:
								active.settings?.providerAuthDeliveryVersion === 1 ? 1 : 0,
							projects,
						}),
					),
				);
	const outdated =
		active !== undefined &&
		!importedSnapshot(active) &&
		isCloudAccountImageOutdated({
			imagePromotedAtMs: active.updatedAtMs,
			configurationChanged:
				active.configurationDigest !== currentConfigurationDigest,
			imageTemplateVersion: active.templateVersion,
			currentTemplateVersion: provider?.templateVersion,
			projects,
			providers,
			...(active.settings?.codexAuthDeliveryVersion === 1
				? { codexAuthDeliveryVersion: 1 as const }
				: {}),
			...(active.settings?.providerAuthDeliveryVersion === 1
				? { providerAuthDeliveryVersion: 1 as const }
				: {}),
			...(apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled
				? { requiredCodexAuthDeliveryVersion: 1 as const }
				: {}),
			...(apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled
				? { requiredProviderAuthDeliveryVersion: 1 as const }
				: {}),
		});
	const latestBuildFailed =
		latest?.state === "failed" &&
		latest.lastErrorCode !== "saved-image-deleted";
	const latestFailedAfterActive =
		latestBuildFailed &&
		(active === undefined || latest.createdAtMs > active.updatedAtMs);
	const state =
		building !== undefined
			? ("building" as const)
			: latestFailedAfterActive
				? ("failed" as const)
				: active === undefined
					? latestBuildFailed
						? ("failed" as const)
						: ("not-built" as const)
					: authBroken
						? ("auth-broken" as const)
						: outdated
							? ("outdated" as const)
							: ("ready" as const);
	const statusBuild = building ?? active ?? latest;
	const repositories =
		statusBuild === undefined
			? accountImageRepositories(projects)
			: storedBuildRepositories(
					statusBuild,
					accountImageRepositories(projects),
				);
	return {
		state,
		source: importedSnapshot(statusBuild) ? "custom-snapshot" : "managed",
		...(active !== undefined && importedSnapshot(active)
			? {
					snapshot: {
						snapshotId: snapshotSettings(active).snapshotId,
						agentAuthentication: snapshotSettings(active).agentAuthentication,
						gitAuthentication: snapshotSettings(active).gitAuthentication,
						runtimeUser: snapshotSettings(active).runtimeUser,
						revision: active.buildId,
						...snapshotLogins(active),
						repositories: active.settings?.repositories ?? [],
					},
				}
			: {}),
		generation: active?.buildId,
		storage:
			storage === undefined
				? undefined
				: {
						snapshotId: storage.snapshotId,
						state:
							storage.state === "retained"
								? ("retained" as const)
								: ("deleting" as const),
						monthlyCostMicros: SNAPSHOT_MONTH_MICROS,
						graceUntil: storage.graceUntilMs,
						billingEnabled:
							apiConfiguration.cloudSnapshotBillingCutoverAtMs !== undefined &&
							apiConfiguration.cloudSnapshotBillingCutoverAtMs <=
								(yield* Clock.currentTimeMillis),
					},
		providerId: provider?.providerId,
		runtimeVersion: active?.templateVersion ?? provider?.templateVersion,
		buildMode: buildMode(statusBuild),
		progressPhase: building?.state,
		errorCode: latestFailedAfterActive ? latest.lastErrorCode : undefined,
		repositories,
		providers,
		builds: builds.slice(0, 12).map((build) => ({
			source: importedSnapshot(build)
				? ("custom-snapshot" as const)
				: ("managed" as const),
			buildId: build.buildId,
			state: build.state,
			mode: buildMode(build) ?? "update",
			active: build.buildId === active?.buildId,
			progressPhase:
				build.state === "queued" ||
				build.state === "building" ||
				build.state === "sanitizing"
					? build.state
					: undefined,
			errorCode: build.lastErrorCode,
			logText: includeBuildLogs ? build.logText : undefined,
			runtimeVersion: build.templateVersion,
			configurationDigest: build.configurationDigest,
			repositories: storedBuildRepositories(build, repositories),
			providers,
			createdAt: build.createdAtMs,
			updatedAt: build.updatedAtMs,
		})),
		...(active?.settings?.codexAuthDeliveryVersion === 1
			? { codexAuthDeliveryVersion: 1 as const }
			: {}),
		...(active?.settings?.providerAuthDeliveryVersion === 1
			? { providerAuthDeliveryVersion: 1 as const }
			: {}),
		builtAt: active?.updatedAtMs,
		updatedAt:
			statusBuild?.updatedAtMs ??
			projects.reduce(
				(latestAt, project) => Math.max(latestAt, project.updatedAtMs),
				0,
			),
	};
});

const startupTimings = (
	workspace: CloudWorkspaceRecord,
): CloudWorkspaceStartupTimings => {
	const decoded = Schema.decodeUnknownOption(CloudWorkspaceStartupTimings)(
		workspace.requestConfig.startupTimings,
	);
	return decoded._tag === "Some"
		? decoded.value
		: CloudWorkspaceStartupTimings.make({});
};

export const startupPhase = (workspace: CloudWorkspaceRecord) => {
	if (workspace.state === "failed") return "failed" as const;
	// Warm resumes can reuse an already-acknowledged launch intent. In that case
	// the runtime reports repository-ready, so there is no new agent-started
	// timestamp even though the durable status is already authoritative.
	if (workspace.statusCode === "agent-running") return "running" as const;
	if (startupTimings(workspace).agentStartedAt !== undefined)
		return "running" as const;
	if (startupTimings(workspace).repositoryReadyAt !== undefined)
		return "starting-agent" as const;
	if (workspace.runtimeState === "online") return "syncing-repository" as const;
	if (workspace.runtimeState === "connecting")
		return "authenticating-runtime" as const;
	if (workspace.providerSandboxId !== undefined) return "booting" as const;
	return "allocating" as const;
};

export const failedWorkspaceResumeTarget = (
	workspace: Pick<CloudWorkspaceRecord, "providerSandboxId" | "statusCode">,
) => {
	if (
		workspace.providerSandboxId === undefined ||
		workspace.statusCode === "provider-sandbox-missing"
	)
		return { state: "queued", providerSandboxId: undefined } as const;
	if (
		/^(?:initializing|updating-runtime|starting-runtime|syncing-repository|setup)-failed$/u.test(
			workspace.statusCode,
		)
	)
		return {
			state: "queued",
			providerSandboxId: workspace.providerSandboxId,
		} as const;
	return {
		state: "resuming",
		providerSandboxId: workspace.providerSandboxId,
	} as const;
};

export const cloudWorkspaceResumeIsAlreadyRequested = (
	workspace: Pick<CloudWorkspaceRecord, "desiredState" | "state">,
): boolean =>
	workspace.desiredState === "ready" && workspace.state !== "failed";

const workspaceFailureDiagnostic = (
	workspace: CloudWorkspaceRecord,
): string | undefined =>
	typeof workspace.requestConfig.startupFailureDiagnostic === "string"
		? workspace.requestConfig.startupFailureDiagnostic
		: typeof workspace.requestConfig.launchErrorCode === "string"
			? workspace.requestConfig.launchErrorCode
			: undefined;

const workspaceAuthMode = (
	value: unknown,
): "legacy-image" | "broker-v1" | "snapshot-native" =>
	value === "snapshot-native" || value === "broker-v1" ? value : "legacy-image";

const publicWorkspace = (
	workspace: CloudWorkspaceRecord,
	summary?: CloudWorkspaceRuntimeSummaryRecord | null,
) => ({
	nativeAgentAccess: currentCloudRuntimeSummary(workspace, summary)
		?.nativeAgentAccess,
	workspaceId: workspace.workspaceId,
	projectId: workspace.projectId,
	buildId: workspace.buildId,
	imageGeneration: workspace.buildId,
	providerId: workspace.provider,
	codexAuthMode: workspaceAuthMode(workspace.requestConfig.codexAuthMode),
	providerAuthMode: workspaceAuthMode(workspace.requestConfig.providerAuthMode),
	branch: workspace.branch,
	baseRef: workspace.baseRef,
	state: workspace.state,
	desiredState: workspace.desiredState,
	statusCode: workspace.statusCode,
	failureDiagnostic: workspaceFailureDiagnostic(workspace),
	startupPhase: startupPhase(workspace),
	startupTimings: startupTimings(workspace),
	runtimeState: workspace.runtimeState,
	revision: workspace.revision,
	chatId: workspace.chatId,
	initialSessionId: workspace.initialSessionId,
	createdAt: workspace.createdAtMs,
	updatedAt: workspace.updatedAtMs,
	lastActivityAt: workspace.lastActivityAtMs,
});

const runtimeModeFromRequestConfig = (
	requestConfig: Readonly<Record<string, unknown>>,
) => {
	const decoded = Schema.decodeUnknownOption(RuntimeMode)(
		requestConfig.runtimeMode,
	);
	return decoded._tag === "Some" ? decoded.value : DEFAULT_RUNTIME_MODE;
};

/** Runtime-derived metadata is authoritative only inside its generation fence. */
export const currentCloudRuntimeSummary = (
	workspace: CloudWorkspaceRecord,
	runtimeSummary?: CloudWorkspaceRuntimeSummaryRecord | null,
): CloudWorkspaceRuntimeSummaryRecord | null =>
	runtimeSummary?.runtimeGeneration ===
	cloudWorkspaceRuntimeGeneration(workspace)
		? runtimeSummary
		: null;

const workspaceRuntimeSupportsScope = (
	workspace: CloudWorkspaceRecord,
): boolean =>
	workspaceScopeForOwner(workspace.accountId).kind !== "organization" ||
	runtimeBootstrapReceiptFromConfig(
		workspace.requestConfig,
	)?.capabilities?.includes(
		CLOUD_RUNTIME_WORKSPACE_AUTHORIZATION_CAPABILITY,
	) === true;

const workspaceRuntimeStorageUnavailable = (
	workspace: CloudWorkspaceRecord,
): boolean =>
	workspace.statusCode === "runtime-storage-replaced" ||
	workspace.requestConfig.launchErrorCode === "runtime-storage-replaced";

export const publicCloudWorkspaceSummary = (
	workspace: CloudWorkspaceRecord,
	project: CloudProjectRecord,
	unread: boolean,
	lastMessageAt: number | null,
	runtimeSummary?: CloudWorkspaceRuntimeSummaryRecord | null,
) => {
	const currentSummary = currentCloudRuntimeSummary(workspace, runtimeSummary);
	const recoveringRetainedStorage =
		workspace.requestConfig.runtimeSessionRecoveryPending === true;
	return {
		workspaceScope: workspaceScopeForOwner(workspace.accountId),
		workspaceId: workspace.workspaceId,
		projectId: project.projectId,
		repositoryIdentity: project.repositoryIdentity,
		repositoryDisplayName: project.displayName,
		chatId: workspace.chatId,
		initialSessionId: workspace.initialSessionId,
		activeSessionId:
			currentSummary === null
				? recoveringRetainedStorage
					? null
					: workspace.initialSessionId
				: currentSummary.activeSessionId,
		title:
			currentSummary?.title ??
			(typeof workspace.requestConfig.title === "string"
				? workspace.requestConfig.title
				: workspace.branch),
		branch: workspace.branch,
		providerId: workspace.provider,
		codexAuthMode: workspaceAuthMode(workspace.requestConfig.codexAuthMode),
		providerAuthMode: workspaceAuthMode(
			workspace.requestConfig.providerAuthMode,
		),
		agent:
			typeof workspace.requestConfig.agent === "string"
				? workspace.requestConfig.agent
				: "codex",
		model:
			typeof workspace.requestConfig.model === "string"
				? workspace.requestConfig.model
				: "",
		runtimeMode: runtimeModeFromRequestConfig(workspace.requestConfig),
		state: workspace.state,
		desiredState: workspace.desiredState,
		runtimeState: workspace.runtimeState,
		statusCode: workspace.statusCode,
		failureDiagnostic: workspaceFailureDiagnostic(workspace),
		startupPhase: startupPhase(workspace),
		revision: workspace.revision,
		summaryRevision: currentSummary?.summaryRevision ?? 0,
		nativeAgentAccess: currentSummary?.nativeAgentAccess,
		sessionHeadVersion:
			currentSummary?.sessionHeadVersion ??
			(recoveringRetainedStorage
				? 0
				: typeof workspace.requestConfig.sessionHeadVersion === "number"
					? workspace.requestConfig.sessionHeadVersion
					: 0),
		unread,
		lastMessageAt: currentSummary?.lastActivityAtMs ?? lastMessageAt,
		lastUserMessageAt: runtimeSummary?.lastUserMessageAtMs ?? null,
		...(workspace.state === "archived" || workspace.desiredState === "archived"
			? {
					archivedAt: workspace.archiveRequestedAtMs ?? workspace.updatedAtMs,
				}
			: {}),
		createdAt: workspace.createdAtMs,
		updatedAt: Math.max(
			workspace.updatedAtMs,
			currentSummary?.updatedAtMs ?? 0,
		),
	};
};

export const cloudProviderOptions = Effect.fn("cloudProviderOptions")(
	function* (ownerId: string, nowMs: number) {
		const config = yield* MachineControlConfiguration;
		const configured = yield* accountSandboxProviders(ownerId);
		const onlyOwnKeys =
			configured.some((provider) => provider.connectionId !== undefined) &&
			!(yield* hasPaidEntitlement(ownerId, nowMs));
		const available = configured.filter(
			(provider) =>
				provider.connectionId !== undefined ||
				(!onlyOwnKeys &&
					(config.availableSandboxProviderIds?.has(provider.providerId) ??
						true)),
		);
		return {
			entitled: yield* hasEntitlement(ownerId, nowMs),
			providers: available.map((provider) => ({
				providerId: provider.providerId,
				displayName: provider.displayName,
				billingSource:
					provider.connectionId === undefined ? "zuse" : "provider",
				sizes: provider.sizes.map((size) => ({
					sizeId: size.sizeId,
					displayName: size.displayName,
					vcpuCount: size.vcpuCount,
					memoryMib: size.memoryMib,
				})),
			})),
		};
	},
);

const selectedProvider = Effect.fn("selectedCloudProvider")(function* (
	accountId: string,
	requested?: string,
) {
	const registry = yield* SandboxProviders;
	const config = yield* MachineControlConfiguration;
	const available = (yield* accountSandboxProviders(accountId)).filter(
		(provider) =>
			provider.connectionId !== undefined ||
			(config.availableSandboxProviderIds?.has(provider.providerId) ?? true),
	);
	if (requested !== undefined) {
		const selected = available.find(
			(provider) => provider.providerId === requested,
		);
		if (selected === undefined)
			return yield* serviceUnavailable("cloud_provider_unavailable");
		return selected;
	}
	const connected = available.filter(
		(provider) => provider.connectionId !== undefined,
	);
	if (connected.length === 1 && connected[0]) return connected[0];
	const selected =
		available.find(
			(provider) => provider.providerId === registry.defaultProviderId,
		) ?? (available.length === 1 ? available[0] : undefined);
	if (!selected) return yield* serviceUnavailable("cloud_provider_required");
	return selected;
});

const hasPaidEntitlement = Effect.fn("hasPaidCloudWorkspaceEntitlement")(
	function* (accountId: string, nowMs: number) {
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
	},
);

const hasEntitlement = Effect.fn("hasCloudWorkspaceEntitlement")(function* (
	accountId: string,
	nowMs: number,
) {
	return (
		(yield* hasProviderConnection(accountId)) ||
		(yield* hasPaidEntitlement(accountId, nowMs))
	);
});
const requirePlacementAccess = Effect.fn("requireCloudPlacementAccess")(
	function* (
		accountId: string,
		nowMs: number,
		provider: ConnectedSandboxProvider,
	) {
		if (provider.connectionId !== undefined) return;
		if (!(yield* hasPaidEntitlement(accountId, nowMs)))
			return yield* forbidden("cloud_entitlement_required");
		yield* requireCloudBillingCapacity(accountId, nowMs);
	},
);

/** Shared fail-closed entitlement gate for WorkOS and API-key callers. */
export const requireCloudWorkspaceEntitlement = Effect.fn(
	"requireCloudWorkspaceEntitlement",
)(function* (accountId: string, nowMs: number) {
	if (!(yield* hasEntitlement(accountId, nowMs)))
		return yield* Effect.fail(forbidden("cloud_entitlement_required"));
});

export const requireCloudBillingCapacity = Effect.fn(
	"requireCloudBillingCapacity",
)(function* (accountId: string, nowMs: number, providerConnectionId?: string) {
	const capacity = yield* cloudBillingCapacity(
		accountId,
		nowMs,
		providerConnectionId,
	);
	if (capacity === "period-missing")
		return yield* Effect.fail(forbidden("cloud_billing_period_missing"));
	if (capacity === "billing-hold")
		return yield* Effect.fail(forbidden("cloud_billing_hold"));
});

const runtimeEncryptionKey = Effect.fn("runtimeEncryptionKey")(function* (
	credentialPublicJwk: string,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			const parsed = JSON.parse(credentialPublicJwk) as JWK;
			if (parsed.kty !== "RSA") throw new Error("invalid_workspace_key");
			return importJWK(parsed, "RSA-OAEP-256");
		},
		catch: () => badRequest("invalid_workspace_key"),
	});
});

const sealRuntimeSecret = Effect.fn("sealRuntimeSecret")(function* (
	credentialPublicJwk: string,
	secret: string,
) {
	const publicKey = yield* runtimeEncryptionKey(credentialPublicJwk);
	return yield* Effect.tryPromise({
		try: () =>
			new CompactEncrypt(new TextEncoder().encode(secret))
				.setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM" })
				.encrypt(publicKey),
		catch: () => serviceUnavailable("cloud_credential_delivery_failed"),
	});
});

const RuntimeReadyRequest = Schema.Struct({
	deviceBridgeVersion: Schema.optional(Schema.Literal(DEVICE_BRIDGE_VERSION)),
	phase: Schema.Literals([
		"repository-ready",
		"agent-started",
		"launch-failed",
	]),
	launchCommandId: Schema.optional(Schema.String),
	sessionHeadVersion: Schema.optional(Schema.Number),
	errorCode: Schema.optional(Schema.String),
	commandProtocolVersion: Schema.optional(
		Schema.Literal(CLOUD_COMMAND_PROTOCOL_VERSION),
	),
});

export const runtimeActivityLifecycle = (
	workspace: Pick<
		CloudWorkspaceRecord,
		"state" | "desiredState" | "runtimeState" | "statusCode"
	>,
) =>
	workspace.desiredState === "ready" &&
	(workspace.statusCode === "resume-runtime-waking" ||
		workspace.statusCode === "runtime-memory-pressure")
		? ({
				state: "ready",
				runtimeState: "online",
				statusCode: "agent-running",
			} as const)
		: {
				state: workspace.state,
				runtimeState: workspace.runtimeState,
				statusCode: workspace.statusCode,
			};

const RuntimeBootstrapRequest = Schema.Struct({
	credentialPublicJwk: Schema.String,
	signingPublicJwk: Schema.String,
	capabilities: Schema.optional(Schema.Array(Schema.String)),
});

const RuntimeBootstrapAckRequest = Schema.Struct({
	runtimeGeneration: Schema.Number,
	gatewayEpoch: Schema.Number,
});

const RuntimeCredentialRenewRequest = Schema.Struct({
	requestId: Schema.String,
	proof: Schema.String,
});

const RuntimeCommandLeaseRequest = Schema.Struct({
	storageIncarnationId: Schema.String,
	waitMs: Schema.optional(Schema.Literal(25_000)),
	afterRevision: Schema.optional(Schema.Number),
});

export const codexGrantRuntimeBindingError = (
	workspace: CloudWorkspaceRecord,
	request: Pick<CodexGrantRequest, "runtimeGeneration">,
	keyThumbprint: string,
):
	| "codex-auth-legacy-workspace"
	| "workspace_runtime_fenced"
	| "runtime_credential_key_binding_mismatch"
	| null => {
	if (workspace.requestConfig.codexAuthMode !== "broker-v1")
		return "codex-auth-legacy-workspace";
	if (request.runtimeGeneration !== cloudWorkspaceRuntimeGeneration(workspace))
		return "workspace_runtime_fenced";
	const receipt = runtimeBootstrapReceiptFromConfig(workspace.requestConfig);
	if (
		receipt === null ||
		receipt.generation !== request.runtimeGeneration ||
		receipt.credentialKeyThumbprint !== keyThumbprint
	)
		return "runtime_credential_key_binding_mismatch";
	return null;
};

export const launchFailureNextActionAt = (input: {
	readonly errorCode?: string;
	readonly nowMs: number;
	readonly idlePauseMs: number;
}): number =>
	input.errorCode === "runtime-storage-replaced"
		? Number.MAX_SAFE_INTEGER
		: input.nowMs + input.idlePauseMs;

export const providerGrantRuntimeBindingError = (
	workspace: CloudWorkspaceRecord,
	request: Pick<ProviderGrantRequest, "runtimeGeneration">,
	keyThumbprint: string,
):
	| "provider-auth-legacy-workspace"
	| "workspace_runtime_fenced"
	| "runtime_credential_key_binding_mismatch"
	| null => {
	if (workspace.requestConfig.providerAuthMode !== "broker-v1")
		return "provider-auth-legacy-workspace";
	if (request.runtimeGeneration !== cloudWorkspaceRuntimeGeneration(workspace))
		return "workspace_runtime_fenced";
	const receipt = runtimeBootstrapReceiptFromConfig(workspace.requestConfig);
	if (
		receipt === null ||
		receipt.generation !== request.runtimeGeneration ||
		receipt.credentialKeyThumbprint !== keyThumbprint
	)
		return "runtime_credential_key_binding_mismatch";
	return null;
};

const issueBoundProviderGrant = Effect.fn("issueBoundProviderGrant")(function* (
	request: Request,
	workspace: CloudWorkspaceRecord,
	workspaceId: string,
	providerId: CloudAuthProvider,
) {
	const body = yield* decodeBody(ProviderGrantRequest, request);
	const publicJwk = yield* parseJwk(body.credentialPublicJwk);
	const keyThumbprint = yield* runtimeCredentialKeyThumbprint(publicJwk);
	const bindingError = providerGrantRuntimeBindingError(
		workspace,
		body,
		keyThumbprint,
	);
	if (bindingError === "provider-auth-legacy-workspace")
		return yield* Effect.fail(conflict(`${providerId}-auth-legacy-workspace`));
	if (bindingError !== null)
		return yield* Effect.fail(unauthorized(bindingError));
	return json(
		yield* issueProviderGrant({
			accountId: workspace.accountId,
			workspaceId,
			providerId,
			runtimeGeneration: body.runtimeGeneration,
			recipientPublicJwk: body.credentialPublicJwk,
			recipientKeyThumbprint: keyThumbprint,
			requestId: body.requestId,
			reason: body.reason,
			...(body.previousProviderAccountId === undefined
				? {}
				: { previousProviderAccountId: body.previousProviderAccountId }),
		}),
	);
});

const attachMailboxLifecycle = (
	response: Response,
	workspace: CloudWorkspaceRecord,
): Response => {
	const lifecycle = mailboxLifecycleToDeliver(workspace);
	if (lifecycle === null) return response;
	if (lifecycle.action !== "archive" && lifecycle.action !== "delete")
		return response;
	return attachCloudMailboxLifecycleDirective(response, lifecycle);
};

const attachMailboxBillingPolicy = (
	response: Response,
	capacity: CloudBillingCapacity,
	accountId: string,
): Response => {
	return attachCloudMailboxBillingDirective(response, {
		policy: capacity === "available" ? "available" : "blocked",
		accountId,
	});
};

const authenticateRuntime = Effect.fn("authenticateCloudWorkspaceRuntime")(
	function* (request: Request, workspaceId: string, nowMs: number) {
		const store = yield* CloudWorkspaceStore;
		const workspace = yield* store.getWorkspace(workspaceId);
		const token = bearer(request);
		if (
			workspace === null ||
			token === undefined ||
			workspace.runtimeCredentialHash !== (yield* sha256Hex(token)) ||
			typeof workspace.requestConfig.runtimeCredentialExpiresAtMs !==
				"number" ||
			workspace.requestConfig.runtimeCredentialExpiresAtMs <= nowMs
		)
			return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
		return workspace;
	},
);
export const requireRuntime = Effect.fn("requireCloudWorkspaceRuntime")(
	function* (request: Request, workspaceId: string, nowMs: number) {
		const workspace = yield* authenticateRuntime(request, workspaceId, nowMs);
		if (workspaceDeletionRequested(workspace))
			return yield* Effect.fail(unauthorized("workspace_runtime_revoked"));
		return workspace;
	},
);

export interface CloudWorkspaceCreateOutcome {
	readonly workspace: CloudWorkspaceRecord;
	readonly created: boolean;
}

/** Pure lifecycle target shared by HTTP resume and atomic message+resume. */
export const cloudWorkspaceResumeTarget = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): CloudWorkspaceRecord => ({
	...workspace,
	requestConfig: {
		...workspace.requestConfig,
		startupTimings: { requestedAt: nowMs, resumeRequestedAt: nowMs },
	},
	desiredState: "ready",
	statusCode: "resume-queued",
	nextActionAtMs: nowMs,
	revision: workspace.revision + 1,
	updatedAtMs: nowMs,
	lastActivityAtMs: nowMs,
});

/**
 * Shared cloud-workspace creation used by the first-party (WorkOS) route and
 * the API-key `/v1/api/workspaces` surface: entitlement + billing gates,
 * branch allocation, sealed launch intent, and idempotent insert. Callers translate the outcome into their own response shape and set
 * the reconcile headers when `created` is true.
 */
export const createCloudWorkspaceForAccount = Effect.fn(
	"createCloudWorkspaceForAccount",
)(function* (
	accountId: string,
	body: Omit<CloudWorkspaceCreateRequest, "providerId"> & {
		readonly providerId?: string;
		/** Canonical public-API request fingerprint, absent for first-party calls. */
		readonly publicApiRequestDigest?: string;
		readonly githubBot?: boolean;
	},
	nowMs: number,
	creator?: { readonly subject: string; readonly membershipId: string },
) {
	const store = yield* CloudWorkspaceStore;
	const launchIntentCipher = yield* CloudWorkspaceLaunchIntentCipher;
	const scope = workspaceScopeForOwner(accountId);
	if (scope.kind === "organization" && creator === undefined)
		return yield* forbidden("workspace_creator_required");
	const sharingPolicy: ChatSharingPolicy | undefined =
		scope.kind === "organization" && creator !== undefined
			? {
					...(yield* getOrganizationSharingDefaults(scope.organizationId)),
					creatorSubject: creator.subject,
					creatorMembershipId: creator.membershipId,
					grants: [],
				}
			: undefined;
	yield* requireCloudWorkspaceEntitlement(accountId, nowMs);
	const apiConfiguration = yield* ApiConfiguration;
	if (body.localDeviceId !== undefined) {
		const devices = yield* ApiStore;
		const device = yield* devices.getEnvironment(body.localDeviceId);
		if (
			!device ||
			device.accountId !== accountId ||
			device.providerKind !== "desktop"
		)
			return yield* Effect.fail(forbidden("device_bridge_target_rejected"));
	}
	const project = yield* store.getProject(body.projectId);
	if (project === null || project.accountId !== accountId)
		return yield* Effect.fail(notFound("cloud_project_not_found"));
	const provider = yield* selectedProvider(accountId, body.providerId);
	yield* requirePlacementAccess(accountId, nowMs, provider);
	const forkSource =
		body.forkSource === undefined
			? null
			: yield* store.getWorkspace(body.forkSource.workspaceId);
	if (body.forkSource !== undefined) {
		if (forkSource === null || forkSource.accountId !== accountId)
			return yield* Effect.fail(notFound("cloud_workspace_not_found"));
		if (connectionIdFor(forkSource) !== provider.connectionId)
			return yield* conflict("cloud_provider_connection_changed");
		if (
			provider.providerId !== "boxd" ||
			forkSource.provider !== "boxd" ||
			provider.forkMachine === undefined
		)
			return yield* Effect.fail(badRequest("cloud_machine_fork_unavailable"));
		if (
			forkSource.projectId !== body.projectId ||
			forkSource.state !== "ready" ||
			forkSource.desiredState !== "ready" ||
			forkSource.providerSandboxId === undefined
		)
			return yield* Effect.fail(conflict("cloud_fork_source_not_ready"));
		if (
			!runtimeBootstrapReceiptFromConfig(
				forkSource.requestConfig,
			)?.capabilities?.includes(CLOUD_RUNTIME_MACHINE_FORK_CAPABILITY)
		)
			return yield* Effect.fail(conflict("cloud_fork_runtime_update_required"));
		if (
			body.branch !== undefined ||
			hasCloudWorkspaceInitialMessage(body) ||
			body.sizeId !== undefined
		)
			return yield* Effect.fail(badRequest("cloud_fork_configuration_invalid"));
	}
	if (
		body.sizeId !== undefined &&
		!provider.sizes.some((size) => size.sizeId === body.sizeId)
	)
		return yield* Effect.fail(badRequest("cloud_size_unavailable"));
	const accountBuild =
		forkSource !== null
			? yield* store.getBuild(forkSource.buildId)
			: yield* store.getActiveAccountBuild(accountId, provider.providerId);
	if (
		project.state !== "ready" ||
		accountBuild === null ||
		(forkSource === null && accountBuild.snapshotId === undefined) ||
		(forkSource === null &&
			!snapshotBuildCompatible(accountBuild, provider.templateVersion)) ||
		!storedBuildRepositories(
			accountBuild,
			accountImageRepositories([project]),
		).some((repository) => repository.projectId === project.projectId)
	)
		return yield* Effect.fail(conflict("cloud_project_not_ready"));
	const build = accountBuild;
	if (
		forkSource === null &&
		build.snapshotId !== undefined &&
		connectionIdFor(build) === undefined
	)
		yield* assertSnapshotUsable(accountId, build.provider, build.snapshotId);
	if (
		importedSnapshot(build) &&
		snapshotRepositoryLayout(build, project.projectId) === undefined
	)
		return yield* Effect.fail(
			conflict("snapshot-repository-configuration-invalid"),
		);
	if (
		!importedSnapshot(build) &&
		apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled &&
		build.settings?.codexAuthDeliveryVersion !== 1
	)
		return yield* Effect.fail(conflict("codex-auth-update-required"));
	if (
		!importedSnapshot(build) &&
		apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled &&
		build.settings?.providerAuthDeliveryVersion !== 1
	)
		return yield* Effect.fail(conflict("provider-auth-update-required"));
	const codexAuthMode = importedSnapshot(build)
		? snapshotSettings(build).agentAuthentication === "zuse"
			? "broker-v1"
			: "snapshot-native"
		: codexAuthModeForAccountBuild(
				build,
				apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled,
			);
	const providerAuthMode = importedSnapshot(build)
		? snapshotSettings(build).agentAuthentication === "zuse"
			? "broker-v1"
			: "snapshot-native"
		: providerAuthModeForAccountBuild(
				build,
				apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled,
			);
	const workspaceId = yield* randomToken("workspace", 12);
	const chatId = `chat_${crypto.randomUUID()}`;
	const initialSessionId = `s_${crypto.randomUUID()}`;
	// Workspace records cannot tell us which names were used by local chats,
	// other accounts, or deleted GitHub branches with historical PRs. Scope
	// generated names to the full workspace identity instead of reusing a bare
	// mascot name. Explicit "Create from" branches retain their identity.
	const branch =
		body.branch ??
		`${
			allocatePokemonName({
				catalog: POKEMON_BRANCH_CATALOG,
				unavailableNames: new Set(),
				usedPokemonNumbers: new Set(),
			})?.name ?? "cloud"
		}-${workspaceId.slice("workspace_".length)}`;
	if (
		!/^[A-Za-z0-9._/-]+$/u.test(branch) ||
		!/^[A-Za-z0-9._/#-]+$/u.test(body.baseRef)
	)
		return yield* Effect.fail(badRequest("invalid_git_ref"));
	const initialMessageDelivery = selectCloudWorkspaceInitialMessageDelivery({
		mailboxEnabled: apiConfiguration.cloudCommandMailboxEnabled,
		requested: body.initialMessageDelivery,
	});
	const launchIntent = makeCloudWorkspaceLaunchIntent({
		workspaceId,
		branch,
		agent: body.agent,
		model: body.model,
		runtimeMode: body.runtimeMode ?? DEFAULT_RUNTIME_MODE,
		permissions: body.permissions ?? [],
		request: { ...body, initialMessageDelivery },
	});
	const machineFork =
		body.forkSource === undefined || forkSource === null
			? undefined
			: {
					workspaceId: forkSource.workspaceId,
					providerSandboxId: forkSource.providerSandboxId as string,
					chatId: forkSource.chatId,
					sessionId: body.forkSource.sessionId,
					messageId: body.forkSource.messageId,
				};
	const { commandId, turnId, title } = launchIntent;
	const transcriptKey = yield* createCloudTranscriptKey(
		accountId,
		workspaceId,
	).pipe(
		Effect.mapError(() =>
			serviceUnavailable("cloud_transcript_key_unavailable"),
		),
	);
	const workspace: CloudWorkspaceRecord = {
		workspaceId,
		accountId: accountId,
		projectId: project.projectId,
		buildId: build.buildId,
		provider: provider.providerId,
		runtimeState: "offline",
		chatId,
		initialSessionId,
		branch,
		baseRef:
			forkSource?.branch ??
			(importedSnapshot(build) &&
			body.branch === undefined &&
			body.baseRef === project.defaultBranch
				? "HEAD"
				: body.baseRef),
		state: "queued",
		desiredState: "ready",
		statusCode: "provisioning-queued",
		wrappedTranscriptKey: transcriptKey.envelope,
		idempotencyKey: body.idempotencyKey,
		requestConfig: {
			providerConnectionId: provider.connectionId,
			...(importedSnapshot(build)
				? snapshotRepositoryLayout(build, project.projectId)
				: {}),
			...(forkSource?.requestConfig.snapshotRevision !== undefined
				? {
						runtimeUser: forkSource.requestConfig.runtimeUser,
						runtimeHome: forkSource.requestConfig.runtimeHome,
						workspacePath: forkSource.requestConfig.workspacePath,
						snapshotRevision: forkSource.requestConfig.snapshotRevision,
						snapshotGitAuthentication:
							forkSource.requestConfig.snapshotGitAuthentication,
					}
				: {}),
			...(machineFork === undefined ? {} : { machineFork }),
			...(sharingPolicy === undefined ? {} : { sharingPolicy }),
			initialGithubContext:
				body.githubBot === true
					? { slackMessageId: `msg_launch_${workspaceId}` }
					: creator === undefined
						? {}
						: { actor: creator },
			localDeviceId:
				body.localDeviceId ?? forkSource?.requestConfig.localDeviceId,
			title,
			agent: body.agent,
			codexAuthMode,
			providerAuthMode,
			initialTurnId: turnId,
			authGrantRequired: false,
			model: body.model,
			...((body.sizeId ?? forkSource?.requestConfig.sizeId) === undefined
				? {}
				: { sizeId: body.sizeId ?? forkSource?.requestConfig.sizeId }),
			runtimeMode: body.runtimeMode ?? DEFAULT_RUNTIME_MODE,
			permissions: body.permissions ?? [],
			...(body.publicApiRequestDigest === undefined
				? {}
				: { publicApiRequestDigest: body.publicApiRequestDigest }),
			repositoryCache: "account-image",
			startupTimings: { requestedAt: nowMs },
			...(initialMessageDelivery === undefined
				? {}
				: {
						cloudCommandEnrollmentProtocolVersion:
							CLOUD_COMMAND_PROTOCOL_VERSION,
					}),
		},
		nextActionAtMs: nowMs,
		revision: 0,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		lastActivityAtMs: nowMs,
	};
	const launchIntentRecord = {
		workspaceId,
		accountId: accountId,
		chatId,
		sessionId: initialSessionId,
		turnId,
		commandId,
		ciphertext: yield* launchIntentCipher
			.encrypt(accountId, workspaceId, {
				...launchIntent,
				...(machineFork === undefined ? {} : { forkSource: machineFork }),
			})
			.pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_workspace_launch_intent_unavailable"),
				),
			),
		expiresAtMs: nowMs + 24 * 60 * 60 * 1_000,
		createdAtMs: nowMs,
	};
	const outcome = yield* store.createWorkspace(workspace, launchIntentRecord);
	if (outcome.kind === "branch-in-use")
		return yield* Effect.fail(
			conflict(
				scope.kind === "organization"
					? "cloud_branch_in_use"
					: `cloud_branch_in_use:${outcome.workspace.workspaceId}`,
			),
		);
	return {
		workspace: outcome.workspace,
		created: outcome.kind === "created",
	} satisfies CloudWorkspaceCreateOutcome;
});

/**
 * Queue a plain resume (no runtime recovery, non-failed workspace) with
 * lifecycle-command idempotency — the same mutation the `/resume` action
 * applies for that case. Used when an inbound API message must wake a paused
 * workspace. Returns the workspace unchanged when a resume is already
 * requested or the command was seen before.
 */
export const queueCloudWorkspaceResume = Effect.fn("queueCloudWorkspaceResume")(
	function* (
		workspace: CloudWorkspaceRecord,
		commandId: string,
		nowMs: number,
	) {
		const store = yield* CloudWorkspaceStore;
		if (cloudWorkspaceResumeIsAlreadyRequested(workspace)) return workspace;
		const receivedAction = yield* store.getWorkspaceLifecycleCommand(
			workspace.workspaceId,
			commandId,
		);
		if (receivedAction !== null) return workspace;
		const updated = cloudWorkspaceResumeTarget(workspace, nowMs);
		const saved = yield* store.saveWorkspaceLifecycleCommand({
			workspace: updated,
			commandId,
			action: "resume",
			createdAtMs: nowMs,
		});
		if (saved) return updated;
		return (yield* store.getWorkspace(workspace.workspaceId)) ?? workspace;
	},
);

export const routeCloudWorkspaceRequest = (
	request: Request,
): Effect.Effect<Response | null, ApiError, CloudWorkspaceRouteContext> =>
	routeCloudWorkspaceRequestWithAccess(request);

const routeCloudWorkspaceRequestWithAccess = (
	request: Request,
	delegatedAccess?: Effect.Success<ReturnType<typeof requireWorkspaceAccess>>,
): Effect.Effect<Response | null, ApiError, CloudWorkspaceRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		if (!path.startsWith("/v1/cloud/")) return null;
		if (method === "POST" && path === ApiPaths.cloudGithubWebhook)
			return yield* githubWebhook(request);
		if (
			(method === "GET" || method === "POST") &&
			path === "/v1/cloud/github/callback"
		) {
			return yield* githubAuthorizationCallback(request).pipe(
				Effect.tapError((error) =>
					Effect.sync(() =>
						console.warn("[cloud-github] installation callback failed", {
							code: error.code,
						}),
					),
				),
				Effect.catch((error) =>
					Effect.succeed(
						githubCallbackPage({
							title: "GitHub could not be connected",
							message:
								error.code === "github_app_oauth_not_configured"
									? "GitHub authorization is not configured on this deployment. Ask the operator to configure the GitHub App client secret and callback URL."
									: "Return to Zuse and try the GitHub button again. The link may have expired or your workspace access changed.",
						}),
					),
				),
			);
		}
		const nowMs = yield* Clock.currentTimeMillis;
		const store = yield* CloudWorkspaceStore;
		const launchIntentCipher = yield* CloudWorkspaceLaunchIntentCipher;
		const apiConfiguration = yield* ApiConfiguration;
		const idlePauseMs = apiConfiguration.cloudWorkspaceIdleTimeoutMs;
		const controlMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/control$/u.exec(path);
		if (method === "POST" && controlMatch !== null) {
			const source = yield* requireRuntime(
				request,
				decodeURIComponent(controlMatch[1] ?? ""),
				nowMs,
			);
			// A shared organization runtime cannot impersonate its creator. Actor-scoped
			// delegation must precede enabling cross-workspace control there.
			if (source.accountId.startsWith("organization:"))
				return yield* forbidden("runtime_control_requires_personal_workspace");
			if (source.state !== "ready")
				return yield* conflict("cloud_workspace_unavailable");
			const input = yield* decodeBody(
				Schema.Struct({
					path: Schema.String,
					method: Schema.String,
					body: Schema.optional(Schema.Unknown),
				}),
				request,
			);
			if (
				(input.method === "GET" && input.body !== undefined) ||
				!runtimeControlPathAllowed(input.path, input.method)
			)
				return yield* forbidden("runtime_control_operation_not_allowed");
			const target = new Request(`${url.origin}${input.path}`, {
				method: input.method,
				headers: { "content-type": "application/json" },
				body: input.body === undefined ? undefined : JSON.stringify(input.body),
			});
			return yield* routeCloudWorkspaceRequestWithAccess(target, {
				actor: { accountId: source.accountId, orgId: undefined },
				scope: { kind: "personal" },
				ownerId: source.accountId,
				membership: null,
			});
		}

		const deviceBridgeMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/(runtime\/)?device-bridge$/u.exec(
				path,
			);
		if (method === "POST" && deviceBridgeMatch) {
			const workspaceId = decodeURIComponent(deviceBridgeMatch[1] ?? "");
			const actor = deviceBridgeMatch[2] ? "runtime" : "user";
			let workspace =
				actor === "runtime"
					? yield* requireRuntime(request, workspaceId, nowMs)
					: yield* store.getWorkspace(workspaceId);
			if (!workspace)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (actor === "user") {
				const principal = yield* requireWorkos(request);
				if (principal.accountId !== workspace.accountId)
					return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			}
			const body = yield* decodeBody(
				Schema.Struct({
					action: DeviceBridgeAction,
					targetDeviceId: Schema.optional(Schema.String),
				}),
				request,
			);
			if (body.targetDeviceId !== undefined) {
				if (actor !== "user" || body.action._tag !== "status")
					return yield* Effect.fail(forbidden("device_bridge_user_required"));
				const devices = yield* ApiStore;
				const device = yield* devices.getEnvironment(body.targetDeviceId);
				if (
					!device ||
					device.accountId !== workspace.accountId ||
					device.providerKind !== "desktop"
				)
					return yield* Effect.fail(forbidden("device_bridge_target_rejected"));
				const bound = yield* store.bindLocalDevice({
					workspaceId,
					accountId: workspace.accountId,
					expectedRevision: workspace.revision,
					deviceId: body.targetDeviceId,
					nowMs,
				});
				if (!bound)
					return yield* Effect.fail(conflict("device_bridge_binding_changed"));
				workspace = bound;
			}
			return yield* forwardDeviceBridge(workspace, body.action, actor);
		}

		const recordWorkspaceActivity = Effect.fn("recordWorkspaceActivity")(
			function* (workspace: CloudWorkspaceRecord, runtimeOnly = false) {
				const updated = yield* store.recordActivity(
					workspace.workspaceId,
					workspace.accountId,
					nowMs,
					nowMs + idlePauseMs,
					runtimeOnly,
				);
				if (
					updated?.providerSandboxId !== undefined &&
					updated.state !== "paused"
				) {
					const provider = yield* resolveResourceProvider(updated).pipe(
						Effect.orDie,
					);
					yield* provider
						.extendTimeout(
							updated.providerSandboxId,
							Math.ceil(idlePauseMs / 1_000),
						)
						.pipe(
							Effect.mapError(() =>
								serviceUnavailable("cloud_workspace_keepalive_failed"),
							),
						);
				}
				return updated;
			},
		);
		const repairAcknowledgedLaunch = Effect.fn("repairAcknowledgedLaunch")(
			function* (
				workspace: CloudWorkspaceRecord,
				runtimeSummary?: CloudWorkspaceRuntimeSummaryRecord | null,
			) {
				if (workspace.statusCode !== "agent-starting") return workspace;
				const currentSummary = currentCloudRuntimeSummary(
					workspace,
					runtimeSummary,
				);
				if (currentSummary === null || currentSummary.sessionHeadVersion <= 0)
					return workspace;
				const launchIntent = yield* store.getLaunchIntent(
					workspace.workspaceId,
					nowMs,
				);
				if (launchIntent !== null) return workspace;
				const completion = yield* store.completeLaunchIntent({
					workspaceId: workspace.workspaceId,
					commandId: `launch:${workspace.workspaceId}`,
					sessionHeadVersion: currentSummary.sessionHeadVersion,
					nowMs,
					nextActionAtMs: nowMs + idlePauseMs,
				});
				if (completion.kind === "completed") return completion.workspace;
				return (yield* store.getWorkspace(workspace.workspaceId)) ?? workspace;
			},
		);
		const bootstrapMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/bootstrap$/u.exec(path);
		if (method === "POST" && bootstrapMatch !== null) {
			const workspaceId = decodeURIComponent(bootstrapMatch[1] ?? "");
			const body = yield* decodeBody(RuntimeBootstrapRequest, request);
			const credentialJwk = yield* parseJwk(body.credentialPublicJwk);
			const signingJwk = yield* parseJwk(body.signingPublicJwk);
			const [credentialKeyThumbprint, signingKeyThumbprint] = yield* Effect.all(
				[
					runtimeCredentialKeyThumbprint(credentialJwk),
					runtimeSigningKeyThumbprint(signingJwk),
				],
			);
			const workspace = yield* store.getWorkspace(workspaceId);
			const token = bearer(request);
			const bootTokenHash =
				token === undefined ? undefined : yield* sha256Hex(token);
			if (
				workspace === null ||
				token === undefined ||
				bootTokenHash === undefined ||
				workspace.runtimeBootTokenHash !== bootTokenHash ||
				(workspace.runtimeBootTokenExpiresAtMs ?? 0) <= nowMs ||
				workspaceDeletionRequested(workspace) ||
				workspace.desiredState !== "ready" ||
				workspace.providerSandboxId === undefined
			)
				return yield* Effect.fail(unauthorized("workspace_bootstrap_rejected"));
			const initialGithub = Schema.decodeUnknownOption(
				CloudGithubCredentialRequest,
			)(workspace.requestConfig.initialGithubContext);
			if (
				(workspace.accountId.startsWith("organization:") ||
					(Option.isSome(initialGithub) &&
						initialGithub.value.slackMessageId !== undefined)) &&
				!body.capabilities?.includes(CLOUD_RUNTIME_GITHUB_EXECUTION_CAPABILITY)
			)
				return yield* conflict("github_runtime_update_required");
			const generation = cloudWorkspaceRuntimeGeneration(workspace);
			const epoch = cloudWorkspaceGatewayEpoch(workspace);
			const prior = runtimeBootstrapReceiptFromConfig(workspace.requestConfig);
			if (
				prior !== null &&
				(prior.bootTokenHash !== bootTokenHash ||
					prior.credentialKeyThumbprint !== credentialKeyThumbprint ||
					prior.signingKeyThumbprint !== signingKeyThumbprint ||
					prior.generation !== generation ||
					prior.gatewayEpoch !== epoch)
			)
				return yield* Effect.fail(
					unauthorized("workspace_bootstrap_key_mismatch"),
				);
			// Derivation from the high-entropy one-shot token allows response-loss
			// retries to recover the credential without storing it in plaintext.
			const runtimeCredential = `workspace_runtime_${yield* sha256Hex(
				`bootstrap-v1\n${token}\n${workspaceId}\n${generation}\n${epoch}\n${credentialKeyThumbprint}\n${signingKeyThumbprint}`,
			)}`;
			let transcriptKeyEnvelope = workspace.wrappedTranscriptKey;
			if (transcriptKeyEnvelope === undefined) {
				const created = yield* createCloudTranscriptKey(
					workspace.accountId,
					workspaceId,
				).pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_transcript_key_unavailable"),
					),
				);
				yield* store.saveWorkspace({
					...workspace,
					wrappedTranscriptKey: created.envelope,
					revision: workspace.revision + 1,
					updatedAtMs: Math.max(nowMs, workspace.updatedAtMs + 1),
				});
				transcriptKeyEnvelope = (yield* store.getWorkspace(workspaceId))
					?.wrappedTranscriptKey;
			}
			if (transcriptKeyEnvelope === undefined)
				return yield* Effect.fail(
					serviceUnavailable("cloud_transcript_key_unavailable"),
				);
			const sealedTranscriptKey =
				prior?.sealedTranscriptKey ??
				(yield* openCloudTranscriptKey(
					workspace.accountId,
					workspaceId,
					transcriptKeyEnvelope,
				).pipe(
					Effect.flatMap((key) =>
						sealRuntimeSecret(body.credentialPublicJwk, key),
					),
					Effect.mapError(() =>
						serviceUnavailable("cloud_transcript_key_unavailable"),
					),
				));
			const enrolled = yield* store.enrollRuntimeBoot({
				workspaceId,
				bootTokenHash,
				credentialKeyThumbprint,
				signingKeyThumbprint,
				signingPublicJwk: body.signingPublicJwk,
				runtimeCredentialHash: yield* sha256Hex(runtimeCredential),
				runtimeCredentialExpiresAtMs: nowMs + RUNTIME_CREDENTIAL_TTL_MS,
				generation,
				gatewayEpoch: epoch,
				sealedTranscriptKey,
				capabilities: body.capabilities,
				nowMs,
			});
			if (enrolled === null)
				return yield* Effect.fail(unauthorized("workspace_bootstrap_rejected"));
			const providerSandboxId = enrolled.workspace.providerSandboxId;
			if (providerSandboxId === undefined)
				return yield* Effect.fail(unauthorized("workspace_bootstrap_rejected"));
			const launchIntentRecord = enrolled.launchIntent;
			const alreadyLaunched =
				typeof enrolled.workspace.requestConfig.sessionHeadVersion ===
					"number" || enrolled.workspace.statusCode === "agent-starting";
			if (launchIntentRecord === null && !alreadyLaunched)
				return yield* Effect.fail(conflict("cloud_workspace_launch_failed"));
			const launchIntent =
				launchIntentRecord === null
					? undefined
					: yield* launchIntentCipher
							.decrypt(
								launchIntentRecord.accountId,
								workspaceId,
								launchIntentRecord.ciphertext,
							)
							.pipe(
								Effect.mapError(() =>
									serviceUnavailable(
										"cloud_workspace_launch_intent_unavailable",
									),
								),
							);
			const api = yield* ApiConfiguration;
			const runtimeGatewayCredential = yield* signWorkspaceRuntimeTicket({
				mintPrivateJwk: yield* parseJwk(Redacted.value(api.mintPrivateKey)),
				issuer: api.apiIssuer,
				accountId: workspace.accountId,
				workspaceId,
				protocol: WORKSPACE_GATEWAY_PROTOCOL,
				generation: enrolled.receipt.generation,
				gatewayEpoch: enrolled.receipt.gatewayEpoch,
				ttlMs: RUNTIME_CREDENTIAL_TTL_MS,
				nowMs:
					enrolled.receipt.runtimeCredentialExpiresAtMs -
					RUNTIME_CREDENTIAL_TTL_MS,
			});
			return json({
				workspaceId,
				zuseAccountId: workspace.accountId,
				initialGithubContext: workspace.requestConfig.initialGithubContext,
				gitIdentity: workspace.accountId.startsWith("organization:")
					? undefined
					: yield* githubUserIdentity(workspace.accountId),
				workspaceScope: workspaceScopeForOwner(workspace.accountId),
				providerSandboxId,
				runtimeCredential,
				runtimeGatewayCredential,
				// Wire-v5 runtimes published before machine-owned sandbox auth require
				// this field during bootstrap decoding. Credentials are no longer sent
				// here, but retaining the empty additive field keeps retained sandboxes
				// resumable while newer v5 runtimes use runtimeGatewayCredential.
				cloudCredentials: [],
				gatewayUrl: gatewayUrl(api.apiIssuer, workspaceId),
				gatewayProtocol: WORKSPACE_GATEWAY_PROTOCOL,
				chatId: workspace.chatId,
				initialSessionId: workspace.initialSessionId,
				codexAuthMode: workspaceAuthMode(
					enrolled.workspace.requestConfig.codexAuthMode,
				),
				providerAuthMode: workspaceAuthMode(
					enrolled.workspace.requestConfig.providerAuthMode,
				),
				runtimeGeneration: enrolled.receipt.generation,
				gatewayEpoch: enrolled.receipt.gatewayEpoch,
				runtimeCredentialExpiresAt:
					enrolled.receipt.runtimeCredentialExpiresAtMs,
				...(launchIntent === undefined ? {} : { launchIntent }),
				sealedTranscriptKey: enrolled.receipt.sealedTranscriptKey,
			});
		}

		const bootstrapAckMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/bootstrap\/ack$/u.exec(path);
		if (method === "POST" && bootstrapAckMatch !== null) {
			const workspaceId = decodeURIComponent(bootstrapAckMatch[1] ?? "");
			const body = yield* decodeBody(RuntimeBootstrapAckRequest, request);
			const currentCredential = bearer(request);
			if (currentCredential === undefined)
				return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
			yield* requireRuntime(request, workspaceId, nowMs);
			const acknowledged = yield* store.acknowledgeRuntimeBoot({
				workspaceId,
				currentCredentialHash: yield* sha256Hex(currentCredential),
				generation: body.runtimeGeneration,
				gatewayEpoch: body.gatewayEpoch,
				nowMs,
			});
			if (!acknowledged)
				return yield* Effect.fail(unauthorized("workspace_runtime_fenced"));
			return json({ acknowledged: true });
		}

		const renewRuntimeMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/credentials\/renew$/u.exec(
				path,
			);
		if (method === "POST" && renewRuntimeMatch !== null) {
			const workspaceId = decodeURIComponent(renewRuntimeMatch[1] ?? "");
			const body = yield* decodeBody(RuntimeCredentialRenewRequest, request);
			const currentCredential = bearer(request);
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || currentCredential === undefined)
				return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
			if (
				workspaceDeletionRequested(workspace) ||
				workspace.desiredState === "archived"
			)
				return yield* Effect.fail(unauthorized("workspace_runtime_revoked"));
			const currentCredentialHash = yield* sha256Hex(currentCredential);
			const registeredSigningKey =
				typeof workspace.requestConfig.runtimeSigningPublicJwk === "string"
					? workspace.requestConfig.runtimeSigningPublicJwk
					: null;
			let verifiedSigningKeyThumbprint: string | undefined;
			if (registeredSigningKey !== null) {
				const signingPublicJwk = yield* parseJwk(registeredSigningKey);
				const registeredThumbprint =
					typeof workspace.requestConfig.runtimeSigningKeyThumbprint ===
					"string"
						? workspace.requestConfig.runtimeSigningKeyThumbprint
						: null;
				if (
					registeredThumbprint === null ||
					(yield* runtimeSigningKeyThumbprint(signingPublicJwk)) !==
						registeredThumbprint
				)
					return yield* Effect.fail(
						unauthorized("runtime_signing_key_binding_mismatch"),
					);
				yield* verifyRuntimeRenewalProof({
					proof: body.proof,
					runtimeSigningPublicJwk: signingPublicJwk,
					apiIssuer: (yield* ApiConfiguration).apiIssuer,
					workspaceId,
					requestId: body.requestId,
					generation: cloudWorkspaceRuntimeGeneration(workspace),
					gatewayEpoch: cloudWorkspaceGatewayEpoch(workspace),
					nowMs,
				});
				verifiedSigningKeyThumbprint = registeredThumbprint;
			}
			// A deterministic value lets a retry recover the exact credential after
			// response loss without storing plaintext at Api.
			const runtimeCredential = `workspace_runtime_${yield* sha256Hex(
				`${currentCredential}:${workspaceId}:${body.requestId}`,
			)}`;
			const expiresAt = nowMs + RUNTIME_CREDENTIAL_TTL_MS;
			const receipt = yield* store.renewRuntimeCredential({
				workspaceId,
				currentCredentialHash,
				requestId: body.requestId,
				nextCredentialHash: yield* sha256Hex(runtimeCredential),
				expiresAtMs: expiresAt,
				generation: cloudWorkspaceRuntimeGeneration(workspace),
				gatewayEpoch: cloudWorkspaceGatewayEpoch(workspace),
				nowMs,
				...(verifiedSigningKeyThumbprint === undefined
					? {}
					: { verifiedSigningKeyThumbprint }),
			});
			if (receipt === null)
				return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
			return json({
				workspaceId,
				requestId: body.requestId,
				runtimeCredential,
				expiresAt: receipt.expiresAtMs,
				generation: receipt.generation,
				gatewayEpoch: receipt.gatewayEpoch,
			});
		}

		const runtimeCodexGrantMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/providers\/codex\/grant$/u.exec(
				path,
			);
		if (method === "POST" && runtimeCodexGrantMatch !== null) {
			const workspaceId = decodeURIComponent(runtimeCodexGrantMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			if (workspace.requestConfig.codexAuthMode !== "broker-v1") {
				if (!apiConfiguration.cloudProviderAuthBrokerServingEnabled)
					return yield* Effect.fail(
						serviceUnavailable("codex-auth-update-required"),
					);
				return yield* issueBoundProviderGrant(
					request,
					workspace,
					workspaceId,
					"codex",
				);
			}
			if (!apiConfiguration.cloudCodexAuthBrokerServingEnabled)
				return yield* Effect.fail(
					serviceUnavailable("codex-auth-update-required"),
				);
			const body = yield* decodeBody(CodexGrantRequest, request);
			const publicJwk = yield* parseJwk(body.credentialPublicJwk);
			const keyThumbprint = yield* runtimeCredentialKeyThumbprint(publicJwk);
			const bindingError = codexGrantRuntimeBindingError(
				workspace,
				body,
				keyThumbprint,
			);
			if (bindingError === "codex-auth-legacy-workspace")
				return yield* Effect.fail(conflict(bindingError));
			if (bindingError !== null)
				return yield* Effect.fail(unauthorized(bindingError));
			return json(
				yield* issueCodexGrant({
					accountId: workspace.accountId,
					workspaceId,
					runtimeGeneration: body.runtimeGeneration,
					recipientPublicJwk: body.credentialPublicJwk,
					recipientKeyThumbprint: keyThumbprint,
					requestId: body.requestId,
					reason: body.reason,
					...(body.previousChatgptAccountId === undefined
						? {}
						: {
								previousChatgptAccountId: body.previousChatgptAccountId,
							}),
				}),
			);
		}

		const runtimeProviderGrantMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/providers\/([^/]+)\/grant$/u.exec(
				path,
			);
		if (method === "POST" && runtimeProviderGrantMatch !== null) {
			const workspaceId = decodeURIComponent(
				runtimeProviderGrantMatch[1] ?? "",
			);
			const providerId = yield* Schema.decodeUnknownEffect(CloudAuthProvider)(
				decodeURIComponent(runtimeProviderGrantMatch[2] ?? ""),
			).pipe(Effect.mapError(() => notFound("cloud_provider_not_found")));
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			if (!apiConfiguration.cloudProviderAuthBrokerServingEnabled)
				return yield* Effect.fail(
					serviceUnavailable(`${providerId}-auth-update-required`),
				);
			return yield* issueBoundProviderGrant(
				request,
				workspace,
				workspaceId,
				providerId,
			);
		}

		const runtimeGithubCredentialMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/github-credential$/u.exec(
				path,
			);
		if (method === "POST" && runtimeGithubCredentialMatch !== null) {
			const workspaceId = decodeURIComponent(
				runtimeGithubCredentialMatch[1] ?? "",
			);
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const project = yield* store.getProject(workspace.projectId);
			if (project === null || project.accountId !== workspace.accountId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const context =
				request.body === null
					? {}
					: yield* decodeBody(CloudGithubCredentialRequest, request);
			let useBot = false;
			if (context.slackMessageId !== undefined) {
				const message = yield* store.getApiMessage(context.slackMessageId);
				if (
					message === null ||
					message.accountId !== workspace.accountId ||
					message.workspaceId !== workspaceId
				)
					return yield* forbidden("github_execution_identity_invalid");
				const content = decodeApiMessageContent(
					yield* openApiMessageString(
						workspace.accountId,
						workspaceId,
						message.messageId,
						message.sealedContent,
					),
				);
				if (content.githubBot !== true)
					return yield* forbidden("github_execution_identity_invalid");
				useBot = true;
			}
			const actorId = context.actor?.subject ?? workspace.accountId;
			if (!useBot) {
				if (actorId.startsWith("organization:"))
					return yield* forbidden("github_user_connection_required");
				const permission = yield* cloudWorkspaceActorPermission(
					workspace,
					actorId,
					context.actor?.membershipId,
				);
				if (permission.permission !== "edit")
					return yield* forbidden("workspace_access_denied");
			}
			const credential = useBot
				? yield* githubBotCredential(
						workspace.accountId,
						project.repositoryIdentity,
					)
				: yield* githubUserCredential(
						actorId,
						project.repositoryIdentity,
						workspace.accountId,
					);
			if (credential === null)
				return yield* Effect.fail(forbidden("github_user_connection_required"));
			const response = json(credential);
			response.headers.set("cache-control", "no-store");
			return response;
		}

		const activityMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/activity$/u.exec(path);
		const summaryMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/summary$/u.exec(path);
		if (method === "POST" && summaryMatch !== null) {
			const workspaceId = decodeURIComponent(summaryMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const body = yield* decodeRuntimeSummary(request);
			if (body.lastActivityAt > nowMs + 60_000)
				return yield* Effect.fail(badRequest("invalid_runtime_summary"));
			const outcome = yield* store.saveRuntimeSummary({
				workspaceId,
				runtimeGeneration: cloudWorkspaceRuntimeGeneration(workspace),
				summaryRevision: body.summaryRevision,
				nativeAgentAccess: body.nativeAgentAccess,
				title: body.title,
				lastActivityAtMs: body.lastActivityAt,
				lastUserMessageAtMs: body.lastUserMessageAt,
				activeSessionId:
					body.activeSessionId === undefined
						? workspace.initialSessionId
						: body.activeSessionId,
				sessionHeadVersion: body.sessionHeadVersion,
				updatedAtMs: nowMs,
			});
			if (outcome.kind === "rejected-generation")
				return yield* Effect.fail(unauthorized("workspace_runtime_fenced"));
			if (outcome.kind === "workspace-missing")
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (outcome.kind === "applied") {
				if (
					workspace.statusCode === "agent-starting" &&
					outcome.summary.sessionHeadVersion > 0
				) {
					yield* store.completeLaunchIntent({
						workspaceId,
						commandId: `launch:${workspaceId}`,
						sessionHeadVersion: outcome.summary.sessionHeadVersion,
						nowMs,
						nextActionAtMs: nowMs + idlePauseMs,
					});
				}
				const active = yield* recordWorkspaceActivity(workspace, true);
				if (
					active !== null &&
					runtimeActivityLifecycle(active).state !== active.state
				)
					yield* store.saveWorkspace({
						...active,
						...runtimeActivityLifecycle(active),
						revision: active.revision + 1,
						updatedAtMs: nowMs,
					});
			}
			return json({
				applied: outcome.kind === "applied",
				summaryRevision: outcome.summary.summaryRevision,
				sessionHeadVersion: outcome.summary.sessionHeadVersion,
			});
		}
		const runtimeAccessMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/access$/u.exec(path);
		if (method === "POST" && runtimeAccessMatch !== null) {
			const workspace = yield* requireRuntime(
				request,
				decodeURIComponent(runtimeAccessMatch[1] ?? ""),
				nowMs,
			);
			const body = yield* decodeBody(CloudRuntimeAccessRequest, request);
			if (
				body.runtimeGeneration !== cloudWorkspaceRuntimeGeneration(workspace) ||
				body.gatewayEpoch !== cloudWorkspaceGatewayEpoch(workspace)
			)
				return yield* unauthorized("workspace_runtime_fenced");
			const { permission, actor } = yield* cloudWorkspaceActorPermission(
				workspace,
				body.actorId,
				body.membershipId,
			);
			return json({ permission, actor });
		}
		if (method === "POST" && activityMatch !== null) {
			const workspaceId = decodeURIComponent(activityMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const active = yield* recordWorkspaceActivity(workspace, true);
			if (
				active !== null &&
				runtimeActivityLifecycle(active).state !== active.state
			)
				yield* store.saveWorkspace({
					...active,
					...runtimeActivityLifecycle(active),
					revision: active.revision + 1,
					updatedAtMs: nowMs,
				});
			return json({ ok: true });
		}

		const runtimeCommandsMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/commands$/u.exec(path);
		const runtimeAssetMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/attachments\/([^/]+)$/u.exec(
				path,
			);
		if (method === "GET" && runtimeAssetMatch !== null) {
			const workspaceId = decodeURIComponent(runtimeAssetMatch[1] ?? "");
			const assetId = decodeURIComponent(runtimeAssetMatch[2] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const stored = yield* getApiAsset(
				workspace.accountId,
				workspaceId,
				assetId,
			);
			if (stored === null)
				return yield* Effect.fail(notFound("api_asset_not_found"));
			return json({
				asset: stored.asset,
				bytes: bytesToBase64Url(stored.bytes),
			});
		}
		if (method === "GET" && runtimeCommandsMatch !== null) {
			const workspaceId = decodeURIComponent(runtimeCommandsMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const pending = yield* store.claimNextApiCommand(workspaceId, nowMs);
			const supportsApiAssets =
				runtimeBootstrapReceiptFromConfig(
					workspace.requestConfig,
				)?.capabilities?.includes(CLOUD_RUNTIME_API_ASSETS_CAPABILITY) === true;
			// SessionDomain accepts one active turn at a time. Strict FIFO keeps a
			// second durable command from colliding with the turn just started here.
			const commands = yield* Effect.forEach(
				pending === null ? [] : [pending],
				(message) =>
					Effect.gen(function* () {
						const content = decodeApiMessageContent(
							yield* openApiMessageString(
								workspace.accountId,
								workspaceId,
								message.messageId,
								message.sealedContent,
							),
						);
						// Keep attachment commands pending until an upgraded runtime is active.
						// Older runtimes ignore the optional wire field and would otherwise ACK
						// the command after silently dropping its files.
						if (
							content.githubBot === true &&
							!runtimeBootstrapReceiptFromConfig(
								workspace.requestConfig,
							)?.capabilities?.includes(
								CLOUD_RUNTIME_GITHUB_EXECUTION_CAPABILITY,
							)
						)
							return null;
						if (content.attachments.length > 0 && !supportsApiAssets)
							return null;
						return {
							messageId: message.messageId,
							commandId: message.commandId ?? `api:${message.messageId}`,
							turnId:
								message.turnId ?? cloudRuntimeCommandTurnId(message.messageId),
							sessionId: workspace.initialSessionId,
							text: content.text,
							githubBot: content.githubBot,
							actor: content.actor,
							...(content.attachments.length === 0
								? {}
								: { attachments: content.attachments }),
							seq: message.seq,
						};
					}),
			);
			return json({ commands: commands.filter((command) => command !== null) });
		}

		const runtimeCommandAckMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/commands\/ack$/u.exec(path);
		const runtimeAcknowledgment =
			method === "POST" && runtimeCommandAckMatch !== null
				? yield* decodeBody(
						Schema.Union([CloudRuntimeCommandAck, RuntimeAcknowledgment]),
						request.clone(),
					)
				: null;
		if (
			runtimeCommandAckMatch !== null &&
			runtimeAcknowledgment !== null &&
			"messageId" in runtimeAcknowledgment
		) {
			const workspaceId = decodeURIComponent(runtimeCommandAckMatch[1] ?? "");
			yield* requireRuntime(request, workspaceId, nowMs);
			const body = runtimeAcknowledgment;
			const acknowledged = yield* store.ackApiCommand(
				workspaceId,
				body.messageId,
				body.turnId,
				body.commandTurnId,
				nowMs,
			);
			return json({ ok: acknowledged });
		}

		const runtimeTurnEventsMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/turn-events$/u.exec(path);
		if (method === "POST" && runtimeTurnEventsMatch !== null) {
			const workspaceId = decodeURIComponent(runtimeTurnEventsMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const body = yield* decodeBody(CloudRuntimeTurnEventUpload, request);
			if (
				body.replyText.length > CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH ||
				!Number.isSafeInteger(body.settledAt) ||
				body.settledAt < 0 ||
				body.settledAt > nowMs + 5 * 60_000
			)
				return yield* Effect.fail(badRequest("invalid_turn_event"));
			// v1 of the public API follows the initial session only.
			if (body.sessionId !== workspace.initialSessionId)
				return json({ recorded: false });
			const messageId = `msg_turn_${(
				yield* sha256Hex(`${workspaceId}\n${body.turnId}`)
			).slice(0, 40)}`;
			const priorAssistant = yield* store.getApiMessage(messageId);
			if (priorAssistant !== null) {
				if (
					priorAssistant.workspaceId !== workspaceId ||
					priorAssistant.accountId !== workspace.accountId ||
					priorAssistant.role !== "assistant" ||
					priorAssistant.turnId !== body.turnId ||
					priorAssistant.outcome !== body.outcome ||
					priorAssistant.status !== "settled"
				)
					return yield* Effect.fail(conflict("turn_event_reused"));
				const priorReply = yield* openApiMessageString(
					priorAssistant.accountId,
					priorAssistant.workspaceId,
					priorAssistant.messageId,
					priorAssistant.sealedContent,
				);
				if (priorReply !== body.replyText)
					return yield* Effect.fail(conflict("turn_event_reused"));
			}
			const eventId = `evt_${(
				yield* sha256Hex(`turn-completed\n${workspaceId}\n${body.turnId}`)
			).slice(0, 40)}`;
			const webhookPayload = JSON.stringify({
				eventId,
				type: "workspace.turn.completed",
				createdAt: body.settledAt,
				workspaceId,
				branch: workspace.branch,
				turnId: body.turnId,
				outcome: body.outcome,
				reply: { text: body.replyText, truncated: body.replyTruncated },
				messageId,
			});
			const contentDigest = yield* digestApiString(
				apiTurnReceiptDigestContext(
					workspace.accountId,
					workspaceId,
					body.turnId,
				),
				webhookPayload,
			);
			const sealedReply = yield* sealApiString(
				apiMessageSealContext(workspace.accountId, workspaceId, messageId),
				body.replyText,
			);
			const webhooks = (yield* store.listApiWebhooks(
				workspace.accountId,
			)).filter((webhook) => webhook.createdAtMs <= body.settledAt);
			const webhookFanout =
				webhooks.length === 0
					? undefined
					: {
							eventId,
							eventType: "workspace.turn.completed" as const,
							sealedPayload: yield* sealApiString(
								apiWebhookPayloadSealContext(workspace.accountId, eventId),
								webhookPayload,
							),
							enqueuedAtMs: nowMs,
							targets: yield* Effect.forEach(webhooks, (webhook) =>
								sha256Hex(
									`webhook-delivery\n${webhook.webhookId}\n${eventId}`,
								).pipe(
									Effect.map((digest) => ({
										deliveryId: `whd_${digest.slice(0, 40)}`,
										webhookId: webhook.webhookId,
									})),
								),
							),
						};
			const outcome = yield* store.recordApiTurnEvent({
				messageId,
				workspaceId,
				accountId: workspace.accountId,
				turnId: body.turnId,
				outcome: body.outcome,
				sealedContent: sealedReply,
				contentDigest,
				nowMs: body.settledAt,
				receivedAtMs: nowMs,
				webhookFanout,
				...(priorAssistant === null ? {} : { adoptLegacyReplay: true }),
			});
			if (outcome.kind === "conflict")
				return yield* Effect.fail(conflict("turn_event_reused"));
			if (
				outcome.receipt.outcome !== body.outcome ||
				outcome.receipt.settledAtMs !== body.settledAt ||
				outcome.receipt.contentDigest !== contentDigest
			)
				return yield* Effect.fail(conflict("turn_event_reused"));
			if (outcome.kind === "replay") {
				const recordedReply = yield* openApiMessageString(
					outcome.message.accountId,
					outcome.message.workspaceId,
					outcome.message.messageId,
					outcome.message.sealedContent,
				);
				if (
					recordedReply !== body.replyText ||
					outcome.message.outcome !== body.outcome ||
					(priorAssistant === null &&
						outcome.message.createdAtMs !== body.settledAt)
				)
					return yield* Effect.fail(conflict("turn_event_reused"));
			}
			const response = json({ recorded: outcome.kind === "created" });
			if (webhookFanout !== undefined)
				response.headers.set(
					"x-zuse-deliver-cloud-webhooks",
					workspace.accountId,
				);
			return response;
		}

		const runtimeTranscriptMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/transcript-checkpoint$/u.exec(
				path,
			);
		if (method === "POST" && runtimeTranscriptMatch !== null) {
			const workspaceId = decodeURIComponent(runtimeTranscriptMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const body = yield* decodeBody(CloudTranscriptCheckpointUpload, request);
			const ciphertextBytes = new TextEncoder().encode(
				body.ciphertext,
			).byteLength;
			if (
				!Number.isSafeInteger(body.cursor.version) ||
				body.cursor.version < 0 ||
				body.cursor.epoch.length === 0 ||
				ciphertextBytes > MAX_CLOUD_TRANSCRIPT_CIPHERTEXT_BYTES ||
				(yield* Effect.promise(() => sha256Base64Url(body.ciphertext))) !==
					body.ciphertextSha256
			)
				return yield* Effect.fail(badRequest("invalid_transcript_checkpoint"));
			const generation = cloudWorkspaceRuntimeGeneration(workspace);
			const objectKey = cloudTranscriptObjectKey({
				workspaceId,
				sessionId: body.sessionId,
				runtimeGeneration: generation,
				epoch: body.cursor.epoch,
				version: body.cursor.version,
			});
			yield* putCloudTranscriptObject(objectKey, body.ciphertext).pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_store_unavailable"),
				),
			);
			const applied = yield* store.saveTranscriptCheckpoint({
				workspaceId,
				sessionId: body.sessionId,
				runtimeGeneration: generation,
				streamEpoch: body.cursor.epoch,
				streamVersion: body.cursor.version,
				objectKey,
				ciphertextSha256: body.ciphertextSha256,
				ciphertextBytes,
				createdAtMs: nowMs,
			});
			return json({
				applied,
				cursor: body.cursor,
				archiveRequested: workspace.desiredState === "archived",
			});
		}

		const runtimeTranscriptPageMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/transcript-message-page$/u.exec(
				path,
			);
		if (method === "POST" && runtimeTranscriptPageMatch !== null) {
			const workspaceId = decodeURIComponent(
				runtimeTranscriptPageMatch[1] ?? "",
			);
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const body = yield* decodeBody(CloudTranscriptMessagePageUpload, request);
			const checkpoint = yield* store.getTranscriptCheckpoint(
				workspaceId,
				body.sessionId,
			);
			const ciphertextBytes = new TextEncoder().encode(
				body.ciphertext,
			).byteLength;
			if (
				checkpoint === null ||
				checkpoint.runtimeGeneration !==
					cloudWorkspaceRuntimeGeneration(workspace) ||
				checkpoint.streamEpoch !== body.cursor.epoch ||
				checkpoint.streamVersion !== body.cursor.version ||
				!Number.isSafeInteger(body.beforeSequence) ||
				body.beforeSequence < 1 ||
				ciphertextBytes > MAX_CLOUD_TRANSCRIPT_PAGE_CIPHERTEXT_BYTES ||
				(yield* Effect.promise(() => sha256Base64Url(body.ciphertext))) !==
					body.ciphertextSha256
			)
				return yield* Effect.fail(
					badRequest("invalid_transcript_message_page"),
				);
			const objectKey = cloudTranscriptMessagePageObjectKey({
				workspaceId,
				sessionId: body.sessionId,
				runtimeGeneration: checkpoint.runtimeGeneration,
				epoch: body.cursor.epoch,
				version: body.cursor.version,
				beforeSequence: body.beforeSequence,
			});
			yield* putCloudTranscriptObject(objectKey, body.ciphertext).pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_store_unavailable"),
				),
			);
			return json({ applied: true });
		}

		const readyMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/ready$/u.exec(path);
		if (method === "POST" && readyMatch !== null) {
			const workspaceId = decodeURIComponent(readyMatch[1] ?? "");
			const body = yield* decodeBody(RuntimeReadyRequest, request);
			if (body.phase === "repository-ready") {
				const credential = bearer(request);
				if (credential === undefined)
					return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
				const updated = yield* store.markRuntimeRepositoryReady({
					workspaceId,
					currentCredentialHash: yield* sha256Hex(credential),
					commandProtocolVersion: body.commandProtocolVersion,
					deviceBridgeVersion: body.deviceBridgeVersion,
					nowMs,
					nextIdleAtMs: nowMs + idlePauseMs,
				});
				if (updated === null)
					return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
				return json(publicWorkspace(updated));
			}
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const timings = startupTimings(workspace);
			if (body.phase === "launch-failed") {
				console.error("[cloud-workspace] launch intent failed", {
					workspaceId,
					commandId: body.launchCommandId,
					errorCode: body.errorCode ?? "workspace_launch_failed",
				});
				const updated: CloudWorkspaceRecord = {
					...workspace,
					state: "failed",
					runtimeState: "offline",
					runtimeBootTokenHash: undefined,
					runtimeBootTokenExpiresAtMs: undefined,
					runtimeCredentialHash: undefined,
					statusCode:
						body.errorCode === "runtime-storage-replaced"
							? "runtime-storage-replaced"
							: "launch-failed",
					requestConfig: {
						...workspace.requestConfig,
						launchErrorCode: body.errorCode ?? "workspace_launch_failed",
						startupTimings: {
							...timings,
							connectedAt: timings.connectedAt ?? nowMs,
						},
					},
					nextActionAtMs: launchFailureNextActionAt({
						errorCode: body.errorCode,
						nowMs,
						idlePauseMs,
					}),
					lastActivityAtMs: nowMs,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				};
				yield* store.saveWorkspace(updated);
				return json({ workspace: publicWorkspace(updated) });
			}
			if (
				body.launchCommandId === undefined ||
				typeof body.sessionHeadVersion !== "number" ||
				!Number.isSafeInteger(body.sessionHeadVersion) ||
				body.sessionHeadVersion < 0
			)
				return yield* Effect.fail(conflict("launch_intent_receipt_rejected"));
			const completion = yield* store.completeLaunchIntent({
				workspaceId,
				commandId: body.launchCommandId,
				sessionHeadVersion: body.sessionHeadVersion,
				nowMs,
				nextActionAtMs: nowMs + idlePauseMs,
			});
			if (completion.kind !== "completed")
				return yield* Effect.fail(conflict("launch_intent_receipt_rejected"));
			return json(publicWorkspace(completion.workspace));
		}

		const gatewayMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/gateway$/u.exec(
			path,
		);
		const runtimeCommandMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/commands\/(lease|ack)$/u.exec(
				path,
			);
		if (method === "POST" && runtimeCommandMatch !== null) {
			const workspaceId = decodeURIComponent(runtimeCommandMatch[1] ?? "");
			const action = runtimeCommandMatch[2] as "lease" | "ack";
			const leaseRequest =
				action === "lease"
					? yield* decodeBody(RuntimeCommandLeaseRequest, request)
					: undefined;
			if (
				leaseRequest?.afterRevision !== undefined &&
				(!Number.isSafeInteger(leaseRequest.afterRevision) ||
					leaseRequest.afterRevision < 0)
			)
				return yield* Effect.fail(badRequest("cloud_mailbox_revision_invalid"));
			// Delete fences all new delivery, but an exact still-current runtime
			// credential must retain the bounded ability to publish the durable receipt
			// for a lease it already owns. The mailbox validates that original token.
			const workspace =
				action === "ack"
					? yield* authenticateRuntime(request, workspaceId, nowMs)
					: yield* requireRuntime(request, workspaceId, nowMs);
			const currentRuntimeGeneration =
				cloudWorkspaceRuntimeGeneration(workspace);
			if (
				action === "lease" &&
				(workspace.state !== "ready" ||
					workspace.desiredState !== "ready" ||
					workspace.runtimeState !== "online" ||
					workspace.providerSandboxId === undefined ||
					!workspaceSupportsCloudCommandMailbox(workspace))
			)
				return yield* Effect.fail(
					conflict("cloud_workspace_runtime_not_ready"),
				);
			const billingCapacity =
				action === "lease"
					? yield* cloudBillingCapacity(
							workspace.accountId,
							nowMs,
							connectionIdFor(workspace),
						)
					: undefined;
			const mailboxWakePending =
				workspace.requestConfig.cloudMailboxWakePending === true;
			const wakeRevision =
				action === "lease" && billingCapacity === "available"
					? yield* store.recordMailboxRuntimePoll(
							workspaceId,
							workspace.accountId,
							currentRuntimeGeneration,
							nowMs,
							nowMs + MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
						)
					: null;
			if (
				action === "lease" &&
				billingCapacity === "available" &&
				mailboxWakePending &&
				wakeRevision === null
			)
				return yield* Effect.fail(
					conflict("cloud_workspace_runtime_not_ready"),
				);
			// Do not cross into the Durable Object on an idle poll. If an enqueue
			// races after the atomic store observation, that enqueue owns a newer wake
			// revision and the consumer's next poll will drain it. This closes the
			// inverse race where an unobserved command could be leased between the
			// store check and the DO request.
			if (
				action === "lease" &&
				billingCapacity === "available" &&
				wakeRevision === null &&
				leaseRequest?.waitMs === undefined
			)
				return json({ leases: [] });
			const payload =
				action === "lease"
					? {
							...leaseRequest,
							waitOnly:
								wakeRevision === null && billingCapacity === "available",
							runtimeGeneration: currentRuntimeGeneration,
							providerSandboxId: workspace.providerSandboxId,
							destructionFence: workspaceDestructionFence(workspace),
						}
					: yield* decodeBody(RuntimeAcknowledgment, request);
			const response = json(payload);
			if (action !== "lease")
				return attachCloudMailboxCommandDirective(response, {
					action,
					workspaceId,
				});
			attachCloudMailboxCommandDirective(response, {
				action,
				workspaceId,
				runtimeGeneration: currentRuntimeGeneration,
				...(wakeRevision === null ? {} : { wakeRevision }),
			});
			return attachMailboxBillingPolicy(
				response,
				billingCapacity as CloudBillingCapacity,
				workspace.accountId,
			);
		}
		if (method === "GET" && gatewayMatch !== null) {
			if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
				return yield* Effect.fail(badRequest("websocket_upgrade_required"));
			const workspaceId = decodeURIComponent(gatewayMatch[1] ?? "");
			const gateway = gatewayCredential(request);
			if (gateway === undefined)
				return yield* Effect.fail(unauthorized("workspace_gateway_rejected"));
			const { credential, protocol } = gateway;
			const api = yield* ApiConfiguration;
			const mintPublicJwk = yield* parseJwk(api.mintPublicKey);
			const runtimeTicket = yield* verifyWorkspaceRuntimeTicket({
				token: credential,
				mintPublicJwk,
				issuer: api.apiIssuer,
				expectedWorkspaceId: workspaceId,
				expectedProtocol: protocol,
				nowMs,
			}).pipe(Effect.result);
			if (runtimeTicket._tag === "Success") {
				const response = new Response(null, { status: 204 });
				response.headers.set("x-zuse-gateway-workspace", workspaceId);
				response.headers.set(
					"x-zuse-gateway-generation",
					String(runtimeTicket.success.generation),
				);
				response.headers.set(
					"x-zuse-gateway-epoch",
					String(runtimeTicket.success.gatewayEpoch),
				);
				response.headers.set("x-zuse-gateway-role", "runtime");
				response.headers.set("x-zuse-gateway-protocol", protocol);
				return response;
			}
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null)
				return yield* Effect.fail(unauthorized("workspace_gateway_rejected"));
			const credentialHash = yield* sha256Hex(credential);
			const runtime =
				workspace.runtimeCredentialHash === credentialHash &&
				typeof workspace.requestConfig.runtimeCredentialExpiresAtMs ===
					"number" &&
				workspace.requestConfig.runtimeCredentialExpiresAtMs > nowMs;
			const client = runtime
				? false
				: yield* verifyWorkspaceClientTicket({
						token: credential,
						mintPublicJwk,
						issuer: api.apiIssuer,
						expectedAccountId: workspace.accountId,
						expectedWorkspaceId: workspaceId,
						expectedProtocol: protocol,
						expectedGeneration: cloudWorkspaceRuntimeGeneration(workspace),
						expectedGatewayEpoch: cloudWorkspaceGatewayEpoch(workspace),
						nowMs,
					}).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.warn("[cloud-workspace] gateway upgrade rejected", {
									workspaceId,
									phase: "client-ticket",
									code: error.code,
								}),
							),
						),
					);
			let livePermission: "view" | "edit" | undefined;
			if (
				client &&
				workspaceScopeForOwner(workspace.accountId).kind === "organization"
			) {
				if (!workspaceRuntimeSupportsScope(workspace))
					return yield* conflict("workspace_runtime_update_required");
				livePermission = (yield* cloudWorkspaceActorPermission(
					workspace,
					client.actorId,
				)).permission;
			}
			if (!runtime && !client) {
				console.warn("[cloud-workspace] gateway upgrade rejected", {
					workspaceId,
					phase: "credential",
					runtimeTicketCode: runtimeTicket.failure.code,
					runtimeCredentialPresent:
						workspace.runtimeCredentialHash !== undefined,
					runtimeCredentialLive:
						typeof workspace.requestConfig.runtimeCredentialExpiresAtMs ===
							"number" &&
						workspace.requestConfig.runtimeCredentialExpiresAtMs > nowMs,
				});
				return yield* Effect.fail(unauthorized("workspace_gateway_rejected"));
			}
			if (
				client &&
				(workspaceDeletionRequested(workspace) ||
					workspace.desiredState === "archived" ||
					(protocol === WORKSPACE_GATEWAY_PENDING_PROTOCOL
						? workspace.desiredState !== "ready" ||
							![
								"queued",
								"provisioning",
								"resuming",
								"paused",
								"ready",
							].includes(workspace.state)
						: workspace.state !== "ready" ||
							workspace.runtimeState !== "online"))
			)
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			console.info("[cloud-workspace] gateway upgrade accepted", {
				workspaceId,
				protocol,
				generation: cloudWorkspaceRuntimeGeneration(workspace),
				gatewayEpoch: cloudWorkspaceGatewayEpoch(workspace),
				role: runtime ? "runtime" : "client",
			});
			const response = new Response(null, { status: 204 });
			response.headers.set("x-zuse-gateway-workspace", workspaceId);
			if (
				client &&
				workspaceScopeForOwner(workspace.accountId).kind === "organization"
			) {
				response.headers.set("x-zuse-gateway-actor", client.actorId);
				response.headers.set(
					"x-zuse-gateway-permission",
					client.permission === "edit" && livePermission === "edit"
						? "edit"
						: "view",
				);
			}
			response.headers.set(
				"x-zuse-gateway-generation",
				String(cloudWorkspaceRuntimeGeneration(workspace)),
			);
			response.headers.set(
				"x-zuse-gateway-epoch",
				String(cloudWorkspaceGatewayEpoch(workspace)),
			);
			response.headers.set(
				"x-zuse-gateway-role",
				runtime ? "runtime" : "client",
			);
			response.headers.set("x-zuse-gateway-protocol", protocol);
			if (client)
				response.headers.set(
					"x-zuse-gateway-connection",
					yield* randomToken("connection", 12),
				);
			return response;
		}

		const actionMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/(pause|resume|restart|update|archive|unarchive|delete)$/u.exec(
				path,
			);
		const access =
			delegatedAccess ??
			(yield* requireWorkspaceAccess(
				request,
				workspaceAccessForPath(path, method) ?? "content",
			));
		if (
			access.scope.kind === "organization" &&
			workspaceAccessForPath(path, method) === undefined
		)
			return yield* forbidden("workspace_scope_not_supported");
		const ownerId = access.ownerId;
		if (path === ApiPaths.cloudSettings) {
			if (method === "GET")
				return json(yield* store.getWorkspaceSettings(ownerId));
			if (method === "PUT") {
				const input = yield* decodeBody(WorkspaceSettingsUpdate, request);
				const updated = yield* store.replaceWorkspaceSettings(ownerId, input);
				if (updated === null)
					return yield* conflict("workspace_settings_changed");
				return json(updated);
			}
			return yield* badRequest("invalid_workspace_settings_method");
		}
		if (
			path === ApiPaths.cloudSharingDefaults &&
			(method === "GET" || method === "PUT")
		) {
			if (access.scope.kind !== "organization")
				return yield* badRequest("organization_workspace_required");
			return json(
				method === "GET"
					? yield* getOrganizationSharingDefaults(access.scope.organizationId)
					: yield* setOrganizationSharingDefaults(
							access.actor.accountId,
							access.scope.organizationId,
							yield* decodeBody(ChatSharingDefaults, request),
						),
			);
		}
		const sharingMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/sharing$/u.exec(
			path,
		);
		if ((method === "GET" || method === "PUT") && sharingMatch !== null) {
			if (access.scope.kind !== "organization")
				return yield* badRequest("organization_workspace_required");
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(sharingMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* notFound("cloud_workspace_not_found");
			const { canManageSharing } = yield* cloudWorkspacePermission(
				access,
				workspace,
			);
			if (method === "GET") {
				const policy = yield* Schema.decodeUnknownEffect(ChatSharingPolicy)(
					workspace.requestConfig.sharingPolicy,
				).pipe(
					Effect.mapError(() => forbidden("workspace_sharing_policy_invalid")),
				);
				return json({
					policy,
					revision: policy.revision ?? 0,
					canManageSharing,
				});
			}
			if (!canManageSharing) return yield* forbidden("workspace_access_denied");
			const body = yield* decodeBody(ChatSharingUpdate, request);
			yield* validateOrganizationChatGrants(
				access.scope.organizationId,
				body.grants.map((grant) => grant.membershipId),
			);
			const updated = yield* store.updateWorkspaceSharing({
				workspaceId: workspace.workspaceId,
				accountId: ownerId,
				expectedRevision: body.expectedRevision,
				sharing: {
					audience: body.audience,
					permission: body.permission,
					grants: body.grants,
				},
				nowMs,
			});
			if (updated === null) return yield* conflict("workspace_sharing_changed");
			return json({
				policy: updated.requestConfig.sharingPolicy,
				revision: body.expectedRevision + 1,
				canManageSharing,
			});
		}

		const commandCollectionMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/commands$/u.exec(path);
		const commandItemMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/commands\/([^/]+)$/u.exec(path);
		const commandWatchMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/commands\/watch$/u.exec(path);
		const mailboxWorkspaceId = decodeURIComponent(
			commandCollectionMatch?.[1] ??
				commandItemMatch?.[1] ??
				commandWatchMatch?.[1] ??
				"",
		);
		const dataKeyMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/data-key$/u.exec(
			path,
		);
		if (method === "GET" && dataKeyMatch !== null) {
			const workspaceId = decodeURIComponent(dataKeyMatch[1] ?? "");
			let workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (
				(yield* cloudWorkspacePermission(access, workspace)).permission !==
				"edit"
			)
				return yield* forbidden("workspace_access_denied");
			if (workspace.state === "deleted" || workspace.state === "deleting")
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			if (workspace.wrappedTranscriptKey === undefined) {
				const created = yield* createCloudTranscriptKey(
					workspace.accountId,
					workspace.workspaceId,
				).pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_transcript_key_unavailable"),
					),
				);
				workspace =
					(yield* store.installWrappedTranscriptKey(
						workspace.workspaceId,
						workspace.accountId,
						created.envelope,
						nowMs,
					)) ?? workspace;
			}
			const wrappedKey = workspace.wrappedTranscriptKey;
			if (wrappedKey === undefined)
				return yield* Effect.fail(
					serviceUnavailable("cloud_transcript_key_unavailable"),
				);
			const encodedKey = yield* openCloudTranscriptKey(
				workspace.accountId,
				workspace.workspaceId,
				wrappedKey,
			).pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_key_unavailable"),
				),
			);
			return json({
				workspaceId,
				encodedKey,
				keyVersion: 1,
				destructionFence: workspaceDestructionFence(workspace),
				mailboxEnabled:
					apiConfiguration.cloudCommandMailboxEnabled &&
					!workspaceRuntimeStorageUnavailable(workspace) &&
					workspaceAcceptsCloudCommandMailbox(workspace),
			});
		}
		if (
			commandCollectionMatch !== null ||
			commandItemMatch !== null ||
			commandWatchMatch !== null
		) {
			const workspace = yield* store.getWorkspace(mailboxWorkspaceId);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const commandAccess = yield* cloudWorkspacePermission(access, workspace);
			if (method !== "GET" && commandAccess.permission !== "edit")
				return yield* forbidden("workspace_access_denied");
			if (method === "POST" && commandCollectionMatch !== null) {
				if (
					workspaceDeletionRequested(workspace) ||
					workspace.state === "archived" ||
					workspace.state === "archiving" ||
					workspace.desiredState === "archived"
				)
					return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
				if (workspaceRuntimeStorageUnavailable(workspace))
					return yield* Effect.fail(conflict("runtime-storage-replaced"));
				if (!workspaceAcceptsCloudCommandMailbox(workspace))
					return yield* Effect.fail(
						conflict("cloud_command_runtime_update_required"),
					);
				const envelope = yield* decodeBody(CloudCommandEnvelope, request);
				if (
					envelope.workspaceId !== mailboxWorkspaceId ||
					cloudCommandEnvelopeEligibility(envelope) === undefined
				)
					return yield* Effect.fail(badRequest("cloud_command_not_eligible"));
				const destructionFence = workspaceDestructionFence(workspace);
				if (
					envelope.keyVersion !== 1 ||
					envelope.destructionFence !== destructionFence
				)
					return yield* Effect.fail(conflict("cloud_command_fence_stale"));
				const response = json(
					{
						...envelope,
						// Overwrite caller claims, including removing them for legacy Personal.
						actor:
							access.membership === null
								? undefined
								: {
										subject: access.actor.accountId,
										membershipId: access.membership.id,
									},
					},
					202,
				);
				return attachCloudMailboxCommandDirective(response, {
					action: "enqueue",
					workspaceId: mailboxWorkspaceId,
					accountId: ownerId,
				});
			}
			if (method === "GET" && commandWatchMatch !== null) {
				const afterRevision = Number(
					url.searchParams.get("afterRevision") ?? 0,
				);
				if (!Number.isSafeInteger(afterRevision) || afterRevision < 0)
					return yield* Effect.fail(badRequest("invalid_mailbox_revision"));
				const response = json({ afterRevision });
				return attachMailboxBillingPolicy(
					attachMailboxLifecycle(
						attachCloudMailboxCommandDirective(response, {
							action: "watch",
							workspaceId: mailboxWorkspaceId,
						}),
						workspace,
					),
					yield* cloudBillingCapacity(
						workspace.accountId,
						nowMs,
						connectionIdFor(workspace),
					),
					workspace.accountId,
				);
			}
			if (commandItemMatch !== null) {
				const commandId = decodeURIComponent(commandItemMatch[2] ?? "");
				const action =
					method === "GET" ? "status" : method === "DELETE" ? "cancel" : null;
				if (action === null)
					return yield* Effect.fail(badRequest("invalid_mailbox_action"));
				const response = json({ commandId });
				attachCloudMailboxCommandDirective(response, {
					action,
					workspaceId: mailboxWorkspaceId,
				});
				return action === "status"
					? attachMailboxBillingPolicy(
							attachMailboxLifecycle(response, workspace),
							yield* cloudBillingCapacity(
								workspace.accountId,
								nowMs,
								connectionIdFor(workspace),
							),
							workspace.accountId,
						)
					: attachMailboxLifecycle(response, workspace);
			}
		}
		if (method === "GET" && path === "/v1/cloud/github") {
			const installations = yield* refreshGithubConnections(ownerId);
			const grants = yield* githubInstallationGrants(ownerId).pipe(
				Effect.orElseSucceed(() => []),
			);
			return json({
				configured:
					apiConfiguration.githubApp?.clientId !== undefined &&
					apiConfiguration.githubApp.clientSecret !== undefined,
				user: yield* githubUserIdentity(access.actor.accountId),
				canManageInstallations:
					access.membership === null || access.membership.role.slug === "admin",
				installations: installations.map((installation) => ({
					installationId: installation.installationId,
					accountLogin: installation.accountLogin,
					accountType: installation.accountType,
					avatarUrl: installation.avatarUrl,
					repositorySelection: installation.repositorySelection,
					suspended: installation.suspended,
				})),
				repositories: grants.flatMap((grant) =>
					grant.repositories.map((repository) => ({
						nameWithOwner: repository.fullName,
						description: repository.description ?? null,
						sshUrl: `git@github.com:${repository.fullName}.git`,
						httpsUrl: repository.cloneUrl,
						isPrivate: repository.private,
						defaultBranch: repository.defaultBranch,
						updatedAt: repository.updatedAt,
						ownerAvatarUrl: repository.ownerAvatarUrl,
					})),
				),
			});
		}
		if (method === "POST" && path === "/v1/cloud/github/install") {
			const installUrl = yield* makeGithubInstallUrl(
				ownerId,
				access.actor.accountId,
			);
			return json({
				url: githubAuthorizationUrl(
					installUrl,
					apiConfiguration.publicApiOrigin ?? apiConfiguration.apiIssuer,
				),
			});
		}
		const githubDisconnectMatch =
			/^\/v1\/cloud\/github\/installations\/(\d+)$/u.exec(path);
		if (method === "DELETE" && githubDisconnectMatch !== null) {
			const installationId = Number(githubDisconnectMatch[1]);
			if (!Number.isSafeInteger(installationId))
				return yield* Effect.fail(badRequest("invalid_github_installation"));
			yield* disconnectGithubInstallation(ownerId, installationId);
			return json({ ok: true });
		}

		if (method === "GET" && path === ApiPaths.cloudAuth) {
			if (!(yield* hasEntitlement(ownerId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const status = yield* cloudAuthStatus(ownerId);
			return json(
				access.membership !== null && access.membership.role.slug !== "admin"
					? {
							authorityState: status.authorityState,
							providers: status.providers.map(({ providerId, state }) => ({
								providerId,
								state,
							})),
						}
					: status,
			);
		}
		if (method === "POST" && path === ApiPaths.cloudAuthProvision) {
			if (!(yield* hasEntitlement(ownerId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			return json(yield* provisionCloudAuth(ownerId));
		}
		if (method === "POST" && path === ApiPaths.cloudAuthConfigure) {
			if (!(yield* hasEntitlement(ownerId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const body = yield* decodeBody(CloudAuthConfigureRequest, request);
			return json(yield* configureCloudAuth(ownerId, body));
		}
		if (method === "POST" && path === ApiPaths.cloudAuthLoginStart) {
			if (!(yield* hasEntitlement(ownerId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const body = yield* decodeBody(CloudAuthLoginStartRequest, request);
			return json(yield* startCloudAuthLogin(ownerId, body.providerId));
		}
		const cloudAuthLoginMatch = /^\/v1\/cloud\/auth\/login\/([^/]+)$/u.exec(
			path,
		);
		if (method === "GET" && cloudAuthLoginMatch !== null) {
			return json(
				yield* pollCloudAuthLogin(
					ownerId,
					decodeURIComponent(cloudAuthLoginMatch[1] ?? ""),
				),
			);
		}
		const cloudAuthCancelMatch =
			/^\/v1\/cloud\/auth\/login\/([^/]+)\/cancel$/u.exec(path);
		if (method === "POST" && cloudAuthCancelMatch !== null) {
			return json(
				yield* cancelCloudAuthLogin(
					ownerId,
					decodeURIComponent(cloudAuthCancelMatch[1] ?? ""),
				),
			);
		}
		const cloudAuthDisconnectMatch =
			/^\/v1\/cloud\/auth\/providers\/([^/]+)$/u.exec(path);
		if (method === "DELETE" && cloudAuthDisconnectMatch !== null) {
			const providerId = yield* Schema.decodeUnknownEffect(CloudAuthProvider)(
				decodeURIComponent(cloudAuthDisconnectMatch[1] ?? ""),
			).pipe(Effect.mapError(() => badRequest("invalid_cloud_auth_provider")));
			return json(yield* disconnectCloudAuth(ownerId, providerId));
		}

		const transcriptMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/sessions\/([^/]+)\/transcript-checkpoint$/u.exec(
				path,
			);
		if (method === "GET" && transcriptMatch !== null) {
			const workspaceId = decodeURIComponent(transcriptMatch[1] ?? "");
			const sessionId = decodeURIComponent(transcriptMatch[2] ?? "");
			const measure = (stage: string) =>
				measureCloudStage({ workspaceId }, `transcript.${stage}`);
			const workspace = yield* store
				.getWorkspace(workspaceId)
				.pipe(measure("workspace"));
			if (
				workspace === null ||
				workspace.accountId !== ownerId ||
				workspace.state === "deleted"
			)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			yield* cloudWorkspacePermission(access, workspace);
			const checkpoint = yield* store
				.getTranscriptCheckpoint(workspaceId, sessionId)
				.pipe(measure("metadata"));
			if (checkpoint === null) return json({ checkpoint: null });
			const localEpoch = url.searchParams.get("epoch");
			const localVersion = Number(url.searchParams.get("version"));
			if (
				localEpoch === checkpoint.streamEpoch &&
				Number.isSafeInteger(localVersion) &&
				localVersion >= checkpoint.streamVersion
			)
				return json({ checkpoint: null });
			const ciphertext = yield* getCloudTranscriptObject(
				checkpoint.objectKey,
			).pipe(
				measure("download"),
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_store_unavailable"),
				),
			);
			if (ciphertext === null)
				return yield* Effect.fail(
					serviceUnavailable("cloud_transcript_checkpoint_missing"),
				);
			const transcriptKey = yield* openCloudTranscriptKey(
				workspace.accountId,
				workspaceId,
				workspace.wrappedTranscriptKey ?? "",
			).pipe(
				measure("key"),
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_key_unavailable"),
				),
			);
			return json({
				checkpoint: {
					metadata: {
						workspaceId,
						sessionId,
						runtimeGeneration: checkpoint.runtimeGeneration,
						cursor: {
							epoch: checkpoint.streamEpoch,
							version: checkpoint.streamVersion,
						},
						objectKey: checkpoint.objectKey,
						ciphertextSha256: checkpoint.ciphertextSha256,
						ciphertextBytes: checkpoint.ciphertextBytes,
						createdAt: checkpoint.createdAtMs,
					},
					ciphertext,
					transcriptKey,
				},
			});
		}

		const transcriptPageMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/sessions\/([^/]+)\/transcript-message-page$/u.exec(
				path,
			);
		if (method === "GET" && transcriptPageMatch !== null) {
			const workspaceId = decodeURIComponent(transcriptPageMatch[1] ?? "");
			const sessionId = decodeURIComponent(transcriptPageMatch[2] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (
				workspace === null ||
				workspace.accountId !== ownerId ||
				workspace.state === "deleted"
			)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			yield* cloudWorkspacePermission(access, workspace);
			const checkpoint = yield* store.getTranscriptCheckpoint(
				workspaceId,
				sessionId,
			);
			const epoch = url.searchParams.get("epoch") ?? "";
			const version = Number(url.searchParams.get("version"));
			const beforeSequence = Number(url.searchParams.get("beforeSequence"));
			if (
				checkpoint === null ||
				checkpoint.streamEpoch !== epoch ||
				checkpoint.streamVersion !== version ||
				!Number.isSafeInteger(beforeSequence) ||
				beforeSequence < 1
			)
				return json({ page: null });
			const objectKey = cloudTranscriptMessagePageObjectKey({
				workspaceId,
				sessionId,
				runtimeGeneration: checkpoint.runtimeGeneration,
				epoch,
				version,
				beforeSequence,
			});
			const ciphertext = yield* getCloudTranscriptObject(objectKey).pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_store_unavailable"),
				),
			);
			if (ciphertext === null) return json({ page: null });
			const transcriptKey = yield* openCloudTranscriptKey(
				workspace.accountId,
				workspaceId,
				workspace.wrappedTranscriptKey ?? "",
			).pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_key_unavailable"),
				),
			);
			return json({
				page: {
					cursor: { epoch, version },
					beforeSequence,
					ciphertext,
					ciphertextSha256: yield* Effect.promise(() =>
						sha256Base64Url(ciphertext),
					),
					transcriptKey,
				},
			});
		}

		if (path === ApiPaths.cloudProviderConnections) {
			let result: ReturnType<typeof publicProviderConnections>;
			if (method === "POST") {
				const body = yield* decodeBody(
					CloudProviderConnectionInput,
					request,
					8192,
				);
				result = yield* saveProviderConnection(ownerId, body, nowMs);
			} else if (method === "DELETE") {
				const body = yield* decodeBody(
					Schema.Struct({ connectionId: Schema.String }),
					request,
				);
				const connections = yield* Effect.serviceOption(
					CloudProviderConnections,
				);
				if (Option.isNone(connections))
					return yield* serviceUnavailable(
						"cloud_provider_connection_storage_unavailable",
					);
				yield* connections.value.disconnect(ownerId, body.connectionId);
				result = publicProviderConnections(
					yield* listProviderConnections(ownerId),
				);
			} else if (method === "GET") {
				result = publicProviderConnections(
					yield* listProviderConnections(ownerId),
				);
			} else return yield* badRequest("invalid_method");
			const response = json({
				...result,
				customSnapshotsEnabled:
					apiConfiguration.cloudBoxdCustomSnapshotsEnabled,
			});
			response.headers.set("cache-control", "no-store");
			return response;
		}

		if (method === "GET" && path === ApiPaths.cloudProviders)
			return json(yield* cloudProviderOptions(ownerId, nowMs));

		if (method === "GET" && path === ApiPaths.cloudAccountImage) {
			const requested = url.searchParams.get("providerId") ?? undefined;
			if (requested !== undefined) yield* selectedProvider(ownerId, requested);
			return json(
				yield* cloudAccountImage(
					ownerId,
					requested,
					access.membership === null || access.membership.role.slug === "admin",
				),
			);
		}

		if (method === "POST" && path === ApiPaths.cloudSnapshotImport) {
			if (!apiConfiguration.cloudBoxdCustomSnapshotsEnabled)
				return yield* conflict("custom_snapshots_not_enabled");
			const body = yield* decodeBody(
				CloudSnapshotImportRequest,
				request,
				160_000,
			);
			const provider = yield* selectedProvider(ownerId, "boxd");
			if (
				provider.connectionId === undefined ||
				provider.connectionId !== body.connectionId
			)
				return yield* forbidden("cloud_provider_connection_required");
			if (
				body.runtimeUser === "root" ||
				body.repositoryPaths.some(
					(path) => !path.startsWith("/") || /[\0\r\n]/u.test(path),
				)
			)
				return yield* badRequest("invalid_snapshot_configuration");
			const builds = yield* store.listAccountBuilds(ownerId, "boxd");
			if (
				body.agentAuthentication === "zuse" &&
				(!apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled ||
					!apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled)
			)
				return yield* conflict("provider-auth-update-required");
			const digest = yield* sha256Hex(JSON.stringify(body));
			const previous = builds.find(
				(build) => build.idempotencyKey === `snapshot:${body.idempotencyKey}`,
			);
			if (previous) {
				if (previous.configurationDigest !== digest)
					return yield* conflict("idempotency_key_reused");
				const response = json(yield* cloudAccountImage(ownerId, "boxd"), 202);
				response.headers.set("x-zuse-reconcile-cloud-build", previous.buildId);
				return response;
			}

			if (
				builds.some(
					(build) =>
						build.state === "queued" ||
						build.state === "building" ||
						build.state === "sanitizing",
				)
			)
				return yield* conflict("cloud_image_operation_in_progress");
			if (!provider.resolveSnapshotSource)
				return yield* conflict("custom_snapshots_not_supported");
			const source = yield* provider
				.resolveSnapshotSource(body.snapshotId)
				.pipe(
					Effect.mapError(() => badRequest("snapshot_not_ready_or_accessible")),
				);
			const created = yield* store.createBuild({
				buildId: yield* randomToken("image", 12),
				projectId: null,
				accountId: ownerId,
				provider: "boxd",
				templateVersion: provider.templateVersion,
				configurationDigest: digest,
				settings: {
					source: "custom-snapshot",
					snapshotVersion: source.version,
					// Resolve names once; retries and launches retain this source generation.
					snapshot: { ...body, snapshotId: source.snapshotId },
					providerConnectionId: provider.connectionId,
				},
				state: "queued",
				idempotencyKey: `snapshot:${body.idempotencyKey}`,
				nextActionAtMs: nowMs,
				revision: 0,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			});
			const response = json(yield* cloudAccountImage(ownerId, "boxd"), 202);
			response.headers.set("x-zuse-reconcile-cloud-build", created.buildId);
			return response;
		}

		if (method === "POST" && path === ApiPaths.cloudAccountImageDelete) {
			const body = yield* decodeBody(CloudAccountImageDeleteRequest, request);
			yield* deleteRetainedSnapshot(ownerId, body.snapshotId, nowMs);
			return json(yield* cloudAccountImage(ownerId, "box"), 202);
		}
		if (method === "POST" && path === ApiPaths.cloudAccountImageBuild) {
			if (!(yield* hasEntitlement(ownerId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const body = yield* decodeBody(CloudAccountImageBuildRequest, request);
			const projects = yield* store.listProjects(ownerId);
			if (projects.length === 0)
				return yield* Effect.fail(conflict("cloud_image_has_no_repositories"));
			const provider = yield* selectedProvider(ownerId, body.providerId);
			yield* requirePlacementAccess(ownerId, nowMs, provider);
			const builds = yield* store.listAccountBuilds(
				ownerId,
				provider.providerId,
			);
			const activeBuild = yield* store.getActiveAccountBuild(
				ownerId,
				provider.providerId,
			);
			const auth = yield* cloudAuthStatus(ownerId);
			const authenticationChanged = auth.providers.some(
				(status) =>
					!apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled &&
					!(
						apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled &&
						status.providerId === "codex"
					) &&
					status.verifiedAt !== undefined &&
					activeBuild !== null &&
					status.verifiedAt > activeBuild.updatedAtMs,
			);
			const effectiveMode =
				body.mode === "rebuild" || authenticationChanged
					? ("rebuild" as const)
					: ("update" as const);
			const inProgress = builds.find(
				(candidate) =>
					candidate.state === "queued" ||
					candidate.state === "building" ||
					candidate.state === "sanitizing",
			);
			if (inProgress !== undefined)
				return json(
					yield* cloudAccountImage(ownerId, provider.providerId),
					202,
				);
			const configurationDigest = yield* sha256Hex(
				JSON.stringify(
					cloudAccountImageConfiguration({
						mode: effectiveMode,
						templateVersion: provider.templateVersion,
						codexAuthDeliveryVersion:
							apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled ? 1 : 0,
						providerAuthDeliveryVersion:
							apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled ? 1 : 0,
						projects,
					}),
				),
			);
			const anchor = projects[0] as CloudProjectRecord;
			const build: CloudProjectBuildRecord = {
				buildId: yield* randomToken("image", 12),
				projectId: anchor.projectId,
				accountId: ownerId,
				provider: provider.providerId,
				templateVersion: provider.templateVersion,
				configurationDigest,
				settings: {
					providerConnectionId: provider.connectionId,
					mode: effectiveMode,
					...(apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled
						? { codexAuthDeliveryVersion: 1 }
						: {}),
					...(apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled
						? { providerAuthDeliveryVersion: 1 }
						: {}),
					repositories: accountImageRepositories(projects),
					providers: auth.providers.map((status) => ({
						providerId: status.providerId,
						state: status.state,
						method: status.method,
						verifiedAt: status.verifiedAt,
					})),
				},
				state: "queued",
				idempotencyKey: `account-image:${effectiveMode}:${body.idempotencyKey}`,
				nextActionAtMs: nowMs,
				revision: 0,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			const created = yield* store.createBuild(build);
			for (const project of projects.filter(
				(project) => project.state !== "ready",
			))
				yield* store.saveProject({
					...project,
					state: "preparing",
					updatedAtMs: nowMs,
				});
			const response = json(
				yield* cloudAccountImage(ownerId, provider.providerId),
				202,
			);
			response.headers.set("x-zuse-reconcile-cloud-build", created.buildId);
			return response;
		}

		if (method === "GET" && path === ApiPaths.cloudProjects) {
			const projects = yield* store.listProjects(ownerId);
			const imports = (yield* store.listAccountBuilds(ownerId, "boxd")).filter(
				importedSnapshot,
			);

			const providers = yield* accountSandboxProviders(ownerId);
			const currentTemplateVersions = new Map(
				providers.map((provider) => [
					provider.providerId,
					provider.templateVersion,
				]),
			);
			return json({
				projects: yield* Effect.forEach(projects, (project) =>
					store
						.listBuilds(project.projectId)
						.pipe(
							Effect.map((builds) =>
								publicProject(
									project,
									[
										...builds,
										...imports.filter(
											(build) =>
												snapshotRepositoryLayout(build, project.projectId) !==
												undefined,
										),
									],
									currentTemplateVersions,
								),
							),
						),
				),
			});
		}

		if (
			method === "GET" &&
			(path === ApiPaths.cloudChats || path === ApiPaths.cloudChatChanges)
		) {
			const changes = path === ApiPaths.cloudChatChanges;
			const rawCursor = url.searchParams.get("cursor");
			const cursor =
				changes && rawCursor !== null ? Number(rawCursor) : undefined;
			if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
				return json({ error: "invalid-request" }, 400);
			// Organization membership and grants can change independently of a client's
			// cursor. A filtered replacement also removes revoked chats without exposing
			// tombstone IDs for private chats this member has never seen.
			const replacement = access.scope.kind === "organization";
			const catalog = yield* store.readCloudCatalog(
				ownerId,
				replacement ? undefined : cursor,
			);
			const projectId = url.searchParams.get("projectId");
			const scope = changes
				? "all"
				: (url.searchParams.get("scope") ?? "active");
			const deletedWorkspaceIds = replacement
				? []
				: [...catalog.deletedWorkspaceIds];
			const chats = [];
			for (const { workspace, project, runtimeSummary } of catalog.entries) {
				if (
					!(yield* cloudWorkspacePermission(access, workspace).pipe(
						Effect.as(true),
						Effect.catch(() => Effect.succeed(false)),
					))
				)
					continue;
				if (workspace.state === "deleted") {
					if (!replacement) deletedWorkspaceIds.push(workspace.workspaceId);
					continue;
				}
				if (projectId !== null && workspace.projectId !== projectId) continue;
				const archived =
					workspace.state === "archived" ||
					workspace.desiredState === "archived";
				if (scope !== "all" && (scope === "archived" ? !archived : archived))
					continue;
				const repaired = yield* repairAcknowledgedLaunch(
					workspace,
					runtimeSummary,
				);
				chats.push(
					publicCloudWorkspaceSummary(
						repaired,
						project,
						false,
						repaired.lastActivityAtMs,
						runtimeSummary,
					),
				);
			}
			return json(
				changes
					? {
							cursor: catalog.cursor,
							reset: replacement || catalog.reset,
							chats,
							deletedWorkspaceIds,
						}
					: { chats },
			);
		}

		if (method === "POST" && path === ApiPaths.cloudProjects) {
			if (!(yield* hasEntitlement(ownerId, nowMs)))
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
					defaultBranch: body.defaultBranch,
					preparationMode: "account-repository-cache-v1",
				}),
			);
			const project: CloudProjectRecord = {
				projectId: yield* randomToken("project", 12),
				accountId: ownerId,
				repositoryIdentity: repository.identity,
				repositoryUrl: repository.url,
				displayName: body.displayName ?? repository.name,
				defaultBranch: body.defaultBranch,
				visibility: body.visibility,
				gitConnectionKind: "github-app",
				cloudEnvironment: body.cloudEnvironment ?? {},
				secretBindings: body.secretBindings ?? [],
				configurationDigest,
				state: "connected",
				idempotencyKey: body.idempotencyKey,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			const connected = yield* store.connectProject(project);
			const providers = yield* accountSandboxProviders(ownerId);
			const currentTemplateVersions = new Map(
				providers.map((provider) => [
					provider.providerId,
					provider.templateVersion,
				]),
			);
			return json(publicProject(connected, [], currentTemplateVersions), 201);
		}

		const removeProjectMatch = /^\/v1\/cloud\/projects\/([^/]+)$/u.exec(path);
		if (method === "DELETE" && removeProjectMatch !== null) {
			const projectId = decodeURIComponent(removeProjectMatch[1] ?? "");
			const project = yield* store.getProject(projectId);
			if (project === null || project.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const removed = yield* store.removeProject(projectId, nowMs);
			if (removed === null)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			return json(publicProject(removed, [], new Map()));
		}

		const prepareMatch = /^\/v1\/cloud\/projects\/([^/]+)\/prepare$/u.exec(
			path,
		);
		if (method === "POST" && prepareMatch !== null) {
			if (!(yield* hasEntitlement(ownerId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const projectId = decodeURIComponent(prepareMatch[1] ?? "");
			const body = yield* decodeBody(CloudProjectPrepareRequest, request);
			if (body.projectId !== projectId)
				return yield* Effect.fail(badRequest("project_mismatch"));
			const project = yield* store.getProject(projectId);
			if (project === null || project.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const provider = yield* selectedProvider(ownerId, body.providerId);
			yield* requirePlacementAccess(ownerId, nowMs, provider);
			const build: CloudProjectBuildRecord = {
				buildId: yield* randomToken("build", 12),
				projectId,
				accountId: ownerId,
				provider: provider.providerId,
				templateVersion: provider.templateVersion,
				configurationDigest: project.configurationDigest,
				settings: { providerConnectionId: provider.connectionId },
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

		if (method === "GET" && path === ApiPaths.cloudWorkspaces) {
			const workspaces = yield* store.listWorkspaces(
				ownerId,
				url.searchParams.get("projectId") ?? undefined,
			);
			const visible = yield* Effect.filter(workspaces, (workspace) =>
				cloudWorkspacePermission(access, workspace).pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				),
			);
			return json({
				workspaces: yield* Effect.forEach(
					visible,
					(workspace) =>
						store
							.getRuntimeSummary(workspace.workspaceId)
							.pipe(
								Effect.map((summary) => publicWorkspace(workspace, summary)),
							),
					{ concurrency: 8 },
				),
			});
		}

		const workspaceMatch = /^\/v1\/cloud\/workspaces\/([^/]+)$/u.exec(path);
		if (method === "GET" && workspaceMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(workspaceMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			yield* cloudWorkspacePermission(access, workspace);
			return json(
				publicWorkspace(
					workspace,
					yield* store.getRuntimeSummary(workspace.workspaceId),
				),
			);
		}

		const connectionTicketMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/gateway\/ticket$/u.exec(path);
		if (method === "POST" && connectionTicketMatch !== null) {
			const workspaceId = decodeURIComponent(connectionTicketMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const { permission } = yield* cloudWorkspacePermission(access, workspace);
			if (workspace.state === "failed" || workspace.state === "deleted")
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			// Reject before the WebSocket handshake, where browsers hide HTTP errors.
			if (!workspaceRuntimeSupportsScope(workspace))
				return yield* conflict("workspace_runtime_update_required");
			const ticketRequest =
				request.body === null
					? {}
					: yield* decodeBody(
							Schema.Struct({
								protocol: Schema.optional(
									Schema.Literals([
										WORKSPACE_GATEWAY_PENDING_PROTOCOL,
										WORKSPACE_GATEWAY_PROTOCOL,
									]),
								),
							}),
							request,
						);
			const protocol = ticketRequest.protocol ?? WORKSPACE_GATEWAY_PROTOCOL;
			const api = yield* ApiConfiguration;
			const expiresAt = nowMs + WORKSPACE_CLIENT_TICKET_TTL_MS;
			const credential = yield* signWorkspaceClientTicket({
				mintPrivateJwk: yield* parseJwk(Redacted.value(api.mintPrivateKey)),
				issuer: api.apiIssuer,
				accountId: ownerId,
				actorId: access.actor.accountId,
				permission,
				deviceId:
					request.headers.get("x-zuse-device-id") ?? access.actor.accountId,
				workspaceId,
				protocol,
				generation: cloudWorkspaceRuntimeGeneration(workspace),
				gatewayEpoch: cloudWorkspaceGatewayEpoch(workspace),
				ttlMs: WORKSPACE_CLIENT_TICKET_TTL_MS,
				nowMs,
			});
			console.info("[cloud-workspace] client ticket minted", {
				workspaceId,
				expiresAt,
			});
			const response = json({
				workspaceId,
				wsUrl: gatewayUrl(api.apiIssuer, workspaceId),
				workspaceScope: access.scope,
				protocol,
				role: "client",
				generation: cloudWorkspaceRuntimeGeneration(workspace),
				gatewayEpoch: cloudWorkspaceGatewayEpoch(workspace),
				credential,
				expiresAt,
			});
			return response;
		}

		const sshAccessMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/ssh-access$/u.exec(path);
		if (method === "POST" && sshAccessMatch !== null) {
			const workspaceId = decodeURIComponent(sshAccessMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (
				workspace.state !== "ready" ||
				workspace.providerSandboxId === undefined
			)
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			const project = yield* store.getProject(workspace.projectId);
			if (project === null)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const provider = yield* resolveResourceProvider(workspace).pipe(
				Effect.mapError(() => serviceUnavailable("cloud_provider_unavailable")),
			);
			const ticket = yield* randomToken("workspace_ssh", 32);
			const ticketExpiresAtMs = nowMs + WORKSPACE_SSH_TICKET_TTL_MS;
			yield* provider
				.writeTextFile(
					workspace.providerSandboxId,
					cloudWorkspaceLayout(workspace).sshTicket,
					JSON.stringify({
						tokenHash: yield* sha256Hex(ticket),
						expiresAtMs: ticketExpiresAtMs,
					}),
					cloudWorkspaceLayout(workspace).user,
				)
				.pipe(
					Effect.mapError((error) =>
						error.code === "not-found"
							? notFound("cloud_workspace_sandbox_not_found")
							: serviceUnavailable("cloud_workspace_ssh_unavailable"),
					),
				);
			const offer = yield* SandboxOfferConfiguration;
			const endpoint = yield* provider
				.resolveEndpoint(workspace.providerSandboxId, offer.port)
				.pipe(
					Effect.mapError((error) =>
						error.code === "not-found"
							? notFound("cloud_workspace_sandbox_not_found")
							: serviceUnavailable("cloud_workspace_ssh_unavailable"),
					),
				);
			yield* recordWorkspaceActivity(workspace);
			console.info("[cloud-workspace] ssh access issued", {
				workspaceId,
				expiresAt: ticketExpiresAtMs,
			});
			return json({
				workspaceId,
				wsUrl: `${endpoint.wsBaseUrl}/ssh`,
				ticket,
				expiresAt: ticketExpiresAtMs,
				user: cloudWorkspaceLayout(workspace).user,
				workspacePath: cloudWorkspaceRepositoryPath(
					workspace,
					project.repositoryIdentity,
				),
			});
		}

		const previewUrlMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/preview-url$/u.exec(path);
		if (
			(method === "POST" || method === "DELETE") &&
			previewUrlMatch !== null
		) {
			const workspaceId = decodeURIComponent(previewUrlMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (
				(method === "POST" && workspace.state !== "ready") ||
				workspace.providerSandboxId === undefined
			)
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			const body = yield* decodeBody(
				Schema.Struct({ port: Schema.optional(Schema.Number) }),
				request,
			);
			const offer = yield* SandboxOfferConfiguration;
			if (
				body.port === undefined
					? method !== "DELETE"
					: !Number.isInteger(body.port) ||
						body.port <= 0 ||
						body.port > 65_535 ||
						body.port === offer.port
			)
				return yield* Effect.fail(badRequest("invalid_preview_port"));
			// The returned host is public-by-URL: anyone holding it reaches the
			// port with no further auth. The high-entropy sandbox id is the trust
			// model (like sharing a tunnel link). Pausing does not revoke a route:
			// providers such as boxd can wake the machine on inbound traffic.
			const provider = yield* resolveResourceProvider(workspace).pipe(
				Effect.mapError(() => serviceUnavailable("cloud_provider_unavailable")),
			);
			if (method === "DELETE") {
				if (provider.revokeEndpoint === undefined)
					return yield* Effect.fail(
						conflict("cloud_workspace_preview_revocation_unsupported"),
					);
				yield* provider
					.revokeEndpoint(workspace.providerSandboxId, body.port)
					.pipe(
						Effect.mapError(() =>
							serviceUnavailable("cloud_workspace_preview_revocation_failed"),
						),
					);
				return json({ workspaceId, port: body.port });
			}

			if (body.port === undefined)
				return yield* Effect.fail(badRequest("invalid_preview_port"));
			const endpoint = yield* provider
				.resolveEndpoint(workspace.providerSandboxId, body.port)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_workspace_preview_unavailable"),
					),
				);
			yield* recordWorkspaceActivity(workspace);
			console.info("[cloud-workspace] preview url issued", {
				workspaceId,
				port: body.port,
			});
			return json({
				workspaceId,
				port: body.port,
				url: endpoint.httpBaseUrl,
				expiresAt: null,
			});
		}

		if (
			method === "POST" &&
			(path === ApiPaths.cloudWorkspaces ||
				path === ApiPaths.cloudWorkspacesFork)
		) {
			const body = yield* decodeBody(CloudWorkspaceCreateRequest, request);
			if (
				(path === ApiPaths.cloudWorkspacesFork) !==
				(body.forkSource !== undefined)
			)
				return yield* Effect.fail(badRequest("cloud_fork_endpoint_required"));
			const { workspace: launchedWorkspace, created } =
				yield* createCloudWorkspaceForAccount(
					ownerId,
					access.membership === null
						? body
						: {
								...body,
								idempotencyKey: `${access.membership.id}:${body.idempotencyKey}`,
							},
					nowMs,
					access.membership === null
						? undefined
						: {
								subject: access.actor.accountId,
								membershipId: access.membership.id,
							},
				);
			yield* cloudWorkspacePermission(access, launchedWorkspace);
			const response = json(
				{
					workspace: publicWorkspace(launchedWorkspace),
					chatId: launchedWorkspace.chatId,
					initialSessionId: launchedWorkspace.initialSessionId,
					...(launchedWorkspace.requestConfig
						.cloudCommandEnrollmentProtocolVersion ===
					CLOUD_COMMAND_PROTOCOL_VERSION
						? { initialMessageDelivery: "mailbox-v1" as const }
						: {}),
				},
				created ? 201 : 200,
			);
			if (created) {
				response.headers.set(
					"x-zuse-reconcile-cloud-workspace",
					launchedWorkspace.workspaceId,
				);
			}
			return response;
		}

		if (method === "POST" && actionMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(actionMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== ownerId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const action = actionMatch[2] as CloudWorkspaceLifecycleAction;
			if (
				(yield* cloudWorkspacePermission(access, workspace)).permission !==
				"edit"
			)
				return yield* forbidden("workspace_access_denied");
			if (
				(action === "resume" || action === "restart" || action === "update") &&
				connectionIdFor(workspace) === undefined
			)
				if (!(yield* hasPaidEntitlement(ownerId, nowMs)))
					return yield* forbidden("cloud_entitlement_required");
			if (action === "resume" || action === "restart" || action === "update")
				yield* requireCloudBillingCapacity(
					ownerId,
					nowMs,
					connectionIdFor(workspace),
				);
			if (action === "update") {
				const offer = yield* SandboxOfferConfiguration;
				if (
					offer.runtimeInstallerSource === undefined ||
					offer.runtimeManifestUrl === undefined
				)
					return yield* conflict("runtime_update_unavailable");
				if (
					(yield* resolveResourceProvider(workspace))
						.supportsFencedProcessReplacement !== true
				)
					return yield* conflict("runtime_guard_unavailable");
			}
			const actionRequest =
				action === "resume"
					? yield* decodeBody(CloudWorkspaceResumeRequest, request)
					: yield* decodeBody(CloudWorkspaceActionRequest, request);
			// Client socket loss and bearer expiry cannot establish execution loss.
			// Recovery follows stored lifecycle failure or an authoritative mailbox fence.
			const recoverRuntime =
				action === "resume" &&
				workspace.providerSandboxId !== undefined &&
				((workspace.state === "failed" &&
					(cloudWorkspaceHasRetainedRuntimeData(workspace) ||
						workspace.statusCode === "runtime-connection-timeout" ||
						workspace.statusCode === "runtime-activation-unconfirmed")) ||
					workspace.statusCode === "runtime-memory-recovery-failed" ||
					workspace.requestConfig.cloudMailboxFenceRequired === true);

			let failedRetryBuild: CloudProjectBuildRecord | null = null;
			if (
				action === "resume" &&
				!recoverRuntime &&
				workspace.state === "failed"
			) {
				const provider = yield* resolveResourceProvider(workspace);
				failedRetryBuild = yield* store.getActiveAccountBuild(
					ownerId,
					provider.providerId,
				);
				if (
					failedRetryBuild?.snapshotId === undefined ||
					!snapshotBuildCompatible(failedRetryBuild, provider.templateVersion)
				)
					return yield* Effect.fail(conflict("cloud_image_rebuild_required"));
			}
			const commandId =
				"commandId" in actionRequest && actionRequest.commandId !== undefined
					? actionRequest.commandId
					: `${action}:${workspace.workspaceId}:${nowMs}`;
			const desiredState =
				action === "resume" || action === "restart" || action === "update"
					? "ready"
					: action === "unarchive"
						? "paused"
						: action === "delete"
							? "deleted"
							: action === "archive"
								? "archived"
								: "paused";
			const updated: CloudWorkspaceRecord = {
				...workspace,
				...(failedRetryBuild === null
					? {}
					: { buildId: failedRetryBuild.buildId }),
				...(action === "update"
					? {
							requestConfig: {
								...workspace.requestConfig,
								runtimeReleaseChangeRequested: true,
							},
						}
					: {}),
				...(action === "restart"
					? {
							state: "resuming" as const,
							runtimeState: "offline" as const,
							requestConfig: {
								...withoutRuntimeBootstrapReceipt(workspace.requestConfig),
								runtimeSessionRecoveryPending: true,
								startupTimings: {
									requestedAt: nowMs,
									resumeRequestedAt: nowMs,
								},
							},
						}
					: {}),
				...(action === "resume" && recoverRuntime
					? {
							state: "resuming" as const,
							runtimeState: "offline" as const,
							requestConfig: {
								...withoutRuntimeBootstrapReceipt(workspace.requestConfig),
								runtimeSessionRecoveryPending: true,
								startupTimings: {
									requestedAt: nowMs,
									resumeRequestedAt: nowMs,
								},
							},
						}
					: {}),
				...(action === "unarchive"
					? {
							state: "paused" as const,
							runtimeState: "offline" as const,
						}
					: {}),
				...(action === "resume" &&
				!recoverRuntime &&
				workspace.state === "failed"
					? {
							...(failedRetryBuild?.buildId !== workspace.buildId
								? ({
										state: "queued",
										providerSandboxId: workspace.providerSandboxId,
									} as const)
								: failedWorkspaceResumeTarget(workspace)),
							runtimeState: "offline" as const,
							requestConfig: {
								...withoutRuntimeBootstrapReceipt(workspace.requestConfig),
								...(typeof workspace.requestConfig.sessionHeadVersion ===
								"number"
									? { runtimeSessionRecoveryPending: true }
									: {}),
								startupTimings: { requestedAt: nowMs },
							},
						}
					: {}),
				desiredState,
				statusCode: recoverRuntime
					? "resume-runtime-recovery-queued"
					: `${action}-queued`,
				nextActionAtMs: nowMs,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
				...(action === "resume" || action === "restart" || action === "update"
					? { lastActivityAtMs: nowMs }
					: {}),
			};
			const received: CloudWorkspaceRecord = {
				...updated,
				// An explicit retry starts a new bounded episode on the same disk.
				...((action === "resume" ||
					action === "restart" ||
					action === "update") &&
				workspace.statusCode === "runtime-memory-recovery-failed"
					? {
							requestConfig: {
								...updated.requestConfig,
								memoryRecoveryStartedAt: nowMs,
								memoryRecoveryAttempts: 0,
							},
						}
					: {}),
				...(action === "archive"
					? {
							archiveRequestedAtMs: nowMs,
							archiveDeleteAtMs: nowMs + ARCHIVED_WORKSPACE_RETENTION_MS,
						}
					: action === "unarchive"
						? {
								archiveRequestedAtMs: undefined,
								archiveDeleteAtMs: undefined,
							}
						: {}),
			};
			const transition = yield* store.transitionWorkspaceLifecycle({
				workspace: received,
				expectedRevision: workspace.revision,
				expectedUpdatedAtMs: workspace.updatedAtMs,
				expectedState: workspace.state,
				expectedDesiredState: workspace.desiredState,
				commandId,
				action,
				deduplicateRequestedResume:
					action === "resume" &&
					!recoverRuntime &&
					cloudWorkspaceResumeIsAlreadyRequested(workspace),
				createdAtMs: nowMs,
			});
			if (transition.kind === "missing")
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (transition.kind === "contended")
				return yield* Effect.fail(
					serviceUnavailable("cloud_workspace_transition_contended"),
				);
			if (transition.kind === "rejected") {
				if (transition.reason === "command-id-reused")
					return yield* Effect.fail(
						badRequest("cloud_workspace_command_id_reused"),
					);
				if (transition.reason === "workspace-not-running")
					return yield* Effect.fail(badRequest("cloud_workspace_not_running"));
				if (transition.reason === "mailbox-wake-pending")
					return yield* Effect.fail(
						conflict("cloud_workspace_mailbox_wake_pending"),
					);
				return yield* Effect.fail(
					conflict(
						transition.reason === "workspace-deleted"
							? "cloud_workspace_deleted"
							: transition.reason === "workspace-archived"
								? "cloud_workspace_archived"
								: transition.reason === "workspace-not-archived"
									? "cloud_workspace_not_archived"
									: "cloud_workspace_destruction_fence_exhausted",
					),
				);
			}
			const canonicalWorkspace = transition.workspace;
			const response = json(publicWorkspace(canonicalWorkspace));
			response.headers.set(
				"x-zuse-reconcile-cloud-workspace",
				canonicalWorkspace.workspaceId,
			);
			return attachMailboxLifecycle(response, canonicalWorkspace);
		}

		return null;
	});
