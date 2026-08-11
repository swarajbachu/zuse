import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { AgentSessionId, ChatId } from "./ids.ts";

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
	"recovering",
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

export const CloudCredentialKind = Schema.Literals([
	"github",
	"claude",
	"codex",
]);
export type CloudCredentialKind = typeof CloudCredentialKind.Type;

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
	buildId: Schema.String,
	providerId: Schema.String,
	branch: Schema.String,
	baseRef: Schema.String,
	state: CloudWorkspaceState,
	desiredState: CloudWorkspaceDesiredState,
	statusCode: Schema.String,
	startupPhase: CloudWorkspaceStartupPhase,
	startupTimings: CloudWorkspaceStartupTimings,
	runtimeState: CloudWorkspaceRuntimeState,
	chatId: ChatId,
	initialSessionId: AgentSessionId,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	lastActivityAt: Schema.Number,
	warmRetentionDeadline: Schema.optional(Schema.Number),
	recoveryAvailable: Schema.Boolean,
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
	credential: Schema.String,
	expiresAt: Schema.Number,
}) {}

export class CloudChatEvent extends Schema.Class<CloudChatEvent>(
	"CloudChatEvent",
)({
	sequence: Schema.Number,
	eventId: Schema.String,
	streamId: Schema.String,
	streamVersion: Schema.Number,
	type: Schema.String,
	payloadJson: Schema.String,
	createdAt: Schema.Number,
}) {}

export class CloudChatHistory extends Schema.Class<CloudChatHistory>(
	"CloudChatHistory",
)({
	workspaceId: Schema.String,
	chatId: ChatId,
	initialSessionId: AgentSessionId,
	firstMessage: Schema.optional(Schema.String),
	commandState: Schema.Literals([
		"queued",
		"claimed",
		"acknowledged",
		"failed",
	]),
	events: Schema.Array(CloudChatEvent),
	cursor: Schema.Number,
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
	credentialKinds: Schema.optional(Schema.Array(CloudCredentialKind)),
	secretBindings: Schema.optional(Schema.Array(Schema.String)),
	permissions: Schema.optional(Schema.Array(Schema.String)),
	firstMessage: Schema.optional(Schema.String),
	idempotencyKey: Schema.String,
}) {}

export class CloudWorkspaceActionRequest extends Schema.Class<CloudWorkspaceActionRequest>(
	"CloudWorkspaceActionRequest",
)({ workspaceId: Schema.String }) {}

export class CloudCredentialConnection extends Schema.Class<CloudCredentialConnection>(
	"CloudCredentialConnection",
)({
	kind: CloudCredentialKind,
	state: Schema.Literals(["connected", "disconnected", "error"]),
	version: Schema.Number,
	accountLabel: Schema.optional(Schema.String),
	updatedAt: Schema.Number,
}) {}

export class CloudCredentialList extends Schema.Class<CloudCredentialList>(
	"CloudCredentialList",
)({ credentials: Schema.Array(CloudCredentialConnection) }) {}

export class CloudCredentialConnectRequest extends Schema.Class<CloudCredentialConnectRequest>(
	"CloudCredentialConnectRequest",
)({
	kind: CloudCredentialKind,
	credentialType: Schema.Literals([
		"api-key",
		"oauth-token",
		"repository-token",
		"native-store",
	]),
	secret: Schema.String,
	accountLabel: Schema.optional(Schema.String),
}) {}

export class CloudCredentialDisconnectRequest extends Schema.Class<CloudCredentialDisconnectRequest>(
	"CloudCredentialDisconnectRequest",
)({ kind: CloudCredentialKind }) {}

export class CloudWorkspaceOpError extends Schema.TaggedErrorClass<CloudWorkspaceOpError>()(
	"CloudWorkspaceOpError",
	{
		code: Schema.Literals([
			"not-found",
			"not-allowed",
			"invalid-request",
			"entitlement-required",
			"provider-unavailable",
			"project-not-ready",
			"branch-in-use",
			"conflict",
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
export const CloudProjectsPrepareRpc = Rpc.make("cloud.projects.prepare", {
	payload: CloudProjectPrepareRequest,
	success: CloudProjectBuild,
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
export const CloudChatsHistoryRpc = Rpc.make("cloud.chats.history", {
	payload: CloudWorkspaceActionRequest,
	success: CloudChatHistory,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesPauseRpc = Rpc.make("cloud.workspaces.pause", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesResumeRpc = Rpc.make("cloud.workspaces.resume", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesArchiveRpc = Rpc.make("cloud.workspaces.archive", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
export const CloudWorkspacesDeleteRpc = Rpc.make("cloud.workspaces.delete", {
	payload: CloudWorkspaceActionRequest,
	success: CloudWorkspace,
	error: CloudWorkspaceOpError,
});
export const CloudCredentialsListRpc = Rpc.make("cloud.credentials.list", {
	payload: Schema.Void,
	success: CloudCredentialList,
	error: CloudWorkspaceOpError,
});
export const CloudCredentialsImportLocalRpc = Rpc.make(
	"cloud.credentials.importLocal",
	{
		payload: Schema.Struct({ kind: CloudCredentialKind }),
		success: CloudCredentialConnection,
		error: CloudWorkspaceOpError,
	},
);
export const CloudCredentialsDisconnectRpc = Rpc.make(
	"cloud.credentials.disconnect",
	{
		payload: CloudCredentialDisconnectRequest,
		success: CloudCredentialConnection,
		error: CloudWorkspaceOpError,
	},
);
