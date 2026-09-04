import {
	ApiPaths,
	CloudAccountImage,
	type CloudAccountImageBuildRequest,
	type CloudAuthConfigureRequest,
	CloudAuthLoginOperation,
	type CloudAuthLoginStartRequest,
	type CloudAuthProvider,
	CloudAuthProviderStatus,
	CloudAuthStatus,
	CloudChatList,
	type CloudCommandEnvelope,
	CloudProjectList,
	CloudTranscriptCheckpointResult,
	CloudTranscriptMessagePageResult,
	CloudWorkspace,
	CloudWorkspaceConnection,
	type CloudWorkspaceCreateRequest,
	CloudWorkspaceDataKey,
	CloudWorkspaceLaunch,
	CloudWorkspaceList,
	type CloudWorkspaceOpError,
	CommandAcceptance,
	CommandChangePage,
	CommandStatus,
	type SessionId,
	type SessionStreamCursor,
} from "@zuse/contracts";
import type { Effect, Schema } from "effect";

/** Account HTTP transport. No desktop, runtime credentials, or WebSocket needed. */
export type CloudControlRequest = <A>(
	path: string,
	schema: Schema.Codec<A, unknown>,
	method?: string,
	body?: unknown,
) => Effect.Effect<A, CloudWorkspaceOpError>;

export const makeCloudControlClient = (request: CloudControlRequest) => ({
	"cloud.chats.list": (input: {
		projectId?: string;
		scope?: "active" | "archived" | "all";
	}) =>
		request(
			`${ApiPaths.cloudChats}?${new URLSearchParams(input).toString()}`,
			CloudChatList,
		),
	"cloud.projects.list": () =>
		request(ApiPaths.cloudProjects, CloudProjectList),
	"cloud.image.status": () =>
		request(ApiPaths.cloudAccountImage, CloudAccountImage),
	"cloud.image.build": (input: CloudAccountImageBuildRequest) =>
		request(ApiPaths.cloudAccountImageBuild, CloudAccountImage, "POST", input),
	"cloud.auth.status": () => request(ApiPaths.cloudAuth, CloudAuthStatus),
	"cloud.auth.provision": () =>
		request(ApiPaths.cloudAuthProvision, CloudAuthStatus, "POST", {}),
	"cloud.auth.login.start": (input: CloudAuthLoginStartRequest) =>
		request(
			ApiPaths.cloudAuthLoginStart,
			CloudAuthLoginOperation,
			"POST",
			input,
		),
	"cloud.auth.login.poll": (input: { operationId: string }) =>
		request(
			ApiPaths.cloudAuthLoginPoll(input.operationId),
			CloudAuthLoginOperation,
		),
	"cloud.auth.login.cancel": (input: { operationId: string }) =>
		request(
			ApiPaths.cloudAuthLoginCancel(input.operationId),
			CloudAuthLoginOperation,
			"POST",
			{},
		),
	"cloud.auth.configure": (input: CloudAuthConfigureRequest) =>
		request(
			ApiPaths.cloudAuthConfigure,
			CloudAuthProviderStatus,
			"POST",
			input,
		),
	"cloud.auth.disconnect": (input: { providerId: CloudAuthProvider }) =>
		request(
			ApiPaths.cloudAuthDisconnect(input.providerId),
			CloudAuthProviderStatus,
			"DELETE",
		),
	"cloud.workspaces.list": () =>
		request(ApiPaths.cloudWorkspaces, CloudWorkspaceList),
	"cloud.workspaces.get": (input: { workspaceId: string }) =>
		request(ApiPaths.cloudWorkspace(input.workspaceId), CloudWorkspace),
	"cloud.workspaces.create": (input: CloudWorkspaceCreateRequest) =>
		request(ApiPaths.cloudWorkspaces, CloudWorkspaceLaunch, "POST", input),
	"cloud.workspaces.connect": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceConnectionTicket(input.workspaceId),
			CloudWorkspaceConnection,
			"POST",
			{},
		),
	"cloud.workspaces.resume": (input: {
		workspaceId: string;
		commandId?: string;
		recoverRuntime?: boolean;
	}) =>
		request(
			ApiPaths.cloudWorkspaceAction(input.workspaceId, "resume"),
			CloudWorkspace,
			"POST",
			input,
		),
	"cloud.workspaces.archive": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceAction(input.workspaceId, "archive"),
			CloudWorkspace,
			"POST",
			input,
		),
	"cloud.workspaces.unarchive": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceAction(input.workspaceId, "unarchive"),
			CloudWorkspace,
			"POST",
			input,
		),
	"cloud.workspaces.delete": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceAction(input.workspaceId, "delete"),
			CloudWorkspace,
			"POST",
			input,
		),
	"cloud.commands.dataKey": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceDataKey(input.workspaceId),
			CloudWorkspaceDataKey,
		),
	"cloud.commands.enqueue": (input: CloudCommandEnvelope) =>
		request(
			ApiPaths.cloudWorkspaceCommands(input.workspaceId),
			CommandAcceptance,
			"POST",
			input,
		),
	"cloud.commands.status": (input: {
		workspaceId: string;
		commandId: string;
	}) =>
		request(
			ApiPaths.cloudWorkspaceCommand(input.workspaceId, input.commandId),
			CommandStatus,
		),
	"cloud.commands.watch": (input: {
		workspaceId: string;
		afterRevision: number;
	}) =>
		request(
			`${ApiPaths.cloudWorkspaceCommandWatch(input.workspaceId)}?afterRevision=${input.afterRevision}`,
			CommandChangePage,
		),
	"cloud.commands.cancel": (input: {
		workspaceId: string;
		commandId: string;
	}) =>
		request(
			ApiPaths.cloudWorkspaceCommand(input.workspaceId, input.commandId),
			CommandStatus,
			"DELETE",
		),
	"cloud.transcript.get": (input: {
		workspaceId: string;
		sessionId: SessionId;
		cursor?: SessionStreamCursor;
	}) =>
		request(
			`${ApiPaths.cloudWorkspaceTranscriptCheckpoint(input.workspaceId, input.sessionId)}${input.cursor === undefined ? "" : `?epoch=${encodeURIComponent(input.cursor.epoch)}&version=${input.cursor.version}`}`,
			CloudTranscriptCheckpointResult,
		),
	"cloud.transcript.messages.page": (input: {
		workspaceId: string;
		sessionId: SessionId;
		cursor: SessionStreamCursor;
		beforeSequence: number;
	}) =>
		request(
			`${ApiPaths.cloudWorkspaceTranscriptMessagePage(input.workspaceId, input.sessionId)}?epoch=${encodeURIComponent(input.cursor.epoch)}&version=${input.cursor.version}&beforeSequence=${input.beforeSequence}`,
			CloudTranscriptMessagePageResult,
		),
});

export type CloudControlClient = ReturnType<typeof makeCloudControlClient>;
type CloudCommandMethods = Pick<
	CloudControlClient,
	| "cloud.workspaces.get"
	| "cloud.commands.dataKey"
	| "cloud.commands.enqueue"
	| "cloud.commands.status"
	| "cloud.commands.watch"
	| "cloud.commands.cancel"
>;
export type CloudCommandControlClient = {
	[K in keyof CloudCommandMethods]: (
		...args: Parameters<CloudCommandMethods[K]>
	) => Effect.Effect<
		Effect.Success<ReturnType<CloudCommandMethods[K]>>,
		unknown
	>;
};
