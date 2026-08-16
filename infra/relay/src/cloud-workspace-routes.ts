import {
	CloudCredentialConnectRequest,
	CloudCredentialKind,
	CloudProjectConnectRequest,
	CloudProjectPrepareRequest,
	CloudTranscriptCheckpointUpload,
	CloudTranscriptMessagePageUpload,
	CloudWorkspaceActionRequest,
	CloudWorkspaceCreateRequest,
	CloudWorkspaceResumeRequest,
	CloudWorkspaceRuntimeSummary,
	CloudWorkspaceStartupTimings,
	RelayPaths,
} from "@zuse/contracts";
import { POKEMON_BRANCH_CATALOG } from "@zuse/pokemon-data/branch-catalog";
import { allocatePokemonName } from "@zuse/pokemon-data/name-allocator";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { sha256Base64Url } from "@zuse/utils/cloud-transcript-crypto";
import { Clock, Effect, Redacted, Schema } from "effect";
import { CompactEncrypt, importJWK, type JWK } from "jose";
import { requireWorkos } from "./auth.ts";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { CloudCredentialVault } from "./cloud-credential-vault.ts";
import { hasUsableCloudWorkspaceEntitlement } from "./cloud-entitlement.ts";
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
import {
	type CloudProjectBuildRecord,
	type CloudProjectRecord,
	type CloudWorkspaceRecord,
	type CloudWorkspaceRuntimeSummaryRecord,
	CloudWorkspaceStore,
	runtimeBootstrapReceiptFromConfig,
} from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	runtimeCredentialKeyThumbprint,
	runtimeSigningKeyThumbprint,
	sha256Hex,
	signWorkspaceClientTicket,
	verifyRuntimeRenewalProof,
	verifyWorkspaceClientTicket,
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
import { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import type { WorkosVerifier } from "./workos.ts";
import { WORKSPACE_GATEWAY_PROTOCOL } from "./workspace-gateway-protocol.ts";

export type CloudWorkspaceRouteContext =
	| CloudWorkspaceStore
	| CloudWorkspaceLaunchIntentCipher
	| CloudCredentialVault
	| MachineStore
	| SandboxProviders
	| SandboxOfferConfiguration
	| RelayConfiguration
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
const LEGACY_WORKSPACE_SSH_BOOTSTRAP = `set -eu
export DEBIAN_FRONTEND=noninteractive
if [ ! -x /usr/sbin/sshd ]; then
  apt-get update >/dev/null
  apt-get install -y --no-install-recommends openssh-server >/dev/null
fi
install -d -o zuse -g zuse -m 700 /home/zuse/.ssh
cat >/home/zuse/.ssh/sshd_config <<'ZUSE_SSHD_CONFIG'
HostKey /home/zuse/.ssh/host_ed25519_key
AuthorizedKeysFile /home/zuse/.ssh/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers zuse
UsePAM no
StrictModes no
PidFile none
Subsystem sftp internal-sftp
ZUSE_SSHD_CONFIG
chown zuse:zuse /home/zuse/.ssh/sshd_config
chmod 600 /home/zuse/.ssh/sshd_config
if [ ! -f /home/zuse/.ssh/host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /home/zuse/.ssh/host_ed25519_key
  chown zuse:zuse /home/zuse/.ssh/host_ed25519_key*
fi
install -d -m 755 /run/sshd`;

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

export const decodeRuntimeSummary = (
	request: Request,
): Effect.Effect<CloudWorkspaceRuntimeSummary, RelayError> =>
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

const gatewayCredential = (request: Request): string | undefined => {
	const values = request.headers
		.get("sec-websocket-protocol")
		?.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return values?.[0] === WORKSPACE_GATEWAY_PROTOCOL ? values[1] : undefined;
};

const gatewayUrl = (relayIssuer: string, workspaceId: string): string => {
	const url = new URL(
		RelayPaths.cloudWorkspaceGateway(workspaceId),
		relayIssuer,
	);
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
) =>
	workspace.providerSandboxId === undefined ||
	workspace.statusCode === "provider-sandbox-missing" ||
	/^(?:initializing|updating-runtime|starting-runtime|syncing-repository|setup)-failed$/u.test(
		workspace.statusCode,
	)
		? ({ state: "queued", providerSandboxId: undefined } as const)
		: ({
				state: "resuming",
				providerSandboxId: workspace.providerSandboxId,
			} as const);

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
	providerId: workspace.provider,
	branch: workspace.branch,
	baseRef: workspace.baseRef,
	state: workspace.state,
	desiredState: workspace.desiredState,
	statusCode: workspace.statusCode,
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
	agent:
		typeof workspace.requestConfig.agent === "string"
			? workspace.requestConfig.agent
			: "codex",
	model:
		typeof workspace.requestConfig.model === "string"
			? workspace.requestConfig.model
			: "",
	state: workspace.state,
	desiredState: workspace.desiredState,
	runtimeState: workspace.runtimeState,
	statusCode: workspace.statusCode,
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

const requestedCredentials = (
	workspace: CloudWorkspaceRecord,
): ReadonlyArray<"github" | "claude" | "codex"> =>
	Array.isArray(workspace.requestConfig.credentialKinds)
		? workspace.requestConfig.credentialKinds.flatMap((kind) => {
				const decoded = Schema.decodeUnknownOption(CloudCredentialKind)(kind);
				return decoded._tag === "Some" ? [decoded.value] : [];
			})
		: [];

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

const deliverCredentials = Effect.fn("deliverCloudWorkspaceCredentials")(
	function* (workspace: CloudWorkspaceRecord, credentialPublicJwk: string) {
		const store = yield* CloudWorkspaceStore;
		const vault = yield* CloudCredentialVault;
		return yield* Effect.forEach(requestedCredentials(workspace), (kind) =>
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
				const sealedSecret = yield* sealRuntimeSecret(
					credentialPublicJwk,
					payload.secret,
				);
				return {
					kind,
					credentialType: payload.credentialType,
					sealedSecret,
					version: connection.credentialVersion,
				};
			}),
		);
	},
);

