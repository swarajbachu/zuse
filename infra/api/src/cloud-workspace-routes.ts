import { cloudCommandEnvelopeEligibility } from "@zuse/cloud-commands";
import {
	ApiPaths,
	CLOUD_COMMAND_PROTOCOL_VERSION,
	CloudAccountImageBuildRequest,
	CloudAuthConfigureRequest,
	CloudAuthLoginStartRequest,
	CloudAuthProvider,
	CloudCommandEnvelope,
	CloudProjectConnectRequest,
	CloudProjectPrepareRequest,
	CloudTranscriptCheckpointUpload,
	CloudTranscriptMessagePageUpload,
	CloudWorkspaceActionRequest,
	CloudWorkspaceCreateRequest,
	CloudWorkspaceResumeRequest,
	CloudWorkspaceRuntimeSummary,
	CloudWorkspaceStartupTimings,
	CodexGrantRequest,
	DEFAULT_RUNTIME_MODE,
	ProviderGrantRequest,
	RuntimeAcknowledgment,
	RuntimeMode,
} from "@zuse/contracts";
import { POKEMON_BRANCH_CATALOG } from "@zuse/pokemon-data/branch-catalog";
import { allocatePokemonName } from "@zuse/pokemon-data/name-allocator";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { sha256Base64Url } from "@zuse/utils/cloud-transcript-crypto";
import { Clock, Effect, Redacted, Schema } from "effect";
import { CompactEncrypt, importJWK, type JWK } from "jose";
import { requireWorkos } from "./auth.ts";
import { type BetaAccess, requireCloudBetaAccess } from "./beta-access.ts";
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
import type { CloudBillingStore } from "./cloud-billing-store.ts";
import { hasUsableCloudWorkspaceEntitlement } from "./cloud-entitlement.ts";
import {
	completeGithubInstallation,
	githubInstallationCredentialForRepository,
	githubInstallationGrants,
	githubInstallCallbackForwardUrl,
	makeGithubInstallUrl,
} from "./cloud-github-app.ts";
import {
	attachCloudMailboxBillingDirective,
	attachCloudMailboxCommandDirective,
	attachCloudMailboxLifecycleDirective,
} from "./cloud-mailbox-directive.ts";
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
	CloudWorkspaceLaunchIntentCipher,
	makeCloudWorkspaceLaunchIntent,
} from "./cloud-workspace-launch-intent.ts";
import { cloudRepositoryWorkspacePath } from "./cloud-workspace-paths.ts";
import {
	MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
	withoutRuntimeBootstrapReceipt,
} from "./cloud-workspace-reconciler.ts";
import {
	type CloudProjectBuildRecord,
	type CloudProjectRecord,
	type CloudWorkspaceLifecycleAction,
	type CloudWorkspaceRecord,
	type CloudWorkspaceRuntimeSummaryRecord,
	CloudWorkspaceStore,
	mailboxLifecycleToDeliver,
	runtimeBootstrapReceiptFromConfig,
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
import {
	type ApiError,
	badRequest,
	conflict,
	forbidden,
	notFound,
	serviceUnavailable,
	unauthorized,
} from "./errors.ts";
import {
	githubCallbackPageHeaders,
	renderGithubConnectedPage,
} from "./github-callback-page.ts";
import { MachineControlConfiguration } from "./machine-config.ts";
import { MachineStore } from "./machine-store.ts";
import { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import type { WorkosVerifier } from "./workos.ts";
import {
	WORKSPACE_GATEWAY_PROTOCOL,
	type WorkspaceGatewayProtocol,
	workspaceGatewayProtocol,
} from "./workspace-gateway-protocol.ts";

export type CloudWorkspaceRouteContext =
	| CloudWorkspaceStore
	| CloudWorkspaceLaunchIntentCipher
	| MachineStore
	| SandboxProviders
	| SandboxOfferConfiguration
	| ApiConfiguration
	| BetaAccess
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
const WORKSPACE_SSH_TICKET_FILE = "/home/zuse/.zuse-ssh-ticket";
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
	readonly success: boolean;
}) =>
	// These values currently originate from fixed copy and GitHub login names,
	// but escaping here keeps this public callback safe if its copy evolves.
	new Response(
		input.success
			? renderGithubConnectedPage(input.message)
			: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><body style="margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;min-height:100vh;place-items:center"><main style="max-width:420px;padding:24px"><h1 style="font-size:18px">${escapeHtml(input.title)}</h1><p style="color:#aaa;line-height:1.5">${escapeHtml(input.message)}</p></main></body></html>`,
		{
			status: input.success ? 200 : 400,
			headers: githubCallbackPageHeaders,
		},
	);
const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const decodeBody = <A, I>(
	schema: Schema.Codec<A, I>,
	request: Request,
): Effect.Effect<A, ApiError> =>
	Effect.tryPromise({
		try: (): Promise<unknown> => request.json(),
		catch: () => badRequest("invalid_json"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError(() => badRequest("invalid_request")),
	);

export const decodeRuntimeSummary = (
	request: Request,
): Effect.Effect<CloudWorkspaceRuntimeSummary, ApiError> =>
	Effect.gen(function* () {
		const body = yield* Effect.tryPromise({
			try: (): Promise<unknown> => request.json(),
			catch: () => badRequest("invalid_json"),
		});
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body) ||
			Object.keys(body).some(
				(key) =>
					!new Set([
						"summaryRevision",
						"title",
						"lastActivityAt",
						"sessionHeadVersion",
					]).has(key),
			)
		)
			return yield* Effect.fail(badRequest("invalid_runtime_summary"));
		const decoded = yield* Schema.decodeUnknownEffect(
			CloudWorkspaceRuntimeSummary,
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
					currentTemplateVersions.get(build.provider) === build.templateVersion,
			)
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
			build.templateVersion === currentTemplateVersion,
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

export const isCloudAccountImageOutdated = (input: {
	readonly imagePromotedAtMs: number;
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
	input.projects.some(
		(project) =>
			project.state !== "ready" ||
			project.updatedAtMs > input.imagePromotedAtMs,
	) ||
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
			candidate.templateVersion === currentTemplateVersion,
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
) {
	const store = yield* CloudWorkspaceStore;
	const apiConfiguration = yield* ApiConfiguration;
	const sandboxProviders = yield* SandboxProviders;
	const provider = sandboxProviders.availableProviders.find(
		(candidate) => candidate.providerId === "e2b",
	);
	const projects = yield* store.listProjects(accountId);
	const builds =
		provider === undefined
			? []
			: [
					...(yield* store.listAccountBuilds(accountId, provider.providerId)),
				].sort((left, right) => right.createdAtMs - left.createdAtMs);
	const latest = builds[0];
	const building = builds.find(
		(candidate) =>
			candidate.state === "queued" ||
			candidate.state === "building" ||
			candidate.state === "sanitizing",
	);
	const active = selectActiveAccountImageBuild(
		builds,
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
	const authBroken = providers.some(
		(status) =>
			active?.settings?.providerAuthDeliveryVersion !== 1 &&
			!(
				active?.settings?.codexAuthDeliveryVersion === 1 &&
				status.providerId === "codex"
			) &&
			status.method !== undefined &&
			(status.state === "expired" || status.state === "error"),
	);
	const outdated =
		active !== undefined &&
		isCloudAccountImageOutdated({
			imagePromotedAtMs: active.updatedAtMs,
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
	const latestFailedAfterActive =
		latest?.state === "failed" &&
		(active === undefined || latest.createdAtMs > active.updatedAtMs);
	const state =
		building !== undefined
			? ("building" as const)
			: latestFailedAfterActive
				? ("failed" as const)
				: active === undefined
					? latest?.state === "failed"
						? ("failed" as const)
						: ("not-built" as const)
					: authBroken
						? ("auth-broken" as const)
						: outdated
							? ("outdated" as const)
							: ("ready" as const);
	const statusBuild = building ?? active ?? latest;
	const repositories = accountImageRepositories(projects);
	return {
		state,
		generation: active?.buildId,
		providerId: provider?.providerId,
		runtimeVersion: active?.templateVersion ?? provider?.templateVersion,
		buildMode: buildMode(statusBuild),
		progressPhase: building?.state,
		errorCode: latestFailedAfterActive ? latest.lastErrorCode : undefined,
		repositories,
		providers,
		builds: builds.slice(0, 12).map((build) => ({
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
			logText: build.logText,
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

const startupPhase = (workspace: CloudWorkspaceRecord) => {
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

export const runtimeUnavailableResumeTarget = (
	workspace: Pick<CloudWorkspaceRecord, "providerSandboxId">,
) =>
	workspace.providerSandboxId === undefined
		? ({ state: "queued", providerSandboxId: undefined } as const)
		: ({
				state: "resuming",
				providerSandboxId: workspace.providerSandboxId,
			} as const);

const publicWorkspace = (workspace: CloudWorkspaceRecord) => ({
	workspaceId: workspace.workspaceId,
	projectId: workspace.projectId,
	buildId: workspace.buildId,
	imageGeneration: workspace.buildId,
	providerId: workspace.provider,
	codexAuthMode:
		workspace.requestConfig.codexAuthMode === "broker-v1"
			? ("broker-v1" as const)
			: ("legacy-image" as const),
	providerAuthMode:
		workspace.requestConfig.providerAuthMode === "broker-v1"
			? ("broker-v1" as const)
			: ("legacy-image" as const),
	branch: workspace.branch,
	baseRef: workspace.baseRef,
	state: workspace.state,
	desiredState: workspace.desiredState,
	statusCode: workspace.statusCode,
	failureDiagnostic:
		typeof workspace.requestConfig.startupFailureDiagnostic === "string"
			? workspace.requestConfig.startupFailureDiagnostic
			: undefined,
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

export const publicCloudWorkspaceSummary = (
	workspace: CloudWorkspaceRecord,
	project: CloudProjectRecord,
	unread: boolean,
	lastMessageAt: number | null,
	runtimeSummary?: CloudWorkspaceRuntimeSummaryRecord | null,
) => ({
	workspaceId: workspace.workspaceId,
	projectId: project.projectId,
	repositoryIdentity: project.repositoryIdentity,
	repositoryDisplayName: project.displayName,
	chatId: workspace.chatId,
	initialSessionId: workspace.initialSessionId,
	title:
		runtimeSummary?.title ??
		(typeof workspace.requestConfig.title === "string"
			? workspace.requestConfig.title
			: workspace.branch),
	branch: workspace.branch,
	providerId: workspace.provider,
	codexAuthMode:
		workspace.requestConfig.codexAuthMode === "broker-v1"
			? ("broker-v1" as const)
			: ("legacy-image" as const),
	providerAuthMode:
		workspace.requestConfig.providerAuthMode === "broker-v1"
			? ("broker-v1" as const)
			: ("legacy-image" as const),
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
	failureDiagnostic:
		typeof workspace.requestConfig.startupFailureDiagnostic === "string"
			? workspace.requestConfig.startupFailureDiagnostic
			: undefined,
	startupPhase: startupPhase(workspace),
	revision: workspace.revision,
	summaryRevision: runtimeSummary?.summaryRevision ?? 0,
	sessionHeadVersion:
		runtimeSummary?.sessionHeadVersion ??
		(typeof workspace.requestConfig.sessionHeadVersion === "number"
			? workspace.requestConfig.sessionHeadVersion
			: 0),
	unread,
	lastMessageAt: runtimeSummary?.lastActivityAtMs ?? lastMessageAt,
	...(workspace.state === "archived" || workspace.desiredState === "archived"
		? {
				archivedAt: workspace.archiveRequestedAtMs ?? workspace.updatedAtMs,
			}
		: {}),
	createdAt: workspace.createdAtMs,
	updatedAt: Math.max(workspace.updatedAtMs, runtimeSummary?.updatedAtMs ?? 0),
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
		if (!available.some((provider) => provider.providerId === requested))
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
	(workspace.state === "resuming" || workspace.statusCode.startsWith("resume-"))
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
});

const runtimeGeneration = (workspace: CloudWorkspaceRecord): number =>
	typeof workspace.requestConfig.runtimeGeneration === "number"
		? workspace.requestConfig.runtimeGeneration
		: 1;

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
	if (request.runtimeGeneration !== runtimeGeneration(workspace))
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
	if (request.runtimeGeneration !== runtimeGeneration(workspace))
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

const gatewayEpoch = (workspace: CloudWorkspaceRecord): number =>
	typeof workspace.requestConfig.gatewayEpoch === "number"
		? workspace.requestConfig.gatewayEpoch
		: runtimeGeneration(workspace);

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

const requireRuntime = Effect.fn("requireCloudWorkspaceRuntime")(function* (
	request: Request,
	workspaceId: string,
	nowMs: number,
) {
	const workspace = yield* authenticateRuntime(request, workspaceId, nowMs);
	if (workspaceDeletionRequested(workspace))
		return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
	return workspace;
});

export const routeCloudWorkspaceRequest = (
	request: Request,
): Effect.Effect<Response | null, ApiError, CloudWorkspaceRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		if (!path.startsWith("/v1/cloud/")) return null;
		if (method === "GET" && path === ApiPaths.cloudGithubCallback) {
			const state = url.searchParams.get("state");
			const installationId = Number(url.searchParams.get("installation_id"));
			if (
				state === null ||
				!Number.isSafeInteger(installationId) ||
				installationId <= 0
			)
				return githubCallbackPage({
					title: "Installation not linked",
					message:
						"The GitHub App was installed, but this installation was not started from Zuse. Return to Cloud Workspace settings and choose Install GitHub App so Zuse can link it securely.",
					success: false,
				});
			const apiConfiguration = yield* ApiConfiguration;
			const forwardUrl = githubInstallCallbackForwardUrl(
				state,
				installationId,
				apiConfiguration.apiIssuer,
			);
			if (forwardUrl !== null)
				return new Response(null, {
					status: 302,
					headers: { location: forwardUrl },
				});
			return yield* completeGithubInstallation(state, installationId).pipe(
				Effect.tapError((error) =>
					Effect.sync(() =>
						console.warn("[cloud-github] installation callback failed", {
							code: error.code,
							installationId,
						}),
					),
				),
				Effect.map((accountLogin) =>
					githubCallbackPage({
						title: "GitHub connected",
						message: accountLogin,
						success: true,
					}),
				),
				Effect.catch(() =>
					Effect.succeed(
						githubCallbackPage({
							title: "GitHub could not be connected",
							message:
								"This install link is invalid or expired. Return to Cloud Workspace settings and start the GitHub App installation again.",
							success: false,
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
		const recordWorkspaceActivity = Effect.fn("recordWorkspaceActivity")(
			function* (workspace: CloudWorkspaceRecord) {
				const updated = yield* store.recordActivity(
					workspace.workspaceId,
					workspace.accountId,
					nowMs,
					nowMs + idlePauseMs,
				);
				if (
					updated?.providerSandboxId !== undefined &&
					updated.state !== "paused"
				) {
					const provider = yield* (yield* SandboxProviders)
						.get(updated.provider)
						.pipe(Effect.orDie);
					yield* provider
						.extendTimeout(
							updated.providerSandboxId,
							Math.ceil(idlePauseMs / 1_000),
						)
						.pipe(Effect.ignore);
				}
				return updated;
			},
		);
		const repairAcknowledgedLaunch = Effect.fn("repairAcknowledgedLaunch")(
			function* (workspace: CloudWorkspaceRecord, sessionHeadVersion = 0) {
				if (workspace.statusCode !== "agent-starting") return workspace;
				const launchIntent = yield* store.getLaunchIntent(
					workspace.workspaceId,
					nowMs,
				);
				if (launchIntent !== null) return workspace;
				const completion = yield* store.completeLaunchIntent({
					workspaceId: workspace.workspaceId,
					commandId: `launch:${workspace.workspaceId}`,
					sessionHeadVersion,
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
			const generation = runtimeGeneration(workspace);
			const epoch = gatewayEpoch(workspace);
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
				codexAuthMode:
					enrolled.workspace.requestConfig.codexAuthMode === "broker-v1"
						? "broker-v1"
						: "legacy-image",
				providerAuthMode:
					enrolled.workspace.requestConfig.providerAuthMode === "broker-v1"
						? "broker-v1"
						: "legacy-image",
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
			const currentCredentialHash = yield* sha256Hex(currentCredential);
			const registeredSigningKey =
				typeof workspace.requestConfig.runtimeSigningPublicJwk === "string"
					? workspace.requestConfig.runtimeSigningPublicJwk
					: null;
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
					generation: runtimeGeneration(workspace),
					gatewayEpoch: gatewayEpoch(workspace),
					nowMs,
				});
			}
			// A deterministic value lets a retry recover the exact credential after
			// response loss without storing plaintext at API.
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
				generation: runtimeGeneration(workspace),
				gatewayEpoch: gatewayEpoch(workspace),
				nowMs,
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
			const credential = yield* githubInstallationCredentialForRepository(
				workspace.accountId,
				project.repositoryIdentity,
			);
			if (credential === null)
				return yield* Effect.fail(forbidden("github_repository_not_granted"));
			return json(credential);
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
				runtimeGeneration: runtimeGeneration(workspace),
				summaryRevision: body.summaryRevision,
				title: body.title,
				lastActivityAtMs: body.lastActivityAt,
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
				const active = yield* recordWorkspaceActivity(workspace);
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
		if (method === "POST" && activityMatch !== null) {
			const workspaceId = decodeURIComponent(activityMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const active = yield* recordWorkspaceActivity(workspace);
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
			const generation = runtimeGeneration(workspace);
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
				checkpoint.runtimeGeneration !== runtimeGeneration(workspace) ||
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
					statusCode: "launch-failed",
					requestConfig: {
						...workspace.requestConfig,
						launchErrorCode: body.errorCode ?? "workspace_launch_failed",
						startupTimings: {
							...timings,
							connectedAt: timings.connectedAt ?? nowMs,
						},
					},
					nextActionAtMs: nowMs + idlePauseMs,
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
			// Delete fences all new delivery, but an exact still-current runtime
			// credential must retain the bounded ability to publish the durable receipt
			// for a lease it already owns. The mailbox validates that original token.
			const workspace =
				action === "ack"
					? yield* authenticateRuntime(request, workspaceId, nowMs)
					: yield* requireRuntime(request, workspaceId, nowMs);
			const currentRuntimeGeneration = runtimeGeneration(workspace);
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
					? yield* cloudBillingCapacity(workspace.accountId, nowMs)
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
				wakeRevision === null
			)
				return json({ leases: [] });
			const payload =
				action === "lease"
					? {
							...(yield* decodeBody(RuntimeCommandLeaseRequest, request)),
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
						expectedGeneration: runtimeGeneration(workspace),
						expectedGatewayEpoch: gatewayEpoch(workspace),
						nowMs,
					}).pipe(
						Effect.as(true),
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
				(workspace.state !== "ready" || workspace.runtimeState !== "online")
			)
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			console.info("[cloud-workspace] gateway upgrade accepted", {
				workspaceId,
				protocol,
				generation: runtimeGeneration(workspace),
				gatewayEpoch: gatewayEpoch(workspace),
				role: runtime ? "runtime" : "client",
			});
			const response = new Response(null, { status: 204 });
			response.headers.set("x-zuse-gateway-workspace", workspaceId);
			response.headers.set(
				"x-zuse-gateway-generation",
				String(runtimeGeneration(workspace)),
			);
			response.headers.set(
				"x-zuse-gateway-epoch",
				String(gatewayEpoch(workspace)),
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
			/^\/v1\/cloud\/workspaces\/([^/]+)\/(pause|resume|restart|archive|unarchive|delete)$/u.exec(
				path,
			);
		const isCleanupAction =
			method === "POST" &&
			(actionMatch?.[2] === "pause" ||
				actionMatch?.[2] === "archive" ||
				actionMatch?.[2] === "delete");
		const principal = yield* requireWorkos(request);
		if (!isCleanupAction) yield* requireCloudBetaAccess(principal.accountId);

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
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
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
					workspaceSupportsCloudCommandMailbox(workspace),
			});
		}
		if (
			commandCollectionMatch !== null ||
			commandItemMatch !== null ||
			commandWatchMatch !== null
		) {
			const workspace = yield* store.getWorkspace(mailboxWorkspaceId);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (method === "POST" && commandCollectionMatch !== null) {
				if (
					workspaceDeletionRequested(workspace) ||
					workspace.state === "archived" ||
					workspace.state === "archiving" ||
					workspace.desiredState === "archived"
				)
					return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
				if (!workspaceSupportsCloudCommandMailbox(workspace))
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
				const response = json(envelope, 202);
				return attachCloudMailboxCommandDirective(response, {
					action: "enqueue",
					workspaceId: mailboxWorkspaceId,
					accountId: principal.accountId,
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
					yield* cloudBillingCapacity(workspace.accountId, nowMs),
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
							yield* cloudBillingCapacity(workspace.accountId, nowMs),
							workspace.accountId,
						)
					: attachMailboxLifecycle(response, workspace);
			}
		}
		if (method === "GET" && path === "/v1/cloud/github") {
			const installations = yield* store.listGithubInstallations(
				principal.accountId,
			);
			const grants = yield* githubInstallationGrants(principal.accountId).pipe(
				Effect.orElseSucceed(() => []),
			);
			return json({
				configured: apiConfiguration.githubApp !== undefined,
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
			return json({ url: yield* makeGithubInstallUrl(principal.accountId) });
		}
		const githubDisconnectMatch =
			/^\/v1\/cloud\/github\/installations\/(\d+)$/u.exec(path);
		if (method === "DELETE" && githubDisconnectMatch !== null) {
			const installationId = Number(githubDisconnectMatch[1]);
			if (!Number.isSafeInteger(installationId))
				return yield* Effect.fail(badRequest("invalid_github_installation"));
			yield* store.removeGithubInstallation(
				principal.accountId,
				installationId,
			);
			return json({ ok: true });
		}
		const requireBillingCapacity = Effect.fn("requireCloudBillingCapacity")(
			function* () {
				const capacity = yield* cloudBillingCapacity(
					principal.accountId,
					nowMs,
				);
				if (capacity === "period-missing")
					return yield* Effect.fail(forbidden("cloud_billing_period_missing"));
				if (capacity === "billing-hold")
					return yield* Effect.fail(forbidden("cloud_billing_hold"));
			},
		);

		if (method === "GET" && path === ApiPaths.cloudAuth) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			return json(yield* cloudAuthStatus(principal.accountId));
		}
		if (method === "POST" && path === ApiPaths.cloudAuthProvision) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			return json(yield* provisionCloudAuth(principal.accountId));
		}
		if (method === "POST" && path === ApiPaths.cloudAuthConfigure) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const body = yield* decodeBody(CloudAuthConfigureRequest, request);
			return json(yield* configureCloudAuth(principal.accountId, body));
		}
		if (method === "POST" && path === ApiPaths.cloudAuthLoginStart) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			const body = yield* decodeBody(CloudAuthLoginStartRequest, request);
			return json(
				yield* startCloudAuthLogin(principal.accountId, body.providerId),
			);
		}
		const cloudAuthLoginMatch = /^\/v1\/cloud\/auth\/login\/([^/]+)$/u.exec(
			path,
		);
		if (method === "GET" && cloudAuthLoginMatch !== null) {
			return json(
				yield* pollCloudAuthLogin(
					principal.accountId,
					decodeURIComponent(cloudAuthLoginMatch[1] ?? ""),
				),
			);
		}
		const cloudAuthCancelMatch =
			/^\/v1\/cloud\/auth\/login\/([^/]+)\/cancel$/u.exec(path);
		if (method === "POST" && cloudAuthCancelMatch !== null) {
			return json(
				yield* cancelCloudAuthLogin(
					principal.accountId,
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
			return json(yield* disconnectCloudAuth(principal.accountId, providerId));
		}

		const transcriptMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/sessions\/([^/]+)\/transcript-checkpoint$/u.exec(
				path,
			);
		if (method === "GET" && transcriptMatch !== null) {
			const workspaceId = decodeURIComponent(transcriptMatch[1] ?? "");
			const sessionId = decodeURIComponent(transcriptMatch[2] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (
				workspace === null ||
				workspace.accountId !== principal.accountId ||
				workspace.state === "deleted"
			)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const checkpoint = yield* store.getTranscriptCheckpoint(
				workspaceId,
				sessionId,
			);
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
				workspace.accountId !== principal.accountId ||
				workspace.state === "deleted"
			)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
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

		if (method === "GET" && path === ApiPaths.cloudProviders) {
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
			});
		}

		if (method === "GET" && path === ApiPaths.cloudAccountImage)
			return json(yield* cloudAccountImage(principal.accountId));

		if (method === "POST" && path === ApiPaths.cloudAccountImageBuild) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			yield* requireBillingCapacity();
			const body = yield* decodeBody(CloudAccountImageBuildRequest, request);
			const projects = yield* store.listProjects(principal.accountId);
			if (projects.length === 0)
				return yield* Effect.fail(conflict("cloud_image_has_no_repositories"));
			const provider = yield* selectedProvider("e2b");
			const builds = yield* store.listAccountBuilds(
				principal.accountId,
				provider.providerId,
			);
			const activeBuild = yield* store.getActiveAccountBuild(
				principal.accountId,
				provider.providerId,
			);
			const auth = yield* cloudAuthStatus(principal.accountId);
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
				return json(yield* cloudAccountImage(principal.accountId), 202);
			const configurationDigest = yield* sha256Hex(
				JSON.stringify({
					mode: effectiveMode,
					templateVersion: provider.templateVersion,
					codexAuthDeliveryVersion:
						apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled ? 1 : 0,
					providerAuthDeliveryVersion:
						apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled ? 1 : 0,
					repositories: projects
						.map((project) => ({
							projectId: project.projectId,
							configurationDigest: project.configurationDigest,
						}))
						.sort((left, right) =>
							left.projectId.localeCompare(right.projectId),
						),
				}),
			);
			const anchor = projects[0] as CloudProjectRecord;
			const build: CloudProjectBuildRecord = {
				buildId: yield* randomToken("image", 12),
				projectId: anchor.projectId,
				accountId: principal.accountId,
				provider: provider.providerId,
				templateVersion: provider.templateVersion,
				configurationDigest,
				settings: {
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
			for (const project of projects)
				yield* store.saveProject({
					...project,
					state: "preparing",
					updatedAtMs: nowMs,
				});
			const response = json(yield* cloudAccountImage(principal.accountId), 202);
			response.headers.set("x-zuse-reconcile-cloud-build", created.buildId);
			return response;
		}

		if (method === "GET" && path === ApiPaths.cloudProjects) {
			const projects = yield* store.listProjects(principal.accountId);
			const providers = yield* SandboxProviders;
			const currentTemplateVersions = new Map(
				providers.availableProviders.map((provider) => [
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
								publicProject(project, builds, currentTemplateVersions),
							),
						),
				),
			});
		}

		if (method === "GET" && path === ApiPaths.cloudChats) {
			const projectId = url.searchParams.get("projectId") ?? undefined;
			const scope = url.searchParams.get("scope") ?? "active";
			const workspaces = yield* store.listWorkspaces(
				principal.accountId,
				projectId,
			);
			const chats = yield* Effect.forEach(
				workspaces.filter((workspace) => {
					if (workspace.state === "deleted") return false;
					if (scope === "all") return true;
					const archived =
						workspace.state === "archived" ||
						workspace.desiredState === "archived";
					return scope === "archived" ? archived : !archived;
				}),
				(workspace) =>
					Effect.gen(function* () {
						const [project, runtimeSummary] = yield* Effect.all([
							store.getProject(workspace.projectId),
							store.getRuntimeSummary(workspace.workspaceId),
						]);
						const repaired = yield* repairAcknowledgedLaunch(
							workspace,
							runtimeSummary?.sessionHeadVersion ?? 0,
						);
						return project === null
							? null
							: publicCloudWorkspaceSummary(
									repaired,
									project,
									false,
									repaired.lastActivityAtMs,
									runtimeSummary,
								);
					}),
			);
			return json({
				chats: chats
					.filter((chat) => chat !== null)
					.sort(
						(left, right) =>
							(right.lastMessageAt ?? right.createdAt) -
							(left.lastMessageAt ?? left.createdAt),
					),
			});
		}

		if (method === "POST" && path === ApiPaths.cloudProjects) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			yield* requireBillingCapacity();
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
				accountId: principal.accountId,
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
			const providers = yield* SandboxProviders;
			const currentTemplateVersions = new Map(
				providers.availableProviders.map((provider) => [
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
			if (project === null || project.accountId !== principal.accountId)
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
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			yield* requireBillingCapacity();
			const projectId = decodeURIComponent(prepareMatch[1] ?? "");
			const body = yield* decodeBody(CloudProjectPrepareRequest, request);
			if (body.projectId !== projectId)
				return yield* Effect.fail(badRequest("project_mismatch"));
			const project = yield* store.getProject(projectId);
			if (project === null || project.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
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

		if (method === "GET" && path === ApiPaths.cloudWorkspaces) {
			const workspaces = yield* store.listWorkspaces(
				principal.accountId,
				url.searchParams.get("projectId") ?? undefined,
			);
			return json({
				workspaces: yield* Effect.forEach(workspaces, (workspace) =>
					repairAcknowledgedLaunch(workspace).pipe(Effect.map(publicWorkspace)),
				),
			});
		}

		const workspaceMatch = /^\/v1\/cloud\/workspaces\/([^/]+)$/u.exec(path);
		if (method === "GET" && workspaceMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(workspaceMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			return json(publicWorkspace(yield* repairAcknowledgedLaunch(workspace)));
		}

		const connectionTicketMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/gateway\/ticket$/u.exec(path);
		if (method === "POST" && connectionTicketMatch !== null) {
			const workspaceId = decodeURIComponent(connectionTicketMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (workspace.state === "failed" || workspace.state === "deleted")
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			yield* recordWorkspaceActivity(workspace);
			const api = yield* ApiConfiguration;
			const expiresAt = nowMs + WORKSPACE_CLIENT_TICKET_TTL_MS;
			const credential = yield* signWorkspaceClientTicket({
				mintPrivateJwk: yield* parseJwk(Redacted.value(api.mintPrivateKey)),
				issuer: api.apiIssuer,
				accountId: principal.accountId,
				deviceId:
					request.headers.get("x-zuse-device-id") ?? principal.accountId,
				workspaceId,
				protocol: WORKSPACE_GATEWAY_PROTOCOL,
				generation: runtimeGeneration(workspace),
				gatewayEpoch: gatewayEpoch(workspace),
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
				protocol: WORKSPACE_GATEWAY_PROTOCOL,
				role: "client",
				generation: runtimeGeneration(workspace),
				gatewayEpoch: gatewayEpoch(workspace),
				credential,
				expiresAt,
			});
			if (workspace.state === "paused")
				response.headers.set("x-zuse-reconcile-cloud-workspace", workspaceId);
			return response;
		}

		const sshAccessMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/ssh-access$/u.exec(path);
		if (method === "POST" && sshAccessMatch !== null) {
			const workspaceId = decodeURIComponent(sshAccessMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (
				workspace.state !== "ready" ||
				workspace.providerSandboxId === undefined
			)
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			const project = yield* store.getProject(workspace.projectId);
			if (project === null)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const provider = yield* (yield* SandboxProviders)
				.get(workspace.provider)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_provider_unavailable"),
					),
				);
			const ticket = yield* randomToken("workspace_ssh", 32);
			const ticketExpiresAtMs = nowMs + WORKSPACE_SSH_TICKET_TTL_MS;
			yield* provider
				.writeTextFile(
					workspace.providerSandboxId,
					WORKSPACE_SSH_TICKET_FILE,
					JSON.stringify({
						tokenHash: yield* sha256Hex(ticket),
						expiresAtMs: ticketExpiresAtMs,
					}),
					"zuse",
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
				user: "zuse",
				workspacePath: cloudRepositoryWorkspacePath(project.repositoryIdentity),
			});
		}

		const previewUrlMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/preview-url$/u.exec(path);
		if (method === "POST" && previewUrlMatch !== null) {
			const workspaceId = decodeURIComponent(previewUrlMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (
				workspace.state !== "ready" ||
				workspace.providerSandboxId === undefined
			)
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			const body = yield* decodeBody(
				Schema.Struct({ port: Schema.Number }),
				request,
			);
			const offer = yield* SandboxOfferConfiguration;
			if (
				!Number.isInteger(body.port) ||
				body.port <= 0 ||
				body.port > 65_535 ||
				body.port === offer.port
			)
				return yield* Effect.fail(badRequest("invalid_preview_port"));
			// The returned host is public-by-URL: anyone holding it reaches the
			// port with no further auth. The high-entropy sandbox id is the trust
			// model (like sharing a tunnel link); revocation is pause/restart.
			const provider = yield* (yield* SandboxProviders)
				.get(workspace.provider)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_provider_unavailable"),
					),
				);
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

		if (method === "POST" && path === ApiPaths.cloudWorkspaces) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			yield* requireBillingCapacity();
			const body = yield* decodeBody(CloudWorkspaceCreateRequest, request);
			const project = yield* store.getProject(body.projectId);
			if (project === null || project.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const provider = yield* selectedProvider(body.providerId);
			const accountBuild = yield* store.getActiveAccountBuild(
				principal.accountId,
				provider.providerId,
			);
			if (
				project.state !== "ready" ||
				accountBuild?.snapshotId === undefined ||
				accountBuild.templateVersion !== provider.templateVersion
			)
				return yield* Effect.fail(conflict("cloud_project_not_ready"));
			const build = accountBuild;
			if (
				apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled &&
				build.settings?.codexAuthDeliveryVersion !== 1
			)
				return yield* Effect.fail(conflict("codex-auth-update-required"));
			if (
				apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled &&
				build.settings?.providerAuthDeliveryVersion !== 1
			)
				return yield* Effect.fail(conflict("provider-auth-update-required"));
			const codexAuthMode = codexAuthModeForAccountBuild(
				build,
				apiConfiguration.cloudCodexAuthBrokerEnrollmentEnabled,
			);
			const providerAuthMode = providerAuthModeForAccountBuild(
				build,
				apiConfiguration.cloudProviderAuthBrokerEnrollmentEnabled,
			);
			const workspaceId = yield* randomToken("workspace", 12);
			const chatId = `chat_${crypto.randomUUID()}`;
			const initialSessionId = `s_${crypto.randomUUID()}`;
			const unavailableBranches = new Set(
				(yield* store.listWorkspaces(
					principal.accountId,
					project.projectId,
				)).map((workspace) => workspace.branch),
			);
			const branch =
				body.branch ??
				allocatePokemonName({
					catalog: POKEMON_BRANCH_CATALOG,
					unavailableNames: unavailableBranches,
					usedPokemonNumbers: new Set(),
				})?.name ??
				workspaceId.slice(-8);
			if (
				!/^[A-Za-z0-9._/-]+$/u.test(branch) ||
				!/^[A-Za-z0-9._/#-]+$/u.test(body.baseRef)
			)
				return yield* Effect.fail(badRequest("invalid_git_ref"));
			const launchIntent = makeCloudWorkspaceLaunchIntent({
				workspaceId,
				branch,
				agent: body.agent,
				model: body.model,
				runtimeMode: body.runtimeMode ?? DEFAULT_RUNTIME_MODE,
				permissions: body.permissions ?? [],
				request: body,
			});
			const { commandId, turnId, title } = launchIntent;
			const transcriptKey = yield* createCloudTranscriptKey(
				principal.accountId,
				workspaceId,
			).pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_transcript_key_unavailable"),
				),
			);
			const workspace: CloudWorkspaceRecord = {
				workspaceId,
				accountId: principal.accountId,
				projectId: project.projectId,
				buildId: build.buildId,
				provider: provider.providerId,
				runtimeState: "offline",
				chatId,
				initialSessionId,
				branch,
				baseRef: body.baseRef,
				state: "queued",
				desiredState: "ready",
				statusCode: "provisioning-queued",
				wrappedTranscriptKey: transcriptKey.envelope,
				idempotencyKey: body.idempotencyKey,
				requestConfig: {
					title,
					agent: body.agent,
					codexAuthMode,
					providerAuthMode,
					authGrantRequired: false,
					model: body.model,
					runtimeMode: body.runtimeMode ?? DEFAULT_RUNTIME_MODE,
					permissions: body.permissions ?? [],
					repositoryCache: "account-image",
					startupTimings: { requestedAt: nowMs },
				},
				nextActionAtMs: nowMs,
				revision: 0,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				lastActivityAtMs: nowMs,
			};
			const launchIntentRecord = {
				workspaceId,
				accountId: principal.accountId,
				chatId,
				sessionId: initialSessionId,
				turnId,
				commandId,
				ciphertext: yield* launchIntentCipher
					.encrypt(principal.accountId, workspaceId, launchIntent)
					.pipe(
						Effect.mapError(() =>
							serviceUnavailable("cloud_workspace_launch_intent_unavailable"),
						),
					),
				expiresAtMs: nowMs + 24 * 60 * 60 * 1_000,
				createdAtMs: nowMs,
			};
			const outcome = yield* store.createWorkspace(
				workspace,
				launchIntentRecord,
			);
			if (outcome.kind === "branch-in-use")
				return yield* Effect.fail(
					conflict(`cloud_branch_in_use:${outcome.workspace.workspaceId}`),
				);
			let launchedWorkspace = outcome.workspace;
			if (outcome.kind === "created") {
				const pooled = yield* store.claimPool(
					principal.accountId,
					provider.providerId,
					build.buildId,
					workspaceId,
					nowMs,
				);
				if (pooled !== null) {
					launchedWorkspace = {
						...outcome.workspace,
						providerSandboxId: pooled.providerSandboxId,
						requestConfig: {
							...outcome.workspace.requestConfig,
							poolClaimedAt: nowMs,
							startupTimings: {
								...startupTimings(outcome.workspace),
								poolClaimedAt: nowMs,
							},
						},
						revision: outcome.workspace.revision + 1,
						updatedAtMs: nowMs + 1,
					};
					yield* store.saveWorkspace(launchedWorkspace);
				}
			}
			const response = json(
				{
					workspace: publicWorkspace(launchedWorkspace),
					chatId: launchedWorkspace.chatId,
					initialSessionId: launchedWorkspace.initialSessionId,
				},
				outcome.kind === "created" ? 201 : 200,
			);
			if (outcome.kind === "created")
				response.headers.set(
					"x-zuse-reconcile-cloud-pool",
					principal.accountId,
				);
			if (outcome.kind === "created")
				response.headers.set(
					"x-zuse-reconcile-cloud-workspace",
					outcome.workspace.workspaceId,
				);
			return response;
		}

		if (method === "POST" && actionMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(actionMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const action = actionMatch[2] as CloudWorkspaceLifecycleAction;
			if (action === "resume") yield* requireBillingCapacity();
			const actionRequest =
				action === "resume"
					? yield* decodeBody(CloudWorkspaceResumeRequest, request)
					: yield* decodeBody(CloudWorkspaceActionRequest, request);
			const recoverRuntime =
				action === "resume" &&
				"recoverRuntime" in actionRequest &&
				actionRequest.recoverRuntime === true;
			let runtimeRecoveryBuild: CloudProjectBuildRecord | null = null;
			if (recoverRuntime && workspace.providerSandboxId === undefined) {
				const provider = yield* selectedProvider(workspace.provider);
				runtimeRecoveryBuild = yield* store.getActiveAccountBuild(
					principal.accountId,
					provider.providerId,
				);
				if (
					runtimeRecoveryBuild?.snapshotId === undefined ||
					runtimeRecoveryBuild.templateVersion !== provider.templateVersion
				)
					return yield* Effect.fail(conflict("cloud_image_rebuild_required"));
			}
			let failedRetryBuild: CloudProjectBuildRecord | null = null;
			if (
				action === "resume" &&
				!recoverRuntime &&
				workspace.state === "failed"
			) {
				const provider = yield* selectedProvider(workspace.provider);
				failedRetryBuild = yield* store.getActiveAccountBuild(
					principal.accountId,
					provider.providerId,
				);
				if (
					failedRetryBuild?.snapshotId === undefined ||
					failedRetryBuild.templateVersion !== provider.templateVersion
				)
					return yield* Effect.fail(conflict("cloud_image_rebuild_required"));
			}
			const commandId =
				"commandId" in actionRequest && actionRequest.commandId !== undefined
					? actionRequest.commandId
					: `${action}:${workspace.workspaceId}:${nowMs}`;
			const desiredState =
				action === "resume" || action === "restart"
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
				...(runtimeRecoveryBuild === null
					? {}
					: { buildId: runtimeRecoveryBuild.buildId }),
				...(failedRetryBuild === null
					? {}
					: { buildId: failedRetryBuild.buildId }),
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
							...runtimeUnavailableResumeTarget(workspace),
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
				...(action === "resume" &&
				!recoverRuntime &&
				workspace.state !== "failed"
					? {
							requestConfig: {
								...workspace.requestConfig,
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
			};
			const received: CloudWorkspaceRecord = {
				...updated,
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
