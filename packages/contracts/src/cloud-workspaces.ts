import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { DEFAULT_RUNTIME_MODE, ProviderId, RuntimeMode } from "./agent.ts";
import {
	CloudCommandEnvelope,
	CommandAcceptance,
	CommandChangePage,
	CommandStatus,
} from "./cloud-commands.ts";
import { AgentSessionId, ChatId } from "./ids.ts";
import {
	Message,
	SessionStreamCursor,
	SessionTimelineProjection,
} from "./session.ts";

export const CLOUD_WORKSPACE_OFFER_ID = "cloud-workspace-standard-v1" as const;

export const CloudProjectState = Schema.Literals([
	"connected",
	"preparing",
	"ready",
	"failed",
]);
export type CloudProjectState = typeof CloudProjectState.Type;

export const CloudProjectBuildState = Schema.Literals([
	"queued",
	"building",
	"sanitizing",
	"ready",
	"failed",
]);
export type CloudProjectBuildState = typeof CloudProjectBuildState.Type;

export const CloudAccountImageState = Schema.Literals([
	"not-built",
	"building",
	"ready",
	"outdated",
	"auth-broken",
	"failed",
]);
export type CloudAccountImageState = typeof CloudAccountImageState.Type;

export const CloudAccountImageBuildMode = Schema.Literals([
	"update",
	"rebuild",
]);
export type CloudAccountImageBuildMode = typeof CloudAccountImageBuildMode.Type;

export const CloudWorkspaceState = Schema.Literals([
	"queued",
	"provisioning",
	"setup",
	"ready",
	"pausing",
	"paused",
	"resuming",
	"archiving",
	"archived",
	"deleting",
	"deleted",
	"failed",
]);
export type CloudWorkspaceState = typeof CloudWorkspaceState.Type;

export const CloudWorkspaceDesiredState = Schema.Literals([
	"ready",
	"paused",
	"archived",
	"deleted",
]);
export type CloudWorkspaceDesiredState = typeof CloudWorkspaceDesiredState.Type;

export const CloudWorkspaceStartupPhase = Schema.Literals([
	"allocating",
	"booting",
	"authenticating-runtime",
	"syncing-repository",
	"starting-agent",
	"running",
	"failed",
]);
export type CloudWorkspaceStartupPhase = typeof CloudWorkspaceStartupPhase.Type;

export class CloudWorkspaceStartupTimings extends Schema.Class<CloudWorkspaceStartupTimings>(
	"CloudWorkspaceStartupTimings",
)({
	requestedAt: Schema.optional(Schema.Number),
	poolClaimedAt: Schema.optional(Schema.Number),
	forkedAt: Schema.optional(Schema.Number),
	resumeRequestedAt: Schema.optional(Schema.Number),
	allocatedAt: Schema.optional(Schema.Number),
	allocationDurationMs: Schema.optional(Schema.Number),
	enrolledAt: Schema.optional(Schema.Number),
	runtimeReadyAt: Schema.optional(Schema.Number),
	enrollmentDurationMs: Schema.optional(Schema.Number),
	networkOpenedAt: Schema.optional(Schema.Number),
	credentialInstallDurationMs: Schema.optional(Schema.Number),
	repositoryReadyAt: Schema.optional(Schema.Number),
	repositoryDurationMs: Schema.optional(Schema.Number),
	connectedAt: Schema.optional(Schema.Number),
	connectionDurationMs: Schema.optional(Schema.Number),
	durableChatCreatedAt: Schema.optional(Schema.Number),
	chatCreateDurationMs: Schema.optional(Schema.Number),
	agentStartedAt: Schema.optional(Schema.Number),
	messageAcceptedAt: Schema.optional(Schema.Number),
	agentStartDurationMs: Schema.optional(Schema.Number),
	launchDurationMs: Schema.optional(Schema.Number),
	providerResumedAt: Schema.optional(Schema.Number),
	providerResumeDurationMs: Schema.optional(Schema.Number),
}) {}

export const CloudWorkspaceRuntimeState = Schema.Literals([
	"offline",
	"connecting",
	"online",
]);
export type CloudWorkspaceRuntimeState = typeof CloudWorkspaceRuntimeState.Type;

export class CloudProviderOption extends Schema.Class<CloudProviderOption>(
	"CloudProviderOption",
)({
	providerId: Schema.String,
	displayName: Schema.String,
}) {}

