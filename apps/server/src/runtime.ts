import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { MemoizeRpcs } from "@zuse/contracts";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitServiceLive } from "@zuse/git/git-service-live";
import { GitHubClient, GitHubClientService } from "@zuse/git/github-client";
import { WorktreeServiceLive } from "@zuse/git/worktree-service-live";
import { Effect, Layer, Schedule } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql";
import {
	AccountAccessProcessLive,
	AccountAccessServiceLive,
} from "./account-access/service.ts";
import { AnalyticsServiceLive } from "./analytics/layers/analytics-service.ts";
import { ApiActivityPublisherLive } from "./api/activity-publisher.ts";
import {
	ApiLinkService,
	autoLinkUntilLinked,
	makeApiLinkServiceLive,
	makeDisabledApiLinkService,
	retireUntilRetired,
} from "./api/api-link-service.ts";
import {
	type CloudEnrollmentConfig,
	makeCloudEnrollmentLayer,
} from "./api/cloud-enrollment.ts";
import {
	type CloudWorkspaceRuntimeConfig,
	makeCloudWorkspaceRuntimeLayer,
} from "./api/cloud-workspace-runtime.ts";
import { ManagedTunnelRuntimeLive } from "./api/managed-tunnel-runtime.ts";
import { AppPaths, type TelemetryIdentity } from "./app-paths.ts";
import { AttachmentServiceLive } from "./attachment/layers/attachment-service.ts";
import { AuthServiceLive } from "./auth/layers/auth-service.ts";
import { SessionStoreLive } from "./auth/layers/session-store.ts";
import { AuthShell } from "./auth/services/auth-shell.ts";
import { AutomationService } from "./automation/service.ts";
import { AutomationWorkerLive } from "./automation/worker.ts";
import { ConfigStoreServiceLive } from "./config-store/layers/config-store-service.ts";
import { ConversationState } from "./conversation/core/conversation-state.ts";
import { ConversationServicesLive } from "./conversation/layers/conversation-services.ts";
import { PendingWorkspaceExecutionPolicy } from "./conversation/services/workspace-execution-policy.ts";
import { prepareIdleShutdown } from "./desktop-engine/idle.ts";
import { DeviceBridgeServiceLive } from "./device-bridge/service.ts";
import { DiagnosticsServiceLive } from "./diagnostics/layers/diagnostics-service.ts";
import { ExternalThreadServiceLive } from "./external-thread/layers/external-thread-service.ts";
import { FsServiceLive } from "./fs/layers/fs-service.ts";
import { runtimeGitHubCredential } from "./git/github-credentials.ts";
import { RepositoryLocatorLive } from "./git/repository-locator-live.ts";
import { HandlersLayer } from "./handlers.ts";
import { RuntimeModelConnections } from "./harness/account-vault.ts";
import { modelConnectionsLayer } from "./harness/connections-layer.ts";
import { HarnessProviderLive } from "./harness/provider.ts";
import { LanAuthServiceLive } from "./lan-auth/layers/lan-auth-service.ts";
import { RpcAuthorizationLive } from "./lan-auth/layers/rpc-authorization.ts";
import type { LanAuthPolicy } from "./lan-auth/policy.ts";
import {
	LanAuthConfig,
	LanAuthService,
} from "./lan-auth/services/lan-auth-service.ts";
import { MachineControlServiceLive } from "./machine/machine-control-service.ts";
import {
	MachineHostServiceLive,
	MachinePrivateEndpointPublisherLive,
} from "./machine/machine-host-service.ts";
import { MachineResourceServiceLive } from "./machine/machine-resource-service.ts";
import { MachineRuntimeRole } from "./machine/machine-runtime-role.ts";
import { RuntimeCloudControl } from "./machine/runtime-cloud-control.ts";
import { ModelCatalogPollerLive } from "./model-catalog/layers/model-catalog-poller.ts";
import { ModelCatalogServiceLive } from "./model-catalog/layers/model-catalog-service.ts";
import { RuntimePerformanceMonitorLive } from "./observability/runtime-performance-monitor.ts";
import { TelemetryObservabilityLive } from "./observability/telemetry-layer.ts";
import { TelemetryStoreLive } from "./observability/telemetry-store.ts";
import { runLifecycleBackfill } from "./persistence/backfill.ts";
import { importWorkspacesJson } from "./persistence/import-workspaces.ts";
import { MigrationsLive } from "./persistence/migrations.ts";
import { NdjsonLoggerLive } from "./persistence/ndjson-logger.ts";
import { SqliteLive } from "./persistence/sqlite.ts";
import { PokemonServiceLive } from "./pokemon/layers/pokemon-service.ts";
import { AcpAgentServiceLive } from "./provider/acp/service.ts";
import { BrowserBridgeServiceLive } from "./provider/layers/browser-bridge-service.ts";
import { PermissionServiceLive } from "./provider/layers/permission-service.ts";
import { ProviderServiceLive } from "./provider/layers/provider-service.ts";
import type { CredentialsService } from "./provider/services/credentials-service.ts";
import { providerAccountsLayer } from "./provider/services/provider-accounts.ts";
import { ProviderService } from "./provider/services/provider-service.ts";
import {
	makeRuntimeGitExecution,
	RuntimeGitExecution,
} from "./provider/services/runtime-git-execution.ts";
import {
	makeRuntimeProviderCredentials,
	RuntimeProviderCredentials,
} from "./provider/services/runtime-provider-credentials.ts";
import { TitleGeneratorLive } from "./provider/title-generator.ts";
import { PtyServiceLive } from "./pty/layers/pty-service.ts";
import { RepositorySettingsServiceLive } from "./repository-settings/layers/repository-settings-service.ts";
import {
	SimulatorServiceLive,
	SimulatorToolsLive,
} from "./simulators/service.ts";
import { SkillBridgeLive } from "./skill/layers/skill-bridge.ts";
import { SkillDiscoveryServiceLive } from "./skill/layers/skill-discovery.ts";
import { UsageLimitsPollerLive } from "./usage/limits/poller.ts";
import { FileSearchServiceLive } from "./workspace/layers/file-search.ts";
import { ProjectScaffoldLive } from "./workspace/layers/project-scaffold-live.ts";
import { WorkspaceServiceLive } from "./workspace/layers/workspace-service.ts";
import { FolderPicker } from "./workspace/services/folder-picker.ts";
import {
	PokemonAssignmentLive,
	ProjectLocatorLive,
	RepositorySettingsReaderLive,
	WorktreeDecorationLive,
	WorktreeNameAllocatorLive,
} from "./worktree/worktree-ports-live.ts";

