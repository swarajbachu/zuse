import {
	CloudCredentialConnectRequest,
	CloudCredentialKind,
	CloudProjectConnectRequest,
	CloudProjectPrepareRequest,
	CloudWorkspaceCreateRequest,
	CloudWorkspaceStartupTimings,
	ComposerInput,
	RelayPaths,
} from "@zuse/contracts";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { Clock, Effect, Redacted, Schema } from "effect";
import { CompactEncrypt, importJWK, type JWK } from "jose";
import { requireWorkos } from "./auth.ts";
import { CloudChatCipher } from "./cloud-chat-cipher.ts";
import { CloudCredentialVault } from "./cloud-credential-vault.ts";
import { hasUsableCloudWorkspaceEntitlement } from "./cloud-entitlement.ts";
import {
	type CloudProjectBuildRecord,
	type CloudProjectRecord,
	type CloudWorkspaceCommandRecord,
	type CloudWorkspaceEventRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	sha256Hex,
	signWorkspaceClientTicket,
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
import type { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import type { WorkosVerifier } from "./workos.ts";
import { WORKSPACE_GATEWAY_PROTOCOL } from "./workspace-gateway-protocol.ts";

export type CloudWorkspaceRouteContext =
	| CloudWorkspaceStore
	| CloudChatCipher
	| CloudCredentialVault
	| MachineStore
	| SandboxProviders
	| SandboxOfferConfiguration
	| RelayConfiguration
	| WorkosVerifier;

// The RPC socket may reconnect without another user action. A signed ticket is
// reusable during this short lease; expiry affects only new connections.
const WORKSPACE_CLIENT_TICKET_TTL_MS = 5 * 60_000;
const RUNTIME_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

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
	workspace.statusCode === "provider-sandbox-missing"
		? ({ state: "queued", providerSandboxId: undefined } as const)
		: ({
				state: "resuming",
				providerSandboxId: workspace.providerSandboxId,
			} as const);

export const cloudWorkspaceResumeIsAlreadyRequested = (
	workspace: Pick<CloudWorkspaceRecord, "desiredState" | "state">,
): boolean =>
	workspace.desiredState === "ready" && workspace.state !== "failed";

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
	warmRetentionDeadline: workspace.warmRetentionDeadlineMs,
	recoveryAvailable:
		workspace.recoveryBundleKey !== undefined || workspace.state === "archived",
});

interface CloudChatMetadata {
	readonly title: string;
	readonly firstMessage?: string;
}
const CloudChatMetadataSchema = Schema.Struct({
	title: Schema.String,
	firstMessage: Schema.optional(Schema.String),
});

const legacyCloudChatMetadata = (
	workspace: CloudWorkspaceRecord,
): CloudChatMetadata => {
	if (
		typeof workspace.requestConfig.title === "string" &&
		workspace.requestConfig.title.trim().length > 0
	)
		return {
			title: workspace.requestConfig.title.trim(),
			...(typeof workspace.requestConfig.firstMessage === "string"
				? { firstMessage: workspace.requestConfig.firstMessage }
				: {}),
		};
	const firstMessage = workspace.requestConfig.firstMessage;
	if (typeof firstMessage !== "string") return { title: workspace.branch };
	const title = firstMessage.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";
	return {
		title:
			title.length === 0
				? workspace.branch
				: title.length > 80
					? `${title.slice(0, 77)}…`
					: title,
		firstMessage,
	};
};