const RuntimeReadyRequest = Schema.Struct({
	phase: Schema.Literals([
		"repository-ready",
		"agent-started",
		"launch-failed",
	]),
	launchCommandId: Schema.optional(Schema.String),
	sessionHeadVersion: Schema.optional(Schema.Number),
	errorCode: Schema.optional(Schema.String),
});

export const runtimeReadyStatusCode = (
	phase: "repository-ready" | "agent-started",
	commandState: unknown,
): "agent-starting" | "agent-running" =>
	phase === "agent-started" ||
	commandState === "acknowledged" ||
	typeof commandState === "number"
		? "agent-running"
		: "agent-starting";

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

const runtimeGeneration = (workspace: CloudWorkspaceRecord): number =>
	typeof workspace.requestConfig.runtimeGeneration === "number"
		? workspace.requestConfig.runtimeGeneration
		: Math.max(1, workspace.credentialEpoch + 1);

const gatewayEpoch = (workspace: CloudWorkspaceRecord): number =>
	typeof workspace.requestConfig.gatewayEpoch === "number"
		? workspace.requestConfig.gatewayEpoch
		: runtimeGeneration(workspace);

const requireRuntime = Effect.fn("requireCloudWorkspaceRuntime")(function* (
	request: Request,
	workspaceId: string,
	nowMs: number,
) {
	const store = yield* CloudWorkspaceStore;
	const workspace = yield* store.getWorkspace(workspaceId);
	const token = bearer(request);
	if (
		workspace === null ||
		token === undefined ||
		workspace.runtimeCredentialHash !== (yield* sha256Hex(token)) ||
		typeof workspace.requestConfig.runtimeCredentialExpiresAtMs !== "number" ||
		workspace.requestConfig.runtimeCredentialExpiresAtMs <= nowMs ||
		workspace.state === "deleted"
	)
		return yield* Effect.fail(unauthorized("workspace_runtime_rejected"));
	return workspace;
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
		const launchIntentCipher = yield* CloudWorkspaceLaunchIntentCipher;
		const relayConfiguration = yield* RelayConfiguration;
		const idlePauseMs = relayConfiguration.cloudWorkspaceIdleTimeoutMs;
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
			const credentials =
				prior === null
					? yield* deliverCredentials(workspace, body.credentialPublicJwk)
					: prior.cloudCredentials;
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
				cloudCredentials: credentials,
				sealedTranscriptKey,
				nowMs,
			});
			if (enrolled === null)
				return yield* Effect.fail(unauthorized("workspace_bootstrap_rejected"));
			const launchIntentRecord = yield* store.getLaunchIntent(
				workspaceId,
				nowMs,
			);
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
			const provider = yield* (yield* SandboxProviders)
				.get(enrolled.workspace.provider)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_provider_unavailable"),
					),
				);
			yield* provider
				.setNetwork(workspace.providerSandboxId, { kind: "open" })
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("workspace_network_release_failed"),
					),
				);
			const sshBridgeReady = yield* provider
				.pathExists(
					workspace.providerSandboxId,
					"/home/zuse/.ssh/sshd_config",
					"zuse",
				)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_workspace_ssh_unavailable"),
					),
				);
			if (!sshBridgeReady) {
				yield* provider
					.startProcess(workspace.providerSandboxId, {
						command: "/bin/bash",
						args: ["-lc", LEGACY_WORKSPACE_SSH_BOOTSTRAP],
						tag: "zuse-legacy-ssh-bootstrap",
						user: "root",
					})
					.pipe(
						Effect.mapError(() =>
							serviceUnavailable("cloud_workspace_ssh_unavailable"),
						),
					);
			}
			const relay = yield* RelayConfiguration;
			return json({
				workspaceId,
				runtimeCredential,
				gatewayUrl: gatewayUrl(relay.relayIssuer, workspaceId),
				gatewayProtocol: WORKSPACE_GATEWAY_PROTOCOL,
				chatId: workspace.chatId,
				initialSessionId: workspace.initialSessionId,
				runtimeGeneration: enrolled.receipt.generation,
				gatewayEpoch: enrolled.receipt.gatewayEpoch,
				runtimeCredentialExpiresAt:
					enrolled.receipt.runtimeCredentialExpiresAtMs,
				...(launchIntent === undefined ? {} : { launchIntent }),
				cloudCredentials: enrolled.receipt.cloudCredentials,
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
					relayIssuer: (yield* RelayConfiguration).relayIssuer,
					workspaceId,
					requestId: body.requestId,
					generation: runtimeGeneration(workspace),
					gatewayEpoch: gatewayEpoch(workspace),
					nowMs,
				});
			}
			// A deterministic value lets a retry recover the exact credential after
			// response loss without storing plaintext at Relay.
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
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const body = yield* decodeBody(RuntimeReadyRequest, request);
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
			const agentStarted = body.phase === "agent-started";
			if (agentStarted) {
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
			const updated: CloudWorkspaceRecord = {
				...workspace,
				runtimeState: "online",
				state: "ready",
				statusCode: runtimeReadyStatusCode(
					body.phase,
					workspace.requestConfig.sessionHeadVersion,
				),
				requestConfig: {
					...workspace.requestConfig,
					runtimeProcessManaged: true,
					...(agentStarted
						? { sessionHeadVersion: body.sessionHeadVersion }
						: {}),
					startupTimings: {
						...timings,
						connectedAt: timings.connectedAt ?? nowMs,
						repositoryReadyAt: timings.repositoryReadyAt ?? nowMs,
						...(agentStarted
							? {
									agentStartedAt: nowMs,
									launchDurationMs:
										timings.requestedAt === undefined
											? undefined
											: nowMs - timings.requestedAt,
								}
							: {}),
					},
				},
				nextActionAtMs: nowMs + idlePauseMs,
				runningSinceMs: workspace.runningSinceMs ?? nowMs,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
				lastActivityAtMs: nowMs,
			};
			yield* store.saveWorkspace(updated);
			return json(publicWorkspace(updated));
		}

		const gatewayMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/gateway$/u.exec(
			path,
		);
		if (method === "GET" && gatewayMatch !== null) {
			if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
				return yield* Effect.fail(badRequest("websocket_upgrade_required"));
			const workspaceId = decodeURIComponent(gatewayMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			const credential = gatewayCredential(request);
			if (workspace === null || credential === undefined)
				return yield* Effect.fail(unauthorized("workspace_gateway_rejected"));
			const credentialHash = yield* sha256Hex(credential);
			const runtime =
				workspace.runtimeCredentialHash === credentialHash &&
				typeof workspace.requestConfig.runtimeCredentialExpiresAtMs ===
					"number" &&
				workspace.requestConfig.runtimeCredentialExpiresAtMs > nowMs;
			const relay = yield* RelayConfiguration;
			const mintPublicJwk = yield* parseJwk(relay.mintPublicKey);
			const client = runtime
				? false
				: yield* verifyWorkspaceClientTicket({
						token: credential,
						mintPublicJwk,
						issuer: relay.relayIssuer,
						expectedAccountId: workspace.accountId,
						expectedWorkspaceId: workspaceId,
						expectedProtocol: WORKSPACE_GATEWAY_PROTOCOL,
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
			if (!runtime && !client)
				return yield* Effect.fail(unauthorized("workspace_gateway_rejected"));
			if (
				client &&
				(workspace.state !== "ready" || workspace.runtimeState !== "online")
			)
				return yield* Effect.fail(conflict("cloud_workspace_unavailable"));
			console.info("[cloud-workspace] gateway upgrade accepted", {
				workspaceId,
				protocol: WORKSPACE_GATEWAY_PROTOCOL,
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
			if (client)
				response.headers.set(
					"x-zuse-gateway-connection",
					yield* randomToken("connection", 12),
				);
			return response;
		}

		const principal = yield* requireWorkos(request);
		const requireBillingCapacity = Effect.fn("requireCloudBillingCapacity")(
			function* () {
				if (!(yield* RelayConfiguration).cloudBillingEnforcementEnabled) return;
				const billingStore = yield* CloudBillingStore;
				const period = yield* ensureAccountCloudBillingPeriod(
					principal.accountId,
					nowMs,
				).pipe(Effect.provideService(CloudBillingStore, billingStore));
				if (period === null)
					return yield* Effect.fail(forbidden("cloud_billing_period_missing"));
				const summary = yield* billingStore.summary(period);
				if (summary.status === "billing-hold" || summary.status === "ended")
					return yield* Effect.fail(forbidden("cloud_billing_hold"));
			},
		);

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
			});
		}

		if (method === "GET" && path === RelayPaths.cloudProjects) {
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

		if (method === "GET" && path === RelayPaths.cloudChats) {
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

		if (method === "POST" && path === RelayPaths.cloudProjects) {
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
			const machineConfig = yield* MachineControlConfiguration;
			const available = providers.availableProviders.filter(
				(provider) =>
					machineConfig.availableSandboxProviderIds?.has(provider.providerId) ??
					true,
			);
			const builds = yield* Effect.forEach(available, (provider) =>
				Effect.gen(function* () {
					const build: CloudProjectBuildRecord = {
						buildId: yield* randomToken("build", 12),
						projectId: connected.projectId,
						accountId: connected.accountId,
						provider: provider.providerId,
						templateVersion: provider.templateVersion,
						configurationDigest: connected.configurationDigest,
						state: "queued",
						idempotencyKey: `automatic:${body.idempotencyKey}:${provider.templateVersion}`,
						nextActionAtMs: nowMs,
						revision: 0,
						createdAtMs: nowMs,
						updatedAtMs: nowMs,
					};
					return yield* store.createBuild(build);
				}),
			);
			if (builds.length > 0)
				yield* store.saveProject({
					...connected,
					state: "preparing",
					updatedAtMs: nowMs,
				});
			const currentTemplateVersions = new Map(
				available.map((provider) => [
					provider.providerId,
					provider.templateVersion,
				]),
			);
			const response = json(
				publicProject(
					{
						...connected,
						state: builds.length > 0 ? "preparing" : connected.state,
					},
					builds,
					currentTemplateVersions,
				),
				201,
			);
			for (const build of builds)
				response.headers.append("x-zuse-reconcile-cloud-build", build.buildId);
			return response;
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

		if (method === "GET" && path === RelayPaths.cloudWorkspaces) {
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
			const relay = yield* RelayConfiguration;
			const expiresAt = nowMs + WORKSPACE_CLIENT_TICKET_TTL_MS;
			const credential = yield* signWorkspaceClientTicket({
				mintPrivateJwk: yield* parseJwk(Redacted.value(relay.mintPrivateKey)),
				issuer: relay.relayIssuer,
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
				wsUrl: gatewayUrl(relay.relayIssuer, workspaceId),
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
					Effect.mapError(() =>
						serviceUnavailable("cloud_workspace_ssh_unavailable"),
					),
				);
			const offer = yield* SandboxOfferConfiguration;
			const endpoint = yield* provider
				.resolveEndpoint(workspace.providerSandboxId, offer.port)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_workspace_ssh_unavailable"),
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
				workspacePath: "/home/zuse/workspace",
			});
		}

		if (method === "POST" && path === RelayPaths.cloudWorkspaces) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
			yield* requireBillingCapacity();
			const body = yield* decodeBody(CloudWorkspaceCreateRequest, request);
			const project = yield* store.getProject(body.projectId);
			if (project === null || project.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const provider = yield* selectedProvider(body.providerId);
			const projectBuild = yield* store.getActiveBuild(
				project.projectId,
				provider.providerId,
			);
			const accountBuild = yield* store.getActiveAccountBuild(
				principal.accountId,
				provider.providerId,
			);
			const selection = selectCloudWorkspaceBuild(
				accountBuild,
				projectBuild,
				yield* store.listBuilds(project.projectId),
				provider.templateVersion,
			);
			if (selection === undefined)
				return yield* Effect.fail(conflict("cloud_project_not_ready"));
			const { build, preparedSnapshotAvailable } = selection;
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
			const credentialKinds = [
				...(body.credentialKinds ?? []),
				"github" as const,
			].filter((kind, index, values) => values.indexOf(kind) === index);
			for (const kind of credentialKinds) {
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
			const launchIntent = makeCloudWorkspaceLaunchIntent({
				workspaceId,
				branch,
				agent: body.agent,
				model: body.model,
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
				credentialEpoch: yield* store.credentialEpoch(principal.accountId),
				wrappedTranscriptKey: transcriptKey.envelope,
				idempotencyKey: body.idempotencyKey,
				requestConfig: {
					title,
					agent: body.agent,
					model: body.model,
					credentialKinds,
					permissions: body.permissions ?? [],
					repositoryCache: preparedSnapshotAvailable
						? "prepared"
						: "direct-clone",
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
			const response = json(
				{
					workspace: publicWorkspace(outcome.workspace),
					chatId: outcome.workspace.chatId,
					initialSessionId: outcome.workspace.initialSessionId,
				},
				outcome.kind === "created" ? 201 : 200,
			);
			if (outcome.kind === "created")
				response.headers.set(
					"x-zuse-reconcile-cloud-workspace",
					outcome.workspace.workspaceId,
				);
			return response;
		}

		const actionMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/(pause|resume|restart|archive|unarchive|delete)$/u.exec(
				path,
			);
		if (method === "POST" && actionMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(actionMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const action = actionMatch[2] as
				| "pause"
				| "resume"
				| "restart"
				| "archive"
				| "unarchive"
				| "delete";
			if (
				action === "restart" &&
				(workspace.state !== "ready" ||
					workspace.providerSandboxId === undefined)
			)
				return yield* Effect.fail(badRequest("cloud_workspace_not_running"));
			if (action === "resume") yield* requireBillingCapacity();
			const actionRequest =
				action === "resume"
					? yield* decodeBody(CloudWorkspaceResumeRequest, request)
					: yield* decodeBody(CloudWorkspaceActionRequest, request);
			const recoverRuntime =
				action === "resume" &&
				"recoverRuntime" in actionRequest &&
				actionRequest.recoverRuntime === true;
			const commandId =
				"commandId" in actionRequest && actionRequest.commandId !== undefined
					? actionRequest.commandId
					: `${action}:${workspace.workspaceId}:${nowMs}`;
			const receivedAction = yield* store.getWorkspaceLifecycleCommand(
				workspace.workspaceId,
				commandId,
			);
			if (receivedAction !== null) {
				if (receivedAction !== action)
					return yield* Effect.fail(
						badRequest("cloud_workspace_command_id_reused"),
					);
				return json(publicWorkspace(workspace));
			}
			// Sending while a workspace is waking can issue resume more than once.
			// Treat those requests as one operation: rewriting the workspace here can
			// release the reconciler lease and replace its freshly staged boot token.
			if (
				action === "resume" &&
				!recoverRuntime &&
				cloudWorkspaceResumeIsAlreadyRequested(workspace)
			) {
				const response = json(publicWorkspace(workspace));
				response.headers.set(
					"x-zuse-reconcile-cloud-workspace",
					workspace.workspaceId,
				);
				return response;
			}
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
				...(action === "restart"
					? {
							state: "resuming" as const,
							runtimeState: "offline" as const,
							requestConfig: {
								...workspace.requestConfig,
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
							...failedWorkspaceResumeTarget(workspace),
							runtimeState: "offline" as const,
							requestConfig: {
								...workspace.requestConfig,
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
			yield* store.saveWorkspaceLifecycleCommand({
				workspace: received,
				commandId,
				action,
				createdAtMs: nowMs,
			});
			const response = json(publicWorkspace(received));
			response.headers.set(
				"x-zuse-reconcile-cloud-workspace",
				workspace.workspaceId,
			);
			return response;
		}

		if (method === "GET" && path === RelayPaths.cloudCredentials)
			return json({
				credentials: (yield* store.listCredentials(principal.accountId)).map(
					publicCredential,
				),
			});

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
			return json(
				publicCredential(
					yield* store.saveCredential({
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
					}),
				),
			);
		}

		const disconnectMatch =
			/^\/v1\/cloud\/credentials\/([^/]+)\/disconnect$/u.exec(path);
		if (method === "POST" && disconnectMatch !== null) {
			const kind = Schema.decodeUnknownOption(CloudCredentialKind)(
				decodeURIComponent(disconnectMatch[1] ?? ""),
			);
			if (kind._tag === "None")
				return yield* Effect.fail(badRequest("invalid_cloud_credential_kind"));
			const disconnected = yield* store.disconnectCredential(
				principal.accountId,
				kind.value,
				nowMs,
			);
			if (disconnected === null)
				return yield* Effect.fail(notFound("cloud_credential_not_found"));
			return json(publicCredential(disconnected));
		}

		return null;
	});