/**
 * Inputs to `makeMainLayer`. The host shell (today: Electron in
 * `apps/desktop`) supplies these — `apps/server` itself imports nothing
 * UI-toolkit-specific. See ADR 0007 for the rules that make WS extraction
 * cheap later.
 *
 * - `userData`: where persistence files (zuse.sqlite, OS keychain) live.
 *   Electron resolves this from `app.getPath("userData")`; a headless
 *   server resolves it from `XDG_DATA_HOME` or a CLI flag.
 * - `folderPicker`: a callback returning the user-chosen path. Electron
 *   wraps `dialog.showOpenDialog`; a headless server returns null (or
 *   forwards the prompt to a connected client).
 * - `serverProtocol`: the RPC transport. Electron supplies an in-process
 *   IPC protocol; a headless server supplies a WebSocket protocol.
 * - `additionalServerProtocols`: optional secondary transports that serve the
 *   same RPC handlers from the same runtime, for example Electron IPC plus a
 *   protected local WebSocket origin for api tunnels.
 * - `authShell`: the WorkOS OAuth deep-link seam. Electron opens the system
 *   browser via `shell.openExternal` and funnels the `zuse://auth/callback`
 *   deep link back in; a headless server supplies a loopback-HTTP variant.
 */
export interface MainLayerDeps {
	readonly userData: string;
	readonly telemetryIdentity?: TelemetryIdentity;
	readonly folderPicker: typeof FolderPicker.Service;
	readonly serverProtocol: Layer.Layer<
		RpcServer.Protocol,
		never,
		LanAuthService | AttachmentService
	>;
	readonly additionalServerProtocols?: ReadonlyArray<
		Layer.Layer<RpcServer.Protocol, never, LanAuthService | AttachmentService>
	>;
	readonly authShell: typeof AuthShell.Service;
	readonly credentialsLayer: Layer.Layer<CredentialsService, never, AppPaths>;
	/** Desktop keychain capability; headless runtimes must not import native keychain modules. */
	readonly modelConnectionMasterKey?: (create?: boolean) => Promise<Buffer>;
	readonly cloudEnrollment?: CloudEnrollmentConfig;
	readonly cloudWorkspaceRuntime?: CloudWorkspaceRuntimeConfig;
	readonly machineRuntimeRole?: "control-plane" | "cloud-environment";
	readonly lanAuth?: {
		readonly policy: LanAuthPolicy;
		readonly advertisedHost?: string | null;
		readonly port?: number | null;
		readonly pairingBootstrap?: boolean;
		readonly icloudTrustRecordId?: string;
		readonly icloudTrustSecret?: string;
		readonly transportCertificatePin?: string;
		readonly onNearbyPairingRequest?: (
			request: import("./lan-auth/services/lan-auth-service.ts").NearbyPairingRequest,
		) => void;
	};
	readonly openHostSession?: (
		sessionId: string,
		chatId: string,
	) => void | Promise<void>;
	readonly autoApiLink?: {
		readonly apiUrl: string;
		readonly label?: string;
	};
	/** Resume a saved computer registration and tunnel on boot. Defaults to true. */
	readonly resumeApiLink?: boolean;
	/**
	 * Remove a saved computer registration from the account on boot. For
	 * runtimes that must not publish themselves, so registrations they made
	 * earlier don't linger in the account as offline computers.
	 */
	readonly retireApiLink?: boolean;
	readonly apiEnabled?: boolean;
	readonly cliAccess?: {
		readonly path: string;
		readonly wsUrl: string;
	};
	/** Server-derived activity; native hosts must not depend on a connected renderer. */
	readonly onActiveTurns?: (count: number) => void;
	readonly onPrepareShutdown?: (prepare: () => Promise<boolean>) => () => void;
	readonly onStartupPhase?: (
		phase: "migrations-ready" | "projectors-ready",
	) => void;
}