const cloudChatMetadata = Effect.fn("decryptCloudChatMetadata")(function* (
	workspace: CloudWorkspaceRecord,
) {
	const cipher = yield* CloudChatCipher;
	if (workspace.chatMetadataCiphertext === undefined) {
		const legacy = legacyCloudChatMetadata(workspace);
		const encrypted = yield* cipher
			.encrypt(
				{
					accountId: workspace.accountId,
					workspaceId: workspace.workspaceId,
					recordKind: "workspace-metadata",
					recordId: workspace.chatId,
					version: 1,
				},
				JSON.stringify(legacy),
			)
			.pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_chat_encryption_unavailable"),
				),
			);
		const verified = yield* cipher
			.decrypt(
				{
					accountId: workspace.accountId,
					workspaceId: workspace.workspaceId,
					recordKind: "workspace-metadata",
					recordId: workspace.chatId,
					version: 1,
				},
				encrypted,
			)
			.pipe(
				Effect.mapError(() =>
					serviceUnavailable("cloud_chat_encryption_verify_failed"),
				),
			);
		if (verified !== JSON.stringify(legacy))
			return yield* Effect.fail(
				serviceUnavailable("cloud_chat_encryption_verify_failed"),
			);
		const store = yield* CloudWorkspaceStore;
		yield* store.migrateWorkspaceChatMetadata(workspace.workspaceId, encrypted);
		return legacy;
	}
	const plaintext = yield* cipher
		.decrypt(
			{
				accountId: workspace.accountId,
				workspaceId: workspace.workspaceId,
				recordKind: "workspace-metadata",
				recordId: workspace.chatId,
				version: 1,
			},
			workspace.chatMetadataCiphertext,
		)
		.pipe(
			Effect.mapError(() => serviceUnavailable("cloud_chat_decrypt_failed")),
		);
	return yield* Effect.try({
		try: () =>
			Schema.decodeUnknownSync(CloudChatMetadataSchema)(JSON.parse(plaintext)),
		catch: () => serviceUnavailable("cloud_chat_decrypt_failed"),
	});
});