export class CloudProviderList extends Schema.Class<CloudProviderList>(
	"CloudProviderList",
)({
	providers: Schema.Array(CloudProviderOption),
}) {}

export class CloudProjectBuildStatus extends Schema.Class<CloudProjectBuildStatus>(
	"CloudProjectBuildStatus",
)({
	buildId: Schema.String,
	providerId: Schema.String,
	state: CloudProjectBuildState,
	errorCode: Schema.optional(Schema.String),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class CloudProject extends Schema.Class<CloudProject>("CloudProject")({
	projectId: Schema.String,
	repositoryIdentity: Schema.String,
	repositoryUrl: Schema.String,
	displayName: Schema.String,
	defaultBranch: Schema.String,
	visibility: Schema.Literals(["public", "private"]),
	state: CloudProjectState,
	activeBuilds: Schema.Record(Schema.String, Schema.String),
	latestBuilds: Schema.Record(Schema.String, CloudProjectBuildStatus),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class CloudProjectList extends Schema.Class<CloudProjectList>(
	"CloudProjectList",
)({ projects: Schema.Array(CloudProject) }) {}

export class CloudProjectConnectRequest extends Schema.Class<CloudProjectConnectRequest>(
	"CloudProjectConnectRequest",
)({
	repositoryUrl: Schema.String,
	defaultBranch: Schema.String,
	visibility: Schema.Literals(["public", "private"]),
	displayName: Schema.optional(Schema.String),
	cloudEnvironment: Schema.optional(
		Schema.Record(Schema.String, Schema.String),
	),
	secretBindings: Schema.optional(Schema.Array(Schema.String)),
	idempotencyKey: Schema.String,
}) {}

export class CloudProjectBuild extends Schema.Class<CloudProjectBuild>(
	"CloudProjectBuild",
)({
	buildId: Schema.String,
	projectId: Schema.String,
	providerId: Schema.String,
	state: CloudProjectBuildState,
	sourceCommit: Schema.optional(Schema.String),
	templateVersion: Schema.String,
	configurationDigest: Schema.String,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class CloudAccountImageRepository extends Schema.Class<CloudAccountImageRepository>(
	"CloudAccountImageRepository",
)({
	projectId: Schema.String,
	repositoryIdentity: Schema.String,
	displayName: Schema.String,
	defaultBranch: Schema.String,
	sourceCommit: Schema.optional(Schema.String),
}) {}

export class CloudAccountImageProvider extends Schema.Class<CloudAccountImageProvider>(
	"CloudAccountImageProvider",
)({
	providerId: Schema.String,
	state: Schema.Literals([
		"disconnected",
		"authorizing",
		"connected",
		"expired",
		"error",
		"missing-tool",
	]),
	method: Schema.optional(
		Schema.Literals(["subscription", "api-key", "custom"]),
	),
	verifiedAt: Schema.optional(Schema.Number),
}) {}

export class CloudAccountImageBuildAttempt extends Schema.Class<CloudAccountImageBuildAttempt>(
	"CloudAccountImageBuildAttempt",
)({
	buildId: Schema.String,
	state: CloudProjectBuildState,
	mode: CloudAccountImageBuildMode,
	active: Schema.Boolean,
	progressPhase: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.String),
	logText: Schema.optional(Schema.String),
	runtimeVersion: Schema.String,
	configurationDigest: Schema.String,
	repositories: Schema.Array(CloudAccountImageRepository),
	providers: Schema.Array(CloudAccountImageProvider),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

/** The single logical private E2B image maintained for an account. */
export class CloudAccountImage extends Schema.Class<CloudAccountImage>(
	"CloudAccountImage",
)({
	state: CloudAccountImageState,
	generation: Schema.optional(Schema.String),
	providerId: Schema.optional(Schema.String),
	runtimeVersion: Schema.optional(Schema.String),
	buildMode: Schema.optional(CloudAccountImageBuildMode),
	progressPhase: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.String),
	repositories: Schema.Array(CloudAccountImageRepository),
	providers: Schema.Array(CloudAccountImageProvider),
	builds: Schema.Array(CloudAccountImageBuildAttempt),
	builtAt: Schema.optional(Schema.Number),
	updatedAt: Schema.Number,
}) {}

export class CloudAccountImageBuildRequest extends Schema.Class<CloudAccountImageBuildRequest>(
	"CloudAccountImageBuildRequest",
)({
	mode: CloudAccountImageBuildMode,
	idempotencyKey: Schema.String,
}) {}

export class CloudProjectPrepareRequest extends Schema.Class<CloudProjectPrepareRequest>(
	"CloudProjectPrepareRequest",
)({
	projectId: Schema.String,
	providerId: Schema.String,
	idempotencyKey: Schema.String,
}) {}

export class CloudWorkspace extends Schema.Class<CloudWorkspace>(
	"CloudWorkspace",
)({
	workspaceId: Schema.String,
	projectId: Schema.String,
	/** Legacy internal row id retained during the account-image migration. */
	buildId: Schema.optional(Schema.String),
	imageGeneration: Schema.String.pipe(
		Schema.withConstructorDefault(Effect.succeed("legacy")),
		Schema.withDecodingDefaultType(Effect.succeed("legacy")),
	),
	providerId: Schema.String,
	branch: Schema.String,
	baseRef: Schema.String,
	state: CloudWorkspaceState,
	desiredState: CloudWorkspaceDesiredState,
	statusCode: Schema.String,
	failureDiagnostic: Schema.optional(Schema.String),
	startupPhase: CloudWorkspaceStartupPhase,
	startupTimings: CloudWorkspaceStartupTimings,
	runtimeState: CloudWorkspaceRuntimeState,
	revision: Schema.Number,
	chatId: ChatId,
	initialSessionId: AgentSessionId,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	lastActivityAt: Schema.Number,
}) {}

export class CloudWorkspaceLaunch extends Schema.Class<CloudWorkspaceLaunch>(
	"CloudWorkspaceLaunch",
)({
	workspace: CloudWorkspace,
	chatId: ChatId,
	initialSessionId: AgentSessionId,
}) {}

export class CloudWorkspaceConnection extends Schema.Class<CloudWorkspaceConnection>(
	"CloudWorkspaceConnection",
)({
	workspaceId: Schema.String,
	wsUrl: Schema.String,
	protocol: Schema.String,
	role: Schema.Literal("client"),
	generation: Schema.Number,
	gatewayEpoch: Schema.Number,
	credential: Schema.String,
	expiresAt: Schema.Number,
}) {}

/**
 * Last-known runtime metadata for catalog/sidebar rendering. This deliberately
 * cannot carry transcript, queue, file, Git, or terminal payloads.
 */
export class CloudWorkspaceRuntimeSummary extends Schema.Class<CloudWorkspaceRuntimeSummary>(
	"CloudWorkspaceRuntimeSummary",
)({
	summaryRevision: Schema.Number,
	title: Schema.String,
	lastActivityAt: Schema.Number,
	sessionHeadVersion: Schema.Number,
}) {}

/** Last-known cloud workspace metadata available without a live runtime. */
export class CloudChatSummary extends Schema.Class<CloudChatSummary>(
	"CloudChatSummary",
)({
	workspaceId: Schema.String,
	projectId: Schema.String,
	repositoryIdentity: Schema.String,
	repositoryDisplayName: Schema.String,
	chatId: ChatId,
	initialSessionId: AgentSessionId,
	title: Schema.String,
	branch: Schema.String,
	providerId: Schema.String,
	agent: ProviderId,
	model: Schema.String,
	runtimeMode: RuntimeMode.pipe(
		Schema.withConstructorDefault(Effect.succeed(DEFAULT_RUNTIME_MODE)),
		Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_RUNTIME_MODE)),
	),
	state: CloudWorkspaceState,
	desiredState: CloudWorkspaceDesiredState,
	runtimeState: CloudWorkspaceRuntimeState,
	statusCode: Schema.String,
	failureDiagnostic: Schema.optional(Schema.String),
	startupPhase: CloudWorkspaceStartupPhase,
	revision: Schema.Number,
	/** Monotonic within the current runtime generation. */
	summaryRevision: Schema.Number.pipe(
		Schema.withConstructorDefault(Effect.succeed(0)),
		Schema.withDecodingDefaultType(Effect.succeed(0)),
	),
	/** Authoritative runtime session head represented by this summary. */
	sessionHeadVersion: Schema.Number.pipe(
		Schema.withConstructorDefault(Effect.succeed(0)),
		Schema.withDecodingDefaultType(Effect.succeed(0)),
	),
	unread: Schema.Boolean,
	lastMessageAt: Schema.NullOr(Schema.Number),
	archivedAt: Schema.optional(Schema.Number),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class CloudChatList extends Schema.Class<CloudChatList>("CloudChatList")(
	{
		chats: Schema.Array(CloudChatSummary),
	},
) {}

export const CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export class CloudTranscriptCheckpointPayload extends Schema.Class<CloudTranscriptCheckpointPayload>(
	"CloudTranscriptCheckpointPayload",
)({
	schemaVersion: Schema.Literal(CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION),
	workspaceId: Schema.String,
	sessionId: AgentSessionId,
	cursor: SessionStreamCursor,
	projection: SessionTimelineProjection,
}) {}

export class CloudTranscriptCheckpointMetadata extends Schema.Class<CloudTranscriptCheckpointMetadata>(
	"CloudTranscriptCheckpointMetadata",
)({
	workspaceId: Schema.String,
	sessionId: AgentSessionId,
	runtimeGeneration: Schema.Number,
	cursor: SessionStreamCursor,
	objectKey: Schema.String,
	ciphertextSha256: Schema.String,
	ciphertextBytes: Schema.Number,
	createdAt: Schema.Number,
}) {}

export class CloudTranscriptCheckpointUpload extends Schema.Class<CloudTranscriptCheckpointUpload>(
	"CloudTranscriptCheckpointUpload",
)({
	sessionId: AgentSessionId,
	cursor: SessionStreamCursor,
	ciphertext: Schema.String,
	ciphertextSha256: Schema.String,
}) {}

export class CloudTranscriptCheckpointAccess extends Schema.Class<CloudTranscriptCheckpointAccess>(
	"CloudTranscriptCheckpointAccess",
)({
	metadata: CloudTranscriptCheckpointMetadata,
	ciphertext: Schema.String,
	transcriptKey: Schema.String,
}) {}

export class CloudTranscriptCheckpointResult extends Schema.Class<CloudTranscriptCheckpointResult>(
	"CloudTranscriptCheckpointResult",
)({
	checkpoint: Schema.NullOr(CloudTranscriptCheckpointAccess),
}) {}

export class CloudTranscriptMessagePagePayload extends Schema.Class<CloudTranscriptMessagePagePayload>(
	"CloudTranscriptMessagePagePayload",
)({
	schemaVersion: Schema.Literal(CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION),
	workspaceId: Schema.String,
	sessionId: AgentSessionId,
	cursor: SessionStreamCursor,
	beforeSequence: Schema.Number,
	messages: Schema.Array(Message),
	olderMessageSequence: Schema.NullOr(Schema.Number),
}) {}

export class CloudTranscriptMessagePageUpload extends Schema.Class<CloudTranscriptMessagePageUpload>(
	"CloudTranscriptMessagePageUpload",
)({
	sessionId: AgentSessionId,
	cursor: SessionStreamCursor,
	beforeSequence: Schema.Number,
	ciphertext: Schema.String,
	ciphertextSha256: Schema.String,
}) {}

export class CloudTranscriptMessagePageResult extends Schema.Class<CloudTranscriptMessagePageResult>(
	"CloudTranscriptMessagePageResult",
)({
	page: Schema.NullOr(
		Schema.Struct({
			cursor: SessionStreamCursor,
			beforeSequence: Schema.Number,
			ciphertext: Schema.String,
			ciphertextSha256: Schema.String,
			transcriptKey: Schema.String,
		}),
	),
}) {}

export class CloudWorkspaceList extends Schema.Class<CloudWorkspaceList>(
	"CloudWorkspaceList",
)({ workspaces: Schema.Array(CloudWorkspace) }) {}

export class CloudWorkspaceCreateRequest extends Schema.Class<CloudWorkspaceCreateRequest>(
	"CloudWorkspaceCreateRequest",
)({
	projectId: Schema.String,
	providerId: Schema.String,
	baseRef: Schema.String,
	branch: Schema.optional(Schema.String),
	agent: Schema.String,
	model: Schema.String,
	runtimeMode: Schema.optional(RuntimeMode),
	secretBindings: Schema.optional(Schema.Array(Schema.String)),
	permissions: Schema.optional(Schema.Array(Schema.String)),
	firstMessage: Schema.optional(Schema.String),
	idempotencyKey: Schema.String,
}) {}

export class CloudWorkspaceActionRequest extends Schema.Class<CloudWorkspaceActionRequest>(
	"CloudWorkspaceActionRequest",
)({
	workspaceId: Schema.String,
	commandId: Schema.optional(Schema.String),
}) {}

export class CloudWorkspaceResumeRequest extends Schema.Class<CloudWorkspaceResumeRequest>(
	"CloudWorkspaceResumeRequest",
)({
	workspaceId: Schema.String,
	commandId: Schema.optional(Schema.String),
	/** The gateway proved that API's online projection has no runtime socket. */
	recoverRuntime: Schema.optional(Schema.Boolean),
}) {}

/**
 * A short-lived grant for the workspace runtime's WebSocket SSH bridge. The
 * api stages the hashed ticket inside the sandbox; the desktop's
 * ProxyCommand bridge presents the plain ticket when it connects to `wsUrl`.
 */
export class CloudWorkspaceSshAccess extends Schema.Class<CloudWorkspaceSshAccess>(
	"CloudWorkspaceSshAccess",
)({
	workspaceId: Schema.String,
	wsUrl: Schema.String,
	ticket: Schema.String,
	expiresAt: Schema.Number,
	user: Schema.String,
	workspacePath: Schema.String,
}) {}

/**
 * A per-port public preview host for a running cloud workspace. The URL is
 * public-by-URL: anyone holding it reaches the port with no further auth
 * (the high-entropy sandbox id is the trust model). Revocation is pausing or
 * restarting the workspace, which retires the sandbox id.
 */
export class CloudWorkspacePreviewUrl extends Schema.Class<CloudWorkspacePreviewUrl>(
	"CloudWorkspacePreviewUrl",
)({
	workspaceId: Schema.String,
	port: Schema.Number,
	url: Schema.String,
	/** Epoch millis, or null when the URL lives as long as the sandbox. */
	expiresAt: Schema.NullOr(Schema.Number),
}) {}

export class CloudWorkspaceOpError extends Schema.TaggedErrorClass<CloudWorkspaceOpError>()(
	"CloudWorkspaceOpError",
	{
		code: Schema.Literals([
			"not-found",
			"not-allowed",
			"beta-access-required",
			"beta-access-unavailable",
			"invalid-request",
			"entitlement-required",
			"provider-unavailable",
			"project-not-ready",
			"credential-required",
			"branch-in-use",
			"conflict",
			"billing-hold",
		]),
	},
) {}

export const CloudProvidersRpc = Rpc.make("cloud.providers", {
	payload: Schema.Void,
	success: CloudProviderList,
	error: CloudWorkspaceOpError,
});
export const CloudProjectsListRpc = Rpc.make("cloud.projects.list", {
	payload: Schema.Void,
	success: CloudProjectList,
	error: CloudWorkspaceOpError,
});
export const CloudProjectsConnectRpc = Rpc.make("cloud.projects.connect", {
	payload: CloudProjectConnectRequest,
	success: CloudProject,
	error: CloudWorkspaceOpError,
});
export const CloudProjectsRemoveRpc = Rpc.make("cloud.projects.remove", {
	payload: Schema.Struct({ projectId: Schema.String }),
	success: CloudProject,
	error: CloudWorkspaceOpError,
});
export const CloudProjectsPrepareRpc = Rpc.make("cloud.projects.prepare", {
	payload: CloudProjectPrepareRequest,
	success: CloudProjectBuild,
	error: CloudWorkspaceOpError,
});
export const CloudAccountImageStatusRpc = Rpc.make("cloud.image.status", {
	payload: Schema.Void,
	success: CloudAccountImage,
	error: CloudWorkspaceOpError,
});
export const CloudAccountImageBuildRpc = Rpc.make("cloud.image.build", {
	payload: CloudAccountImageBuildRequest,
	success: CloudAccountImage,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesListRpc = Rpc.make("cloud.workspaces.list", {
	payload: Schema.Struct({ projectId: Schema.optional(Schema.String) }),
	success: CloudWorkspaceList,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesGetRpc = Rpc.make("cloud.workspaces.get", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
/**
 * One monotonic lifecycle control stream for a workspace. The server adapts
 * API's current REST surface; clients never own lifecycle polling loops.
 */
export const CloudWorkspacesWatchRpc = Rpc.make("cloud.workspaces.watch", {
	payload: Schema.Struct({
		workspaceId: Schema.String,
		afterRevision: Schema.optional(Schema.Number),
	}),
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
	stream: true,
});
export const CloudWorkspacesCreateRpc = Rpc.make("cloud.workspaces.create", {
	payload: CloudWorkspaceCreateRequest,
	success: CloudWorkspaceLaunch,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesConnectRpc = Rpc.make("cloud.workspaces.connect", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspaceConnection,
	error: CloudWorkspaceOpError,
});
export const CloudChatsListRpc = Rpc.make("cloud.chats.list", {
	payload: Schema.Struct({
		projectId: Schema.optional(Schema.String),
		scope: Schema.optional(Schema.Literals(["active", "archived", "all"])),
	}),
	success: CloudChatList,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesPauseRpc = Rpc.make("cloud.workspaces.pause", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesResumeRpc = Rpc.make("cloud.workspaces.resume", {
	payload: CloudWorkspaceResumeRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
/** Restart the runtime of a running workspace in place (same sandbox). */
export const CloudWorkspacesRestartRpc = Rpc.make("cloud.workspaces.restart", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesSshAccessRpc = Rpc.make(
	"cloud.workspaces.sshAccess",
	{
		payload: CloudWorkspaceActionRequest,
		success: CloudWorkspaceSshAccess,
		error: CloudWorkspaceOpError,
	},
);
export const CloudWorkspacesPreviewUrlRpc = Rpc.make(
	"cloud.workspaces.previewUrl",
	{
		payload: Schema.Struct({
			workspaceId: Schema.String,
			port: Schema.Number,
		}),
		success: CloudWorkspacePreviewUrl,
		error: CloudWorkspaceOpError,
	},
);
export const CloudWorkspacesArchiveRpc = Rpc.make("cloud.workspaces.archive", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesUnarchiveRpc = Rpc.make(
	"cloud.workspaces.unarchive",
	{
		payload: CloudWorkspaceActionRequest,
		success: CloudWorkspace,
		error: CloudWorkspaceOpError,
	},
);
export const CloudWorkspacesDeleteRpc = Rpc.make("cloud.workspaces.delete", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});

export const CloudCommandsEnqueueRpc = Rpc.make("cloud.commands.enqueue", {
	payload: CloudCommandEnvelope,
	success: CommandAcceptance,
	error: CloudWorkspaceOpError,
});
export class CloudWorkspaceDataKey extends Schema.Class<CloudWorkspaceDataKey>(
	"CloudWorkspaceDataKey",
)({
	workspaceId: Schema.String,
	encodedKey: Schema.String,
	keyVersion: Schema.Number,
	destructionFence: Schema.Number,
	mailboxEnabled: Schema.Boolean,
}) {}
export const CloudWorkspaceDataKeyRpc = Rpc.make("cloud.commands.dataKey", {
	payload: Schema.Struct({ workspaceId: Schema.String }),
	success: CloudWorkspaceDataKey,
	error: CloudWorkspaceOpError,
});
export const CloudCommandsStatusRpc = Rpc.make("cloud.commands.status", {
	payload: Schema.Struct({
		workspaceId: Schema.String,
		commandId: Schema.String,
	}),
	success: CommandStatus,
	error: CloudWorkspaceOpError,
});
export const CloudCommandsWatchRpc = Rpc.make("cloud.commands.watch", {
	payload: Schema.Struct({
		workspaceId: Schema.String,
		afterRevision: Schema.Number,
	}),
	success: CommandChangePage,
	error: CloudWorkspaceOpError,
});
export const CloudCommandsCancelRpc = Rpc.make("cloud.commands.cancel", {
	payload: Schema.Struct({
		workspaceId: Schema.String,
		commandId: Schema.String,
	}),
	success: CommandStatus,
	error: CloudWorkspaceOpError,
});

export const CloudTranscriptCheckpointGetRpc = Rpc.make(
	"cloud.transcript.get",
	{
		payload: Schema.Struct({
			workspaceId: Schema.String,
			sessionId: AgentSessionId,
			cursor: Schema.optional(SessionStreamCursor),
		}),
		success: CloudTranscriptCheckpointResult,
		error: CloudWorkspaceOpError,
	},
);

export const CloudTranscriptMessagePageGetRpc = Rpc.make(
	"cloud.transcript.messages.page",
	{
		payload: Schema.Struct({
			workspaceId: Schema.String,
			sessionId: AgentSessionId,
			cursor: SessionStreamCursor,
			beforeSequence: Schema.Number,
		}),
		success: CloudTranscriptMessagePageResult,
		error: CloudWorkspaceOpError,
	},
);