/**
 * Compose every Layer the server needs and return a single Layer the host
 * can run via `Layer.launch`. Pure factory — no electron, no transport
 * wiring inside this module.
 */
export const makeMainLayer = (deps: MainLayerDeps) => {
	const AppPathsLayer = Layer.succeed(AppPaths, {
		userData: deps.userData,
		telemetryIdentity: deps.telemetryIdentity,
	});
	const TelemetryStoreLayer = TelemetryStoreLive.pipe(
		Layer.provide(AppPathsLayer),
	);
	const TelemetryLayer = TelemetryObservabilityLive.pipe(
		Layer.provide(TelemetryStoreLayer),
	);
	const RuntimePerformanceLayer = RuntimePerformanceMonitorLive.pipe(
		Layer.provide(TelemetryStoreLayer),
	);
	const FolderPickerLayer = Layer.succeed(FolderPicker, deps.folderPicker);
	const AuthShellLayer = Layer.succeed(AuthShell, deps.authShell);
	const lanAuthConfig = {
		policy: deps.lanAuth?.policy ?? "local",
		advertisedHost: deps.lanAuth?.advertisedHost ?? null,
		port: deps.lanAuth?.port ?? null,
		pairingBootstrap: deps.lanAuth?.pairingBootstrap ?? false,
		icloudTrustRecordId: deps.lanAuth?.icloudTrustRecordId,
		icloudTrustSecret: deps.lanAuth?.icloudTrustSecret,
		transportCertificatePin: deps.lanAuth?.transportCertificatePin,
		onNearbyPairingRequest: deps.lanAuth?.onNearbyPairingRequest,
		openHostSession: deps.openHostSession,
	};
	const LanAuthConfigLayer = Layer.succeed(LanAuthConfig, lanAuthConfig);

	const SqliteLayer = SqliteLive.pipe(Layer.provide(AppPathsLayer));
	const MigratedSqlite = SqliteLayer.pipe(
		Layer.provideMerge(
			MigrationsLive.pipe(
				Layer.provide(SqliteLayer),
				Layer.provide(NodeServices.layer),
			),
		),
	);
	const BackfilledSqlite = MigratedSqlite.pipe(
		Layer.provideMerge(
			Layer.effectDiscard(runLifecycleBackfill).pipe(
				Layer.provide(MigratedSqlite),
			),
		),
	);
	const startupMarker = (phase: "migrations-ready" | "projectors-ready") =>
		Layer.effectDiscard(Effect.sync(() => deps.onStartupPhase?.(phase)));
	const MigrationsReady = startupMarker("migrations-ready").pipe(
		Layer.provide(MigratedSqlite),
	);

	const ImportShim = Layer.effectDiscard(importWorkspacesJson).pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
		Layer.provide(AppPathsLayer),
	);

	const LanAuthLayer = LanAuthServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(LanAuthConfigLayer),
	);
	const cliAccess = deps.cliAccess;
	const CliAccessLayer =
		cliAccess === undefined
			? Layer.empty
			: Layer.effectDiscard(
					Effect.gen(function* () {
						const auth = yield* LanAuthService;
						const existing = yield* auth.listTokens();
						for (const token of existing) {
							if (
								(token.label === "Local CLI" ||
									token.label === "Development CLI") &&
								token.revokedAt === undefined
							)
								yield* auth.revokeToken(token.id);
						}
						const minted = yield* auth.mintToken("Local CLI");
						const { path: target, wsUrl } = cliAccess;
						const temporary = `${target}.${process.pid}.tmp`;
						yield* Effect.promise(async () => {
							await mkdir(dirname(target), { recursive: true });
							await writeFile(
								temporary,
								`${JSON.stringify({ schemaVersion: 1, wsUrl, token: minted.token, cloudWorkspaceId: deps.cloudWorkspaceRuntime?.workspaceId })}\n`,
								{ mode: 0o600 },
							);
							await chmod(temporary, 0o600);
							await rename(temporary, target);
						});
					}),
				).pipe(Layer.provide(LanAuthLayer));
	const ManagedTunnelLayer = ManagedTunnelRuntimeLive.pipe(
		Layer.provide(NodeServices.layer),
		Layer.provide(AppPathsLayer),
		Layer.provide(TelemetryStoreLayer),
	);

	const WorkspaceLayer = WorkspaceServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(ImportShim),
		Layer.provide(NodeServices.layer),
	);

	const RepositorySettingsLayer = RepositorySettingsServiceLive.pipe(
		Layer.provide(MigratedSqlite),
	);

	const PokemonLayer = PokemonServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(NodeServices.layer),
	);

	const WorktreePortsLayer = Layer.mergeAll(
		ProjectLocatorLive.pipe(Layer.provide(WorkspaceLayer)),
		RepositorySettingsReaderLive.pipe(Layer.provide(RepositorySettingsLayer)),
		WorktreeNameAllocatorLive,
		WorktreeDecorationLive,
		PokemonAssignmentLive.pipe(Layer.provide(PokemonLayer)),
	);

	const GitHubLayer = Layer.effect(
		GitHubClientService,
		Effect.acquireRelease(
			Effect.sync(
				() => new GitHubClient({ resolveCredential: runtimeGitHubCredential }),
			),
			(client) => Effect.sync(() => client.close()),
		),
	);
	const WorktreeLayer = WorktreeServiceLive.pipe(
		Layer.provide(GitHubLayer),
		Layer.provide(WorktreePortsLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	const GitLayer = GitServiceLive.pipe(
		Layer.provide(GitHubLayer),
		Layer.provide(
			RepositoryLocatorLive.pipe(
				Layer.provide(WorkspaceLayer),
				Layer.provide(WorktreeLayer),
			),
		),
		Layer.provide(NodeServices.layer),
	);

	const PtyLayer = PtyServiceLive;

	const ConfigStoreLayer = ConfigStoreServiceLive.pipe(
		Layer.provide(AppPathsLayer),
		Layer.provide(NodeServices.layer),
	);
	const CredentialsLayer = deps.credentialsLayer.pipe(
		Layer.provide(AppPathsLayer),
	);
	const EnrolledLanAuthLayer = LanAuthLayer.pipe(
		Layer.provideMerge(
			makeCloudEnrollmentLayer(deps.cloudEnrollment).pipe(
				Layer.provide(LanAuthLayer),
				Layer.provide(ManagedTunnelLayer),
			),
		),
	);
	const MachineRuntimeRoleLayer = Layer.succeed(
		MachineRuntimeRole,
		deps.machineRuntimeRole ?? "control-plane",
	);

	const AuthLayer = AuthServiceLive.pipe(
		Layer.provide(CredentialsLayer),
		Layer.provide(SessionStoreLive),
		Layer.provide(AuthShellLayer),
	);

	const AnalyticsLayer = AnalyticsServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(AuthLayer),
		Layer.provide(NodeServices.layer),
	);

	const FsLayer = FsServiceLive.pipe(
		Layer.provide(WorkspaceLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(GitLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	const FileSearchLayer = FileSearchServiceLive.pipe(
		Layer.provide(WorkspaceLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(GitLayer),
		Layer.provide(NodeServices.layer),
	);

	const ProjectScaffoldLayer = ProjectScaffoldLive.pipe(
		Layer.provide(NodeServices.layer),
	);

	const SessionDomainLayer = SessionDomain.layer.pipe(
		Layer.provide(BackfilledSqlite),
		Layer.provide(NodeServices.layer),
	);
	const ChatDomainLayer = ChatDomain.layer.pipe(
		Layer.provide(BackfilledSqlite),
		Layer.provide(NodeServices.layer),
	);
	const SessionQueriesLayer = SqlSessionQueries.layer.pipe(
		Layer.provide(BackfilledSqlite),
	);

	const AutomationLayer = AutomationService.layer.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(CredentialsLayer),
	);

	const ActivityLayer =
		deps.onActiveTurns === undefined
			? Layer.empty
			: Layer.effectDiscard(
					Effect.gen(function* () {
						const queries = yield* SqlSessionQueries;
						yield* queries.activeTurnCount.pipe(
							Effect.tap((count) =>
								Effect.sync(() => deps.onActiveTurns?.(count)),
							),
							Effect.catchCause((cause) =>
								Effect.logWarning("Could not observe engine activity", cause),
							),
							Effect.repeat(Schedule.spaced("2 seconds")),
							Effect.forkScoped,
						);
					}),
				).pipe(Layer.provide(SessionQueriesLayer));

	const PermissionLayer = PermissionServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(SessionDomainLayer),
	);

	const BrowserBridgeLayer = BrowserBridgeServiceLive;
	const SimulatorLayer = SimulatorServiceLive.pipe(
		Layer.provide(AppPathsLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(MigratedSqlite),
	);
	const SimulatorAgentLayer = SimulatorToolsLive.pipe(
		Layer.provide(SimulatorLayer),
	);

	const AttachmentLayer = AttachmentServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(NodeServices.layer),
	);

	const RuntimeGitExecutionLayer = Layer.succeed(
		RuntimeGitExecution,
		makeRuntimeGitExecution(deps.cloudWorkspaceRuntime !== undefined),
	);
	const RuntimeProviderCredentialsLayer = Layer.succeed(
		RuntimeProviderCredentials,
		makeRuntimeProviderCredentials(),
	);

	const RuntimeModelConnectionsLayer = Layer.succeed(RuntimeModelConnections, {
		current: null,
	});
	const ModelConnectionsLayer = modelConnectionsLayer(
		deps.telemetryIdentity?.kind === "desktop" &&
			process.platform !== "win32" &&
			deps.machineRuntimeRole !== "cloud-environment",
		deps.cloudWorkspaceRuntime !== undefined,
		deps.modelConnectionMasterKey,
	).pipe(
		Layer.provide(CredentialsLayer),
		Layer.provide(AppPathsLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(AuthLayer),
		Layer.provide(EnrolledLanAuthLayer),
		Layer.provide(RuntimeModelConnectionsLayer),
	);

	const SkillDiscoveryLayer = SkillDiscoveryServiceLive.pipe(
		Layer.provide(ConfigStoreLayer),
		Layer.provide(NodeServices.layer),
	);
	const HarnessProviderLayer = HarnessProviderLive.pipe(
		Layer.provide(SimulatorAgentLayer),
		Layer.provide(SkillDiscoveryLayer),
		Layer.provide(ModelConnectionsLayer),
		Layer.provide(AppPathsLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(PermissionLayer),
		Layer.provide(AttachmentLayer),
	);
	const ProviderAccountsLayer = providerAccountsLayer(
		deps.cloudWorkspaceRuntime === undefined,
	).pipe(Layer.provide(AppPathsLayer), Layer.provide(MigratedSqlite));
	const AcpAgentLayer = AcpAgentServiceLive.pipe(
		Layer.provide(NodeServices.layer),
		Layer.provide(AppPathsLayer),
		Layer.provide(CredentialsLayer),
	);
	const ModelCatalogLayer = ModelCatalogServiceLive.pipe(
		Layer.provide(AcpAgentLayer),
		Layer.provide(HarnessProviderLayer),
		Layer.provide(AppPathsLayer),
		Layer.provide(CredentialsLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(NodeServices.layer),
	);

	const ProviderLayer = ProviderServiceLive.pipe(
		Layer.provide(AutomationLayer),
		Layer.provide(SimulatorAgentLayer),
		Layer.provide(ProviderAccountsLayer),
		Layer.provide(AcpAgentLayer),
		Layer.provide(HarnessProviderLayer),
		Layer.provide(ModelCatalogLayer),
		Layer.provide(CredentialsLayer),
		Layer.provide(RuntimeProviderCredentialsLayer),
		Layer.provide(RuntimeGitExecutionLayer),
		Layer.provide(WorkspaceLayer),
		Layer.provide(PermissionLayer),
		Layer.provide(AttachmentLayer),
		Layer.provide(BrowserBridgeLayer),

		Layer.provide(ConfigStoreLayer),

		Layer.provide(SkillDiscoveryLayer),
		Layer.provide(AnalyticsLayer),
		Layer.provide(NodeServices.layer),
	);
	const ShutdownLayer =
		deps.onPrepareShutdown === undefined
			? Layer.empty
			: Layer.effectDiscard(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const domain = yield* SessionDomain;
						const queries = yield* SqlSessionQueries;
						const provider = yield* ProviderService;
						const prepare = prepareIdleShutdown({
							sql,
							domain,
							activeTurnCount: queries.activeTurnCount,
							hasSession: provider.hasSession,
						});
						yield* Effect.acquireRelease(
							Effect.sync(() =>
								deps.onPrepareShutdown?.(() => Effect.runPromise(prepare)),
							),
							(stop) => Effect.sync(() => stop?.()),
						);
					}),
				).pipe(
					Layer.provide(
						Layer.mergeAll(
							BackfilledSqlite,
							SessionDomainLayer,
							SessionQueriesLayer,
							ProviderLayer,
						),
					),
				);

	const NdjsonLoggerLayer = NdjsonLoggerLive.pipe(Layer.provide(AppPathsLayer));

	const TitleGeneratorLayer = TitleGeneratorLive.pipe(
		Layer.provide(ProviderLayer),
	);

	const ProjectorCatchup = Layer.effectDiscard(
		Effect.gen(function* () {
			const domain = yield* SessionDomain;
			yield* domain.catchUp;
			const chats = yield* ChatDomain;
			yield* chats.catchUp;
		}),
	).pipe(
		Layer.provide(SessionDomainLayer),
		Layer.provide(ChatDomainLayer),
		Layer.provide(SessionQueriesLayer),
	);
	const ProjectorsReady = startupMarker("projectors-ready").pipe(
		Layer.provide(ProjectorCatchup),
	);

	const ApiActivityPublisherLayer = ApiActivityPublisherLive.pipe(
		Layer.provide(EnrolledLanAuthLayer),
	);

	const RuntimeCloudControlLayer = Layer.succeed(RuntimeCloudControl, {
		current: null,
	});
	const MachineControlLayer = MachineControlServiceLive.pipe(
		Layer.provide(AppPathsLayer),
		Layer.provide(RuntimeCloudControlLayer),
		Layer.provide(AuthLayer),
		Layer.provide(MachineRuntimeRoleLayer),
	);
	const MachineHostLayer = MachineHostServiceLive.pipe(
		Layer.provide(AppPathsLayer),
		Layer.provide(
			MachinePrivateEndpointPublisherLive.pipe(
				Layer.provide(EnrolledLanAuthLayer),
			),
		),
		Layer.provide(MachineRuntimeRoleLayer),
	);
	const AccountAccessLayer = AccountAccessServiceLive.pipe(
		Layer.provide(AccountAccessProcessLive),
		Layer.provide(CredentialsLayer),
		Layer.provide(AppPathsLayer),
		Layer.provide(MachineRuntimeRoleLayer),
	);

	const ExecutionPolicyLayer =
		deps.cloudWorkspaceRuntime === undefined
			? Layer.empty
			: PendingWorkspaceExecutionPolicy;
	const ConversationServicesLayer = ConversationServicesLive.pipe(
		Layer.provide(AutomationLayer),
		Layer.provide(ExecutionPolicyLayer),
		Layer.provide(ConversationState.layer),
		Layer.provide(ProviderLayer),
		Layer.provide(ModelCatalogLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(RepositorySettingsLayer),
		Layer.provide(PtyLayer),

		Layer.provide(GitLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(TitleGeneratorLayer),
		Layer.provide(ApiActivityPublisherLayer),
		Layer.provide(ProjectorCatchup),
		Layer.provide(SessionDomainLayer),
		Layer.provide(ChatDomainLayer),
		Layer.provide(SessionQueriesLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NdjsonLoggerLayer),
		Layer.provide(NodeServices.layer),
	);
	const CloudWorkspaceRuntimeLayer = makeCloudWorkspaceRuntimeLayer(
		deps.cloudWorkspaceRuntime,
	).pipe(
		Layer.provide(RuntimeCloudControlLayer),
		Layer.provide(ExecutionPolicyLayer),
		Layer.provide(RuntimeModelConnectionsLayer),
		Layer.provide(CredentialsLayer),
		Layer.provide(AttachmentLayer),
		Layer.provide(RuntimeProviderCredentialsLayer),
		Layer.provide(RuntimeGitExecutionLayer),
		Layer.provide(EnrolledLanAuthLayer),
		Layer.provide(WorkspaceLayer),
		Layer.provide(ConversationServicesLayer),
		Layer.provide(SessionDomainLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	const DiagnosticsLayer = DiagnosticsServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(ProviderLayer),
		Layer.provide(TelemetryStoreLayer),
	);

	const ExternalThreadLayer = ExternalThreadServiceLive.pipe(
		Layer.provide(ModelCatalogLayer),
		Layer.provide(WorkspaceLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(ConversationServicesLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	const SkillBridgeLayer = SkillBridgeLive.pipe(
		Layer.provide(SkillDiscoveryLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(ConversationServicesLayer),
		Layer.provide(WorkspaceLayer),
	);

	const ApiLinkLayer =
		deps.apiEnabled === false
			? makeDisabledApiLinkService(lanAuthConfig)
			: makeApiLinkServiceLive({ resumeExistingLink: deps.resumeApiLink }).pipe(
					Layer.provide(AccountAccessLayer),
					Layer.provide(EnrolledLanAuthLayer),
					Layer.provide(LanAuthConfigLayer),
					Layer.provide(AuthLayer),

					Layer.provide(ManagedTunnelLayer),
					Layer.provide(AppPathsLayer),
					Layer.provide(TelemetryStoreLayer),
				);
	const autoApiLink = deps.autoApiLink;

	const AutoApiLinkLayer =
		autoApiLink === undefined
			? Layer.empty
			: Layer.effectDiscard(
					Effect.gen(function* () {
						const api = yield* ApiLinkService;
						yield* autoLinkUntilLinked(
							Effect.gen(function* () {
								const status = yield* api.status();
								if (!status.linked) {
									yield* api.link(autoApiLink);
								}
							}),
						).pipe(Effect.forkScoped({ startImmediately: true }));
					}),
				).pipe(Layer.provide(ApiLinkLayer));

	const RetireApiLinkLayer =
		deps.retireApiLink === true && autoApiLink === undefined
			? Layer.effectDiscard(
					Effect.gen(function* () {
						const api = yield* ApiLinkService;
						yield* retireUntilRetired(api.retire()).pipe(
							Effect.forkScoped({ startImmediately: true }),
						);
					}),
				).pipe(Layer.provide(ApiLinkLayer))
			: Layer.empty;

	const HandlerSupportLayer = Layer.mergeAll(
		AppPathsLayer,
		MigratedSqlite,
		NodeServices.layer,
		LanAuthConfigLayer,

		AuthLayer,
	);

	const DeviceBridgeLayer = DeviceBridgeServiceLive.pipe(
		Layer.provide(EnrolledLanAuthLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(AuthLayer),
	);

	const HandlerDomainLayer = Layer.mergeAll(
		AutomationLayer,
		ProviderAccountsLayer,
		AcpAgentLayer,
		DeviceBridgeLayer,
		SimulatorLayer,
		WorkspaceLayer,
		PtyLayer,
		GitLayer,
		WorktreeLayer,
		WorktreeNameAllocatorLive,
		RepositorySettingsLayer,
		PokemonLayer,
		ConfigStoreLayer,
		AnalyticsLayer,
		FsLayer,
		FileSearchLayer,
		ProjectScaffoldLayer,
		ProviderLayer,
		ModelCatalogLayer,
		SessionDomainLayer,
		SessionQueriesLayer,
		ConversationServicesLayer,
		PermissionLayer,
		AttachmentLayer,
		BrowserBridgeLayer,

		CredentialsLayer,
		SkillBridgeLayer,
		DiagnosticsLayer,
		EnrolledLanAuthLayer,
		ApiLinkLayer,
		ExternalThreadLayer,
		ModelConnectionsLayer,
		MachineControlLayer,
		MachineHostLayer,
		MachineResourceServiceLive,
		AccountAccessLayer,
		FolderPickerLayer,
	);

	const Handlers = HandlersLayer.pipe(
		Layer.provide(HandlerDomainLayer),

		Layer.provide(HandlerSupportLayer),
	);

	const serverProtocols = [
		deps.serverProtocol,
		...(deps.additionalServerProtocols ?? []),
	] as const;
	const makeServerLayer = (
		serverProtocol: Layer.Layer<
			RpcServer.Protocol,
			never,
			LanAuthService | AttachmentService
		>,
	) =>
		RpcServer.layer(MemoizeRpcs).pipe(
			Layer.provide(
				RpcAuthorizationLive.pipe(
					Layer.provide(AuthLayer),
					Layer.provide(MigratedSqlite),
				),
			),
			Layer.provide(Handlers),
			Layer.provide(
				serverProtocol.pipe(
					Layer.provide(
						Layer.mergeAll(
							EnrolledLanAuthLayer,
							AuthLayer,
							AttachmentLayer,
							DeviceBridgeLayer,
						),
					),
				),
			),
		);

	const ServerLayer = Layer.mergeAll(
		makeServerLayer(serverProtocols[0]),
		...serverProtocols.slice(1).map(makeServerLayer),
	);

	const UsagePoller = UsageLimitsPollerLive.pipe(
		Layer.provide(ProviderAccountsLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(CredentialsLayer),
		Layer.provide(NodeServices.layer),
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
	);
	const ModelCatalogPoller = ModelCatalogPollerLive.pipe(
		Layer.provide(ModelCatalogLayer),
	);
	return Layer.mergeAll(
		ServerLayer,
		NodeServices.layer,
		MigrationsReady,
		ProjectorsReady,
		UsagePoller,
		ModelCatalogPoller,
		AutoApiLinkLayer,
		RetireApiLinkLayer,
		CloudWorkspaceRuntimeLayer,
		RuntimePerformanceLayer,
		ActivityLayer,
		AutomationWorkerLive.pipe(
			Layer.provide(AutomationLayer),
			Layer.provide(ConversationServicesLayer),
		),
		ShutdownLayer,
		CliAccessLayer,
	).pipe(Layer.provide(TelemetryLayer));
};