const publicCloudChat = Effect.fn("publicCloudChat")(function* (
	workspace: CloudWorkspaceRecord,
	project: CloudProjectRecord,
	unread: boolean,
	lastMessageAt: number | null,
) {
	const metadata = yield* cloudChatMetadata(workspace);
	return {
		workspaceId: workspace.workspaceId,
		projectId: project.projectId,
		repositoryIdentity: project.repositoryIdentity,
		repositoryDisplayName: project.displayName,
		chatId: workspace.chatId,
		initialSessionId: workspace.initialSessionId,
		title: metadata.title,
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
		unread,
		lastMessageAt,
		...(workspace.state === "archived"
			? { archivedAt: workspace.updatedAtMs }
			: {}),
		...(typeof workspace.requestConfig.archivePhase === "string"
			? { archivePhase: workspace.requestConfig.archivePhase }
			: {}),
		...(typeof workspace.requestConfig.archiveErrorCode === "string"
			? { archiveErrorCode: workspace.requestConfig.archiveErrorCode }
			: {}),
		...(typeof workspace.requestConfig.archiveDiagnostic === "string"
			? {
					archiveDiagnostic:
						workspace.requestConfig.archiveDiagnostic.slice(-8_192),
				}
			: {}),
		createdAt: workspace.createdAtMs,
		updatedAt: workspace.updatedAtMs,
	};
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

const deliverCredentials = Effect.fn("deliverCloudWorkspaceCredentials")(
	function* (workspace: CloudWorkspaceRecord, credentialPublicJwk: string) {
		const store = yield* CloudWorkspaceStore;
		const vault = yield* CloudCredentialVault;
		const publicKey = yield* Effect.tryPromise({
			try: async () => {
				const parsed = JSON.parse(credentialPublicJwk) as JWK;
				if (parsed.kty !== "RSA") throw new Error("invalid_workspace_key");
				return importJWK(parsed, "RSA-OAEP-256");
			},
			catch: () => badRequest("invalid_workspace_key"),
		});
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
				const sealedSecret = yield* Effect.tryPromise({
					try: () =>
						new CompactEncrypt(new TextEncoder().encode(payload.secret))
							.setProtectedHeader({
								alg: "RSA-OAEP-256",
								enc: "A256GCM",
							})
							.encrypt(publicKey),
					catch: () => serviceUnavailable("cloud_credential_delivery_failed"),
				});
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

const RuntimeEventsRequest = Schema.Struct({
	commandId: Schema.optional(Schema.String),
	events: Schema.Array(
		Schema.Struct({
			runtimeSequence: Schema.Number,
			eventId: Schema.String,
			streamId: Schema.String,
			streamVersion: Schema.Number,
			type: Schema.String,
			payloadJson: Schema.String,
		}),
	),
});

const RuntimeReadyRequest = Schema.Struct({
	phase: Schema.Literals([
		"repository-ready",
		"agent-started",
		"command-acknowledged",
		"command-failed",
	]),
	commandId: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.String),
});

export const runtimeReadyStatusCode = (
	phase: "repository-ready" | "agent-started",
	commandState: unknown,
): "agent-starting" | "agent-running" =>
	phase === "agent-started" || commandState === "acknowledged"
		? "agent-running"
		: "agent-starting";

const RuntimeBootstrapRequest = Schema.Struct({
	credentialPublicJwk: Schema.String,
});

const CloudChatSendRequest = Schema.Struct({
	workspaceId: Schema.String,
	input: ComposerInput,
	clientMessageId: Schema.String,
	asGoal: Schema.optional(Schema.Boolean),
});

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
		const chatCipher = yield* CloudChatCipher;
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
		const encryptChatPayload = (
			workspace: Pick<CloudWorkspaceRecord, "workspaceId" | "accountId">,
			recordKind: "workspace-metadata" | "command" | "runtime-event",
			recordId: string,
			payload: unknown,
		) =>
			chatCipher
				.encrypt(
					{
						accountId: workspace.accountId,
						workspaceId: workspace.workspaceId,
						recordKind,
						recordId,
						version: 1,
					},
					recordKind === "runtime-event" && typeof payload === "string"
						? payload
						: JSON.stringify(payload),
				)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("cloud_chat_encryption_unavailable"),
					),
				);
		const verifyChatPayload = (
			workspace: Pick<CloudWorkspaceRecord, "workspaceId" | "accountId">,
			recordKind: "workspace-metadata" | "command" | "runtime-event",
			recordId: string,
			encryptedPayload: string,
			expectedPlaintext: string,
		) =>
			chatCipher
				.decrypt(
					{
						accountId: workspace.accountId,
						workspaceId: workspace.workspaceId,
						recordKind,
						recordId,
						version: 1,
					},
					encryptedPayload,
				)
				.pipe(
					Effect.filterOrFail(
						(plaintext) => plaintext === expectedPlaintext,
						() => serviceUnavailable("cloud_chat_encryption_verify_failed"),
					),
					Effect.mapError(() =>
						serviceUnavailable("cloud_chat_encryption_verify_failed"),
					),
				);
		const decryptCommand = (command: CloudWorkspaceCommandRecord) =>
			Effect.gen(function* () {
				if (command.encryptedPayload === undefined) {
					if (command.payload !== undefined) {
						const encryptedPayload = yield* encryptChatPayload(
							command,
							"command",
							command.commandId,
							command.payload,
						);
						yield* verifyChatPayload(
							command,
							"command",
							command.commandId,
							encryptedPayload,
							JSON.stringify(command.payload),
						);
						yield* store.migrateCommandPayload(
							command.commandId,
							encryptedPayload,
						);
						return command;
					}
					return yield* Effect.fail(
						serviceUnavailable("cloud_chat_decrypt_failed"),
					);
				}
				const plaintext = yield* chatCipher
					.decrypt(
						{
							accountId: command.accountId,
							workspaceId: command.workspaceId,
							recordKind: "command",
							recordId: command.commandId,
							version: 1,
						},
						command.encryptedPayload,
					)
					.pipe(
						Effect.mapError(() =>
							serviceUnavailable("cloud_chat_decrypt_failed"),
						),
					);
				const payload = yield* Effect.try({
					try: () => JSON.parse(plaintext) as Record<string, unknown>,
					catch: () => serviceUnavailable("cloud_chat_decrypt_failed"),
				});
				return { ...command, payload, encryptedPayload: undefined };
			});
		const decryptEvent = (
			workspace: CloudWorkspaceRecord,
			event: CloudWorkspaceEventRecord,
		) =>
			Effect.gen(function* () {
				if (event.encryptedPayload === undefined) {
					if (event.payloadJson !== undefined) {
						const encryptedPayload = yield* encryptChatPayload(
							workspace,
							"runtime-event",
							event.eventId,
							event.payloadJson,
						);
						yield* verifyChatPayload(
							workspace,
							"runtime-event",
							event.eventId,
							encryptedPayload,
							event.payloadJson,
						);
						yield* store.migrateEventPayload(
							event.workspaceId,
							event.runtimeSequence,
							encryptedPayload,
						);
						return event;
					}
					return yield* Effect.fail(
						serviceUnavailable("cloud_chat_decrypt_failed"),
					);
				}
				const payloadJson = yield* chatCipher
					.decrypt(
						{
							accountId: workspace.accountId,
							workspaceId: event.workspaceId,
							recordKind: "runtime-event",
							recordId: event.eventId,
							version: 1,
						},
						event.encryptedPayload,
					)
					.pipe(
						Effect.mapError(() =>
							serviceUnavailable("cloud_chat_decrypt_failed"),
						),
					);
				return { ...event, payloadJson, encryptedPayload: undefined };
			});

		const bootstrapMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/bootstrap$/u.exec(path);
		if (method === "POST" && bootstrapMatch !== null) {
			const workspaceId = decodeURIComponent(bootstrapMatch[1] ?? "");
			const body = yield* decodeBody(RuntimeBootstrapRequest, request);
			const workspace = yield* store.getWorkspace(workspaceId);
			const token = bearer(request);
			if (
				workspace === null ||
				token === undefined ||
				workspace.runtimeBootTokenHash !== (yield* sha256Hex(token)) ||
				(workspace.runtimeBootTokenExpiresAtMs ?? 0) <= nowMs ||
				workspace.desiredState !== "ready" ||
				workspace.providerSandboxId === undefined
			)
				return yield* Effect.fail(unauthorized("workspace_bootstrap_rejected"));
			const runtimeCredential = yield* randomToken("workspace_runtime", 32);
			const consumed = yield* store.consumeRuntimeBoot({
				workspaceId,
				bootTokenHash: yield* sha256Hex(token),
				runtimeCredentialHash: yield* sha256Hex(runtimeCredential),
				runtimeCredentialExpiresAtMs: nowMs + RUNTIME_CREDENTIAL_TTL_MS,
				nowMs,
			});
			if (consumed === null)
				return yield* Effect.fail(unauthorized("workspace_bootstrap_rejected"));
			const credentials = yield* deliverCredentials(
				consumed,
				body.credentialPublicJwk,
			);
			const provider = yield* (yield* SandboxProviders)
				.get(consumed.provider)
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
			const relay = yield* RelayConfiguration;
			return json({
				workspaceId,
				runtimeCredential,
				gatewayUrl: gatewayUrl(relay.relayIssuer, workspaceId),
				gatewayProtocol: WORKSPACE_GATEWAY_PROTOCOL,
				chatId: workspace.chatId,
				initialSessionId: workspace.initialSessionId,
				cloudCredentials: credentials,
			});
		}

		const commandMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/commands$/u.exec(path);
		if (method === "GET" && commandMatch !== null) {
			const workspaceId = decodeURIComponent(commandMatch[1] ?? "");
			yield* requireRuntime(request, workspaceId, nowMs);
			const after = Number(url.searchParams.get("after") ?? "0");
			if (!Number.isSafeInteger(after) || after < 0)
				return yield* Effect.fail(badRequest("invalid_command_cursor"));
			const commands = yield* store.listCommands(workspaceId, after, nowMs);
			return json({
				commands: yield* Effect.forEach(commands, decryptCommand),
			});
		}

		const eventsMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/events$/u.exec(path);
		if (method === "POST" && eventsMatch !== null) {
			const workspaceId = decodeURIComponent(eventsMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const body = yield* decodeBody(RuntimeEventsRequest, request);
			if (
				body.events.length > 500 ||
				body.events.some(
					(event) =>
						!Number.isSafeInteger(event.runtimeSequence) ||
						event.runtimeSequence < 1 ||
						event.payloadJson.length > 2_000_000,
				)
			)
				return yield* Effect.fail(badRequest("invalid_runtime_events"));
			const events: ReadonlyArray<CloudWorkspaceEventRecord> =
				yield* Effect.forEach(body.events, (event) =>
					Effect.gen(function* () {
						const eventId = event.eventId;
						return {
							workspaceId,
							runtimeSequence: event.runtimeSequence,
							eventId,
							streamId: event.streamId,
							streamVersion: event.streamVersion,
							type: event.type,
							encryptedPayload: yield* encryptChatPayload(
								workspace,
								"runtime-event",
								eventId,
								event.payloadJson,
							),
							createdAtMs: nowMs,
						};
					}),
				);
			yield* store.appendEvents(workspaceId, events);
			if (body.commandId !== undefined)
				yield* store.acknowledgeCommand(workspaceId, body.commandId, nowMs);
			const throughSequence = Math.max(
				0,
				...body.events.map((event) => event.runtimeSequence),
			);
			yield* store.saveWorkspace({
				...workspace,
				lastActivityAtMs: nowMs,
				nextActionAtMs: nowMs + idlePauseMs,
				requestConfig: {
					...workspace.requestConfig,
					...(body.commandId === undefined
						? {}
						: { commandState: "acknowledged" }),
				},
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			const response = json({ appendedThrough: throughSequence });
			response.headers.set("x-zuse-gateway-workspace", workspaceId);
			response.headers.set(
				"x-zuse-gateway-event-sequence",
				String(throughSequence),
			);
			return response;
		}

		const activityMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/runtime\/activity$/u.exec(path);
		if (method === "POST" && activityMatch !== null) {
			const workspaceId = decodeURIComponent(activityMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			yield* recordWorkspaceActivity(workspace);
			return json({ ok: true });
		}

		const readyMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/ready$/u.exec(path);
		if (method === "POST" && readyMatch !== null) {
			const workspaceId = decodeURIComponent(readyMatch[1] ?? "");
			const workspace = yield* requireRuntime(request, workspaceId, nowMs);
			const body = yield* decodeBody(RuntimeReadyRequest, request);
			const timings = startupTimings(workspace);
			if (body.commandId !== undefined) {
				if (body.phase === "command-failed")
					yield* store.failCommand(workspaceId, body.commandId, nowMs);
				else
					yield* store.acknowledgeCommand(workspaceId, body.commandId, nowMs);
			}
			if (body.phase === "command-failed") {
				console.error("[cloud-workspace] runtime command failed", {
					workspaceId,
					commandId: body.commandId,
					errorCode: body.errorCode ?? "workspace_command_failed",
				});
				return json({ workspace: publicWorkspace(workspace) });
			}
			if (body.phase === "command-acknowledged")
				return json({ workspace: publicWorkspace(workspace) });
			const agentStarted = body.phase === "agent-started";
			const updated: CloudWorkspaceRecord = {
				...workspace,
				runtimeState: "online",
				state: "ready",
				statusCode: runtimeReadyStatusCode(
					body.phase,
					workspace.requestConfig.commandState,
				),
				requestConfig: {
					...workspace.requestConfig,
					...(body.commandId === undefined
						? {}
						: { commandState: "acknowledged" }),
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
				role: runtime ? "runtime" : "client",
			});
			const response = new Response(null, { status: 204 });
			response.headers.set("x-zuse-gateway-workspace", workspaceId);
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
			// Compatibility backfill: an authenticated full chat listing visits every
			// legacy row for the account, verifies its encrypted replacement, and only
			// then clears the plaintext column. New writes never use these columns.
			yield* Effect.forEach(
				workspaces,
				(workspace) =>
					Effect.all([
						cloudChatMetadata(workspace),
						store
							.listStoredCommands(workspace.workspaceId)
							.pipe(
								Effect.flatMap((commands) =>
									Effect.forEach(commands, decryptCommand),
								),
							),
						store
							.listEvents(workspace.workspaceId, 0)
							.pipe(
								Effect.flatMap((events) =>
									Effect.forEach(events, (event) =>
										decryptEvent(workspace, event),
									),
								),
							),
					]),
				{ concurrency: 4 },
			);
			const chats = yield* Effect.forEach(
				workspaces.filter((workspace) => {
					if (workspace.state === "deleted") return false;
					if (scope === "all") return true;
					return scope === "archived"
						? workspace.state === "archived"
						: workspace.state !== "archived";
				}),
				(workspace) =>
					Effect.all([
						store.getProject(workspace.projectId),
						store.latestMessageAt(workspace.workspaceId),
					]).pipe(
						Effect.flatMap(([project, latestMessageAt]) => {
							if (project === null) return Effect.succeed(null);
							const lastReadAt =
								typeof workspace.requestConfig.lastReadAt === "number"
									? workspace.requestConfig.lastReadAt
									: workspace.createdAtMs;
							return publicCloudChat(
								workspace,
								project,
								latestMessageAt !== null && latestMessageAt > lastReadAt,
								latestMessageAt,
							);
						}),
					),
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
			return json({
				workspaces: (yield* store.listWorkspaces(
					principal.accountId,
					url.searchParams.get("projectId") ?? undefined,
				)).map(publicWorkspace),
			});
		}

		const workspaceMatch = /^\/v1\/cloud\/workspaces\/([^/]+)$/u.exec(path);
		if (method === "GET" && workspaceMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(workspaceMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			return json(publicWorkspace(workspace));
		}

		const grantMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/connection-grant$/u.exec(path);
		if (method === "POST" && grantMatch !== null) {
			const workspaceId = decodeURIComponent(grantMatch[1] ?? "");
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
				workspaceId,
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
				credential,
				expiresAt,
			});
			if (workspace.state === "paused")
				response.headers.set("x-zuse-reconcile-cloud-workspace", workspaceId);
			return response;
		}

		const historyMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/chat$/u.exec(path);
		if (method === "GET" && historyMatch !== null) {
			const workspaceId = decodeURIComponent(historyMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const afterParameter = url.searchParams.get("after");
			const after = Number(afterParameter ?? "0");
			if (!Number.isSafeInteger(after) || after < 0)
				return yield* Effect.fail(badRequest("invalid_event_cursor"));
			const events = yield* Effect.forEach(
				yield* store.listEvents(workspaceId, after),
				(event) => decryptEvent(workspace, event),
			);
			const messageCommands = yield* Effect.forEach(
				yield* store.listMessageCommands(workspaceId),
				decryptCommand,
			);
			const metadata = yield* cloudChatMetadata(workspace);
			// Initial transcript reads update unread state. Incremental streaming
			// polls stay read-only instead of writing to PostgreSQL four times a second.
			if (afterParameter === null)
				yield* store.markChatRead(workspaceId, principal.accountId, nowMs);
			return json({
				workspaceId,
				chatId: workspace.chatId,
				initialSessionId: workspace.initialSessionId,
				firstMessage: metadata.firstMessage,
				commandState:
					workspace.requestConfig.commandState === "acknowledged"
						? "acknowledged"
						: "queued",
				events: events.map((event) => ({
					sequence: event.runtimeSequence,
					eventId: event.eventId,
					streamId: event.streamId,
					streamVersion: event.streamVersion,
					type: event.type,
					payloadJson: event.payloadJson ?? "{}",
					createdAt: event.createdAtMs,
				})),
				queuedMessages: messageCommands.flatMap((command) => {
					const input = Schema.decodeUnknownOption(ComposerInput)(
						command.payload?.input,
					);
					const clientMessageId = command.payload?.clientMessageId;
					return input._tag === "Some" && typeof clientMessageId === "string"
						? [
								{
									sequence: command.sequence,
									clientMessageId,
									input: input.value,
									state: command.state,
									asGoal: command.payload?.asGoal === true,
									createdAt: command.createdAtMs,
								},
							]
						: [];
				}),
				cursor: events.at(-1)?.runtimeSequence ?? after,
			});
		}

		const messageMatch = /^\/v1\/cloud\/workspaces\/([^/]+)\/messages$/u.exec(
			path,
		);
		if (method === "POST" && messageMatch !== null) {
			const workspaceId = decodeURIComponent(messageMatch[1] ?? "");
			const workspace = yield* store.getWorkspace(workspaceId);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			if (
				workspace.state === "archived" ||
				workspace.state === "deleting" ||
				workspace.state === "deleted"
			)
				return yield* Effect.fail(conflict("cloud_workspace_not_writable"));
			const body = yield* decodeBody(CloudChatSendRequest, request);
			if (body.workspaceId !== workspaceId)
				return yield* Effect.fail(badRequest("workspace_id_mismatch"));
			const commandId = `message:${body.clientMessageId}`;
			const command = yield* store.createNextCommand({
				commandId,
				workspaceId,
				accountId: principal.accountId,
				kind: "send-message",
				encryptedPayload: yield* encryptChatPayload(
					workspace,
					"command",
					commandId,
					{
						initialSessionId: workspace.initialSessionId,
						input: body.input,
						clientMessageId: body.clientMessageId,
						asGoal: body.asGoal ?? false,
					},
				),
				state: "queued",
				createdAtMs: nowMs,
			});
			const shouldResume = workspace.state === "paused";
			yield* recordWorkspaceActivity(workspace);
			const response = json({ sequence: command.sequence }, 202);
			response.headers.set("x-zuse-gateway-workspace", workspaceId);
			response.headers.set("x-zuse-gateway-command", "available");
			response.headers.set(
				"x-zuse-gateway-command-sequence",
				String(command.sequence),
			);
			if (shouldResume)
				response.headers.set("x-zuse-reconcile-cloud-workspace", workspaceId);
			return response;
		}

		if (method === "POST" && path === RelayPaths.cloudWorkspaces) {
			if (!(yield* hasEntitlement(principal.accountId, nowMs)))
				return yield* Effect.fail(forbidden("cloud_entitlement_required"));
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
			const branch = body.branch ?? `zuse/${workspaceId.slice(-8)}`;
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
			const title = (() => {
				const value = body.firstMessage?.trim().split(/\r?\n/u, 1)[0]?.trim();
				return value === undefined || value.length === 0
					? branch
					: value.length > 80
						? `${value.slice(0, 77)}…`
						: value;
			})();
			const chatMetadataCiphertext = yield* encryptChatPayload(
				{ workspaceId, accountId: principal.accountId },
				"workspace-metadata",
				chatId,
				{
					title,
					...(body.firstMessage === undefined
						? {}
						: { firstMessage: body.firstMessage }),
				},
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
				idempotencyKey: body.idempotencyKey,
				chatMetadataCiphertext,
				requestConfig: {
					agent: body.agent,
					model: body.model,
					credentialKinds,
					permissions: body.permissions ?? [],
					commandState: "queued",
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
			const commandFor = Effect.fn("encryptStartCloudAgentCommand")(function* (
				target: CloudWorkspaceRecord,
			) {
				const commandId = `start:${target.workspaceId}`;
				return {
					commandId,
					workspaceId: target.workspaceId,
					accountId: target.accountId,
					sequence: 1,
					kind: "start-agent",
					encryptedPayload: yield* encryptChatPayload(
						target,
						"command",
						commandId,
						{
							chatId: target.chatId,
							initialSessionId: target.initialSessionId,
							title,
							agent: body.agent,
							model: body.model,
							firstMessage: body.firstMessage,
							permissions: body.permissions ?? [],
						},
					),
					state: "queued",
					createdAtMs: nowMs,
				} satisfies CloudWorkspaceCommandRecord;
			});
			const outcome = yield* store.createWorkspace(
				workspace,
				yield* commandFor(workspace),
			);
			if (outcome.kind === "branch-in-use")
				return yield* Effect.fail(
					conflict(`cloud_branch_in_use:${outcome.workspace.workspaceId}`),
				);
			if (outcome.kind === "existing")
				yield* store.createCommand(yield* commandFor(outcome.workspace));
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

		const renameMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/chat\/rename$/u.exec(path);
		if (method === "POST" && renameMatch !== null) {
			const workspace = yield* store.getWorkspace(
				decodeURIComponent(renameMatch[1] ?? ""),
			);
			if (workspace === null || workspace.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));
			const body = yield* decodeBody(
				Schema.Struct({ title: Schema.String }),
				request,
			);
			const title = body.title.trim();
			if (title.length === 0 || title.length > 80)
				return yield* Effect.fail(badRequest("invalid_cloud_chat_title"));
			const metadata = yield* cloudChatMetadata(workspace);
			const updated: CloudWorkspaceRecord = {
				...workspace,
				chatMetadataCiphertext: yield* encryptChatPayload(
					workspace,
					"workspace-metadata",
					workspace.chatId,
					{ ...metadata, title },
				),
				requestConfig: Object.fromEntries(
					Object.entries(workspace.requestConfig).filter(
						([key]) => key !== "title" && key !== "firstMessage",
					),
				),
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			};
			yield* store.saveWorkspace(updated);
			const renameCommandId = `rename:${updated.workspaceId}:${updated.revision}`;
			const renameCommand = yield* store.createNextCommand({
				commandId: renameCommandId,
				workspaceId: updated.workspaceId,
				accountId: updated.accountId,
				kind: "rename-chat",
				encryptedPayload: yield* encryptChatPayload(
					updated,
					"command",
					renameCommandId,
					{ title },
				),
				state: "queued",
				createdAtMs: nowMs,
			});
			const project = yield* store.getProject(updated.projectId);
			if (project === null)
				return yield* Effect.fail(notFound("cloud_project_not_found"));
			const response = json(
				yield* publicCloudChat(
					updated,
					project,
					false,
					yield* store.latestMessageAt(updated.workspaceId),
				),
			);
			response.headers.set("x-zuse-gateway-workspace", updated.workspaceId);
			response.headers.set("x-zuse-gateway-command", "available");
			response.headers.set(
				"x-zuse-gateway-command-sequence",
				String(renameCommand.sequence),
			);
			return response;
		}

		const actionMatch =
			/^\/v1\/cloud\/workspaces\/([^/]+)\/(pause|resume|archive|unarchive|delete)$/u.exec(
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
				| "archive"
				| "unarchive"
				| "delete";
			// Sending while a workspace is waking can issue resume more than once.
			// Treat those requests as one operation: rewriting the workspace here can
			// release the reconciler lease and replace its freshly staged boot token.
			if (
				action === "resume" &&
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
				action === "resume"
					? "ready"
					: action === "unarchive"
						? "paused"
						: action === "delete"
							? "deleted"
							: action === "archive"
								? "archived"
								: "paused";
			const {
				archivePhase: _archivePhase,
				archiveErrorCode: _archiveErrorCode,
				archiveDiagnostic: _archiveDiagnostic,
				...requestConfigWithoutArchiveFailure
			} = workspace.requestConfig;
			const updated: CloudWorkspaceRecord = {
				...workspace,
				...(action === "unarchive"
					? { state: "paused" as const, runtimeState: "offline" as const }
					: {}),
				...(action === "archive"
					? { requestConfig: requestConfigWithoutArchiveFailure }
					: {}),
				...(action === "resume" && workspace.state === "failed"
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
				statusCode: `${action}-queued`,
				nextActionAtMs: nowMs,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			};
			yield* store.saveWorkspace(updated);
			const response = json(publicWorkspace(updated));
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
