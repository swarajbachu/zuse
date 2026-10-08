import {
	ApiPaths,
	BillingCheckout,
	type BillingCheckoutRequest,
	BillingPortal,
	ChatSharingDefaults,
	ChatSharingState,
	type ChatSharingUpdate,
	CloudAccountImage,
	type CloudAccountImageBuildRequest,
	type CloudAccountImageDeleteRequest,
	CloudApiKey,
	CloudApiKeyCreated,
	CloudApiKeyList,
	type CloudAuthConfigureRequest,
	CloudAuthLoginOperation,
	type CloudAuthLoginStartRequest,
	type CloudAuthProvider,
	CloudAuthProviderStatus,
	CloudAuthStatus,
	CloudBillingSummary,
	CloudBillingUsagePage,
	CloudChatChanges,
	CloudChatList,
	type CloudCommandEnvelope,
	CloudGithubInstallResult,
	CloudGithubStatus,
	CloudProject,
	type CloudProjectConnectRequest,
	CloudProjectList,
	type CloudProviderConnectionInput,
	CloudProviderConnectionList,
	CloudProviderList,
	type CloudSnapshotImportRequest,
	CloudTranscriptCheckpointResult,
	CloudTranscriptMessagePageResult,
	CloudWorkspace,
	CloudWorkspaceConnection,
	type CloudWorkspaceCreateRequest,
	CloudWorkspaceDataKey,
	type CloudWorkspaceForkRequest,
	CloudWorkspaceLaunch,
	CloudWorkspaceList,
	type CloudWorkspaceOpError,
	CloudWorkspacePreviewRevoked,
	CloudWorkspacePreviewUrl,
	CloudWorkspaceSshAccess,
	CommandAcceptance,
	CommandChangePage,
	CommandStatus,
	type DeviceBridgeAction,
	DeviceBridgeResult,
	EntitlementList,
	type PluginRequest,
	PluginResponse,
	type SessionId,
	type SessionStreamCursor,
	WorkspaceSettings,
	type WorkspaceSettingsUpdate,
} from "@zuse/contracts";
import { Duration, Effect, Schedule, Schema, Stream } from "effect";

/** Account HTTP transport. No desktop, runtime credentials, or WebSocket needed. */
export type CloudControlRequest = <A>(
	path: string,
	schema: Schema.Codec<A, unknown>,
	method?: string,
	body?: unknown,
) => Effect.Effect<A, CloudWorkspaceOpError>;

