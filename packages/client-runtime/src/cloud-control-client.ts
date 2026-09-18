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
	CloudChatChanges,
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
	type DeviceBridgeAction,
	DeviceBridgeResult,
	type SessionId,
	type SessionStreamCursor,
} from "@zuse/contracts";
import { Effect, Schedule, type Schema, Stream } from "effect";

/** Account HTTP transport. No desktop, runtime credentials, or WebSocket needed. */
export type CloudControlRequest = <A>(
	path: string,
	schema: Schema.Codec<A, unknown>,
	method?: string,
	body?: unknown,
) => Effect.Effect<A, CloudWorkspaceOpError>;

export const makeCloudControlClient = (request: CloudControlRequest) => ({
	"deviceBridge.cloud": (input: {
		workspaceId: string;
		action: DeviceBridgeAction;
		targetDeviceId?: string;
	}) =>
		request(
			ApiPaths.cloudWorkspaceDeviceBridge(input.workspaceId),
			DeviceBridgeResult,
			"POST",
			{ action: input.action, targetDeviceId: input.targetDeviceId },
		),
	"cloud.chats.watch": (input: { cursor?: number }) =>
		streamCloudCatalogChanges(
			(cursor) =>
				request(
					`${ApiPaths.cloudChatChanges}${cursor === undefined ? "" : `?cursor=${cursor}`}`,
					CloudChatChanges,
				),
			input.cursor,
		),
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

/** Cursor polling belongs to the control transport, never to a UI component. */
export const streamCloudCatalogChanges = <E>(
	read: (cursor?: number) => Effect.Effect<CloudChatChanges, E>,
	initialCursor?: number,
): Stream.Stream<CloudChatChanges, E> =>
	Stream.unwrap(
		Effect.sync(() => {
			let cursor = initialCursor;
			return Stream.fromEffect(Effect.suspend(() => read(cursor))).pipe(
				Stream.repeat(Schedule.spaced("750 millis")),
				Stream.map((page) => {
					cursor = page.cursor;
					return page;
				}),
			);
		}),
	);