export const makeCloudControlClient = (request: CloudControlRequest) => ({
	"cloud.snapshot.import": (input: CloudSnapshotImportRequest) =>
		request(ApiPaths.cloudSnapshotImport, CloudAccountImage, "POST", input),
	"plugins.request": (input: PluginRequest) =>
		request("/v1/plugins", PluginResponse, "POST", input),
	"cloud.providerConnections.list": () =>
		request(ApiPaths.cloudProviderConnections, CloudProviderConnectionList),
	"cloud.providerConnections.save": (input: CloudProviderConnectionInput) =>
		request(
			ApiPaths.cloudProviderConnections,
			CloudProviderConnectionList,
			"POST",
			input,
		),
	"cloud.providerConnections.disconnect": (input: { connectionId: string }) =>
		request(
			ApiPaths.cloudProviderConnections,
			CloudProviderConnectionList,
			"DELETE",
			input,
		),
	"cloud.providers": () => request(ApiPaths.cloudProviders, CloudProviderList),
	"cloud.projects.connect": (input: CloudProjectConnectRequest) =>
		request(ApiPaths.cloudProjects, CloudProject, "POST", input),
	"cloud.projects.remove": (input: { projectId: string }) =>
		request(ApiPaths.cloudProject(input.projectId), CloudProject, "DELETE"),
	"cloud.github.status": () => request(ApiPaths.cloudGithub, CloudGithubStatus),
	"cloud.github.install": () =>
		request(ApiPaths.cloudGithubInstall, CloudGithubInstallResult, "POST", {}),
	"cloud.github.disconnect": (input: { installationId: number }) =>
		request(
			ApiPaths.cloudGithubDisconnect(input.installationId),
			Schema.Struct({ ok: Schema.Boolean }),
			"DELETE",
		),
	"cloud.billing.summary": () =>
		request(ApiPaths.cloudBillingSummary, CloudBillingSummary),
	"cloud.billing.usage": (input: { cursor?: string; limit?: number }) =>
		request(
			`${ApiPaths.cloudBillingUsage}?${new URLSearchParams(
				Object.entries(input)
					.filter(([, v]) => v !== undefined)
					.map(([k, v]): [string, string] => [k, String(v)]),
			).toString()}`,
			CloudBillingUsagePage,
		),
	"cloud.billing.setCap": (input: {
		overageCapMicros: number;
		idempotencyKey: string;
	}) => request(ApiPaths.cloudBillingCap, CloudBillingSummary, "POST", input),
	"cloud.apiKeys.list": () => request(ApiPaths.cloudApiKeys, CloudApiKeyList),
	"cloud.apiKeys.create": (input: { name: string }) =>
		request(ApiPaths.cloudApiKeys, CloudApiKeyCreated, "POST", input),
	"cloud.apiKeys.revoke": (input: { keyId: string }) =>
		request(ApiPaths.cloudApiKey(input.keyId), CloudApiKey, "DELETE"),
	"cloud.workspaces.sshAccess": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceSshAccess(input.workspaceId),
			CloudWorkspaceSshAccess,
			"POST",
			input,
		),
	"cloud.workspaces.previewUrl": (input: {
		workspaceId: string;
		port: number;
	}) =>
		request(
			ApiPaths.cloudWorkspacePreviewUrl(input.workspaceId),
			CloudWorkspacePreviewUrl,
			"POST",
			{ port: input.port },
		),
	"cloud.workspaces.revokePreviewUrl": (input: {
		workspaceId: string;
		port?: number;
	}) =>
		request(
			ApiPaths.cloudWorkspacePreviewUrl(input.workspaceId),
			CloudWorkspacePreviewRevoked,
			"DELETE",
			{ port: input.port },
		),
	"machines.entitlements": () =>
		request(ApiPaths.billingEntitlements, EntitlementList),
	"machines.checkout": (input: BillingCheckoutRequest) =>
		request(ApiPaths.billingCheckout, BillingCheckout, "POST", input),
	"machines.billingPortal": () =>
		request(ApiPaths.billingPortal, BillingPortal, "POST", {}),
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
	"cloud.settings.get": () =>
		request(ApiPaths.cloudSettings, WorkspaceSettings),
	"cloud.settings.update": (input: WorkspaceSettingsUpdate) =>
		request(ApiPaths.cloudSettings, WorkspaceSettings, "PUT", input),
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
	"cloud.image.status": (input: { providerId?: string } = {}) =>
		request(
			`${ApiPaths.cloudAccountImage}${input.providerId === undefined ? "" : `?providerId=${encodeURIComponent(input.providerId)}`}`,
			CloudAccountImage,
		),
	"cloud.image.delete": (input: CloudAccountImageDeleteRequest) =>
		request(ApiPaths.cloudAccountImageDelete, CloudAccountImage, "POST", input),
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
	"cloud.workspaces.list": (input: { projectId?: string } = {}) =>
		request(
			input.projectId === undefined
				? ApiPaths.cloudWorkspaces
				: `${ApiPaths.cloudWorkspaces}?projectId=${encodeURIComponent(input.projectId)}`,
			CloudWorkspaceList,
		),
	"cloud.workspaces.get": (input: { workspaceId: string }) =>
		request(ApiPaths.cloudWorkspace(input.workspaceId), CloudWorkspace),
	"cloud.workspaces.watch": (input: {
		workspaceId: string;
		afterRevision?: number;
	}) =>
		streamCloudWorkspaceLifecycle(
			request(ApiPaths.cloudWorkspace(input.workspaceId), CloudWorkspace),
			input.afterRevision,
		),
	"cloud.sharing.get": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceSharing(input.workspaceId),
			ChatSharingState,
		),
	"cloud.sharing.update": ({
		workspaceId,
		...input
	}: ChatSharingUpdate & { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceSharing(workspaceId),
			ChatSharingState,
			"PUT",
			input,
		),
	"cloud.sharing.defaults.get": () =>
		request(ApiPaths.cloudSharingDefaults, ChatSharingDefaults),
	"cloud.sharing.defaults.update": (input: ChatSharingDefaults) =>
		request(ApiPaths.cloudSharingDefaults, ChatSharingDefaults, "PUT", input),
	"cloud.workspaces.create": (input: CloudWorkspaceCreateRequest) =>
		request(
			input.forkSource === undefined
				? ApiPaths.cloudWorkspaces
				: ApiPaths.cloudWorkspacesFork,
			CloudWorkspaceLaunch,
			"POST",
			input,
		),
	"cloud.workspaces.fork": (input: CloudWorkspaceForkRequest) =>
		request(ApiPaths.cloudWorkspacesFork, CloudWorkspaceLaunch, "POST", input),
	"cloud.workspaces.connect": (input: { workspaceId: string }) =>
		request(
			ApiPaths.cloudWorkspaceConnectionTicket(input.workspaceId),
			CloudWorkspaceConnection,
			"POST",
			{},
		),
	"cloud.workspaces.restart": (input: {
		workspaceId: string;
		commandId?: string;
	}) =>
		request(
			ApiPaths.cloudWorkspaceAction(input.workspaceId, "restart"),
			CloudWorkspace,
			"POST",
			input,
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
	"cloud.workspaces.archive": (input: {
		workspaceId: string;
		commandId?: string;
	}) =>
		request(
			ApiPaths.cloudWorkspaceAction(input.workspaceId, "archive"),
			CloudWorkspace,
			"POST",
			input,
		),
	"cloud.workspaces.unarchive": (input: {
		workspaceId: string;
		commandId?: string;
	}) =>
		request(
			ApiPaths.cloudWorkspaceAction(input.workspaceId, "unarchive"),
			CloudWorkspace,
			"POST",
			input,
		),
	"cloud.workspaces.delete": (input: {
		workspaceId: string;
		commandId?: string;
	}) =>
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

/** One revision-ordered lifecycle stream for desktop RPC and account HTTP clients. */
export const streamCloudWorkspaceLifecycle = <
	E extends { readonly code: string },
>(
	read: Effect.Effect<CloudWorkspace, E>,
	afterRevision?: number,
): Stream.Stream<CloudWorkspace, E> =>
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
				Schedule.while(
					({ input }: { input: E }) => input.code === "provider-unavailable",
				),
			),
		),
		Stream.mapAccum(
			() => afterRevision ?? -1,
			(appliedRevision, workspace) =>
				workspace.revision <= appliedRevision
					? [appliedRevision, []]
					: [workspace.revision, [workspace]],
		),
	);
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
