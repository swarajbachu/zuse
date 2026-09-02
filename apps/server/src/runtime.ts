import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { MemoizeRpcs } from "@zuse/contracts";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitServiceLive } from "@zuse/git/git-service-live";
import { WorktreeServiceLive } from "@zuse/git/worktree-service-live";
import { Duration, Effect, Layer, Schedule } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import {
	AccountAccessProcessLive,
	AccountAccessServiceLive,
} from "./account-access/service.ts";
import { AnalyticsServiceLive } from "./analytics/layers/analytics-service.ts";
import { ApiActivityPublisherLive } from "./api/activity-publisher.ts";
import {
	ApiLinkService,
	ApiLinkServiceLive,
	makeDisabledApiLinkService,
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
import { ConfigStoreServiceLive } from "./config-store/layers/config-store-service.ts";
import { ConversationState } from "./conversation/core/conversation-state.ts";
import { ConversationServicesLive } from "./conversation/layers/conversation-services.ts";
import { DiagnosticsServiceLive } from "./diagnostics/layers/diagnostics-service.ts";
import { ExternalThreadServiceLive } from "./external-thread/layers/external-thread-service.ts";
import { FsServiceLive } from "./fs/layers/fs-service.ts";
import { RepositoryLocatorLive } from "./git/repository-locator-live.ts";
import { HandlersLayer } from "./handlers.ts";
import { LanAuthServiceLive } from "./lan-auth/layers/lan-auth-service.ts";
import type { LanAuthPolicy } from "./lan-auth/policy.ts";
import {
	LanAuthConfig,
	LanAuthService,
} from "./lan-auth/services/lan-auth-service.ts";
import { LinearServiceLive } from "./linear/layers/linear-service.ts";
import { MachineControlServiceLive } from "./machine/machine-control-service.ts";
import {
	MachineHostServiceLive,
	MachinePrivateEndpointPublisherLive,
} from "./machine/machine-host-service.ts";
import { MachineResourceServiceLive } from "./machine/machine-resource-service.ts";
import { MachineRuntimeRole } from "./machine/machine-runtime-role.ts";
import { McpServiceLive } from "./mcp/layers/mcp-service.ts";
import { RuntimePerformanceMonitorLive } from "./observability/runtime-performance-monitor.ts";
import { TelemetryObservabilityLive } from "./observability/telemetry-layer.ts";
import { TelemetryStoreLive } from "./observability/telemetry-store.ts";
import { runLifecycleBackfill } from "./persistence/backfill.ts";
import { importWorkspacesJson } from "./persistence/import-workspaces.ts";
import { MigrationsLive } from "./persistence/migrations.ts";
import { NdjsonLoggerLive } from "./persistence/ndjson-logger.ts";
import { SqliteLive } from "./persistence/sqlite.ts";
import { PokemonServiceLive } from "./pokemon/layers/pokemon-service.ts";
import { BrowserBridgeServiceLive } from "./provider/layers/browser-bridge-service.ts";
import { PermissionServiceLive } from "./provider/layers/permission-service.ts";
import { ProviderServiceLive } from "./provider/layers/provider-service.ts";
import type { CredentialsService } from "./provider/services/credentials-service.ts";
import { TitleGeneratorLive } from "./provider/title-generator.ts";
import { PtyServiceLive } from "./pty/layers/pty-service.ts";
import { RepositorySettingsServiceLive } from "./repository-settings/layers/repository-settings-service.ts";
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
	readonly apiEnabled?: boolean;
	readonly cliAccess?: {
		readonly path: string;
		readonly wsUrl: string;
	};
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

	// SqlClient is the shared persistence handle. The migrator runs once on
	// boot via `Layer.provideMerge` so any layer that consumes SqlClient sees
	// the schema already applied.
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

	// After migrations: import any pre-existing `workspaces.json` once.
	// `provideMerge` keeps the SqlClient available downstream.
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
								`${JSON.stringify({ schemaVersion: 1, wsUrl, token: minted.token })}\n`,
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

	// Per-repo settings overrides on top of the global defaults.
	const RepositorySettingsLayer = RepositorySettingsServiceLive.pipe(
		Layer.provide(MigratedSqlite),
	);

	const PokemonLayer = PokemonServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(NodeServices.layer),
	);

	// WorktreeService manages memoize-owned `git worktree` checkouts. Same
	// shape as GitLayer + the SqlClient for persisting the rows.
	const WorktreePortsLayer = Layer.mergeAll(
		ProjectLocatorLive.pipe(Layer.provide(WorkspaceLayer)),
		RepositorySettingsReaderLive.pipe(Layer.provide(RepositorySettingsLayer)),
		WorktreeNameAllocatorLive,
		WorktreeDecorationLive,
		PokemonAssignmentLive.pipe(Layer.provide(PokemonLayer)),
	);

	const WorktreeLayer = WorktreeServiceLive.pipe(
		Layer.provide(WorktreePortsLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	// GitService yields WorkspaceService for folderId → path, WorktreeService
	// so `git.status` can resolve cwd to the active worktree when set, and
	// CommandExecutor (via NodeServices) for spawning git.
	const GitLayer = GitServiceLive.pipe(
		Layer.provide(
			RepositoryLocatorLive.pipe(
				Layer.provide(WorkspaceLayer),
				Layer.provide(WorktreeLayer),
			),
		),
		Layer.provide(NodeServices.layer),
	);

	const PtyLayer = PtyServiceLive;

	// Global settings + user keybindings live in user-editable JSON files under
	// ~/.zuse (or ~/.zuse-dev for dev builds), with one-time migration from
	// Electron userData. Watched for external hand-edits.
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

	// Auth owns the account transition that analytics uses to move between a
	// random installation identity and a namespaced account hash.
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

	// FsService walks the project tree one directory at a time. WorkspaceService
	// resolves folderId → path; WorktreeService swaps the root to a worktree's
	// path when the renderer passes `worktreeId`; FileSystem reads dirs/stats.
	const FsLayer = FsServiceLive.pipe(
		Layer.provide(WorkspaceLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	// FileSearchService backs the composer's `@` file picker. Same deps as
	// FsLayer — recursive walk skipping common heavy directories. WorktreeLayer
	// lets the search reroot at a worktree's path when the renderer passes
	// `worktreeId`, so a session on a worktree only sees its own files.
	const FileSearchLayer = FileSearchServiceLive.pipe(
		Layer.provide(WorkspaceLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(NodeServices.layer),
	);

	// ProjectScaffold shells out to `git`, `bunx`, and `gh` for the Clone
	// and Quick-start flows. Pure CommandExecutor + FileSystem consumer —
	// no SqlClient, since persistence happens via WorkspaceService.add
	// *after* the scaffold produces a path.
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

	// PermissionService brokers between the SDK permission callback (driver
	// side) and the renderer toast (RPC side). It writes decisions to
	// SQLite so an `AllowForSession` row survives a process crash and the
	// user isn't re-prompted on resume.
	const PermissionLayer = PermissionServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(SessionDomainLayer),
	);

	// BrowserBridge brokers between the in-process browser MCP tools (driver
	// side) and the renderer's `<webview>` (RPC side). Ephemeral — no SQLite.
	// Same instance is provided to both ProviderLayer (the driver publishes
	// commands) and Handlers (the renderer subscribes + responds); Effect
	// memoizes the layer by reference so they share one PubSub + pending map.
	const BrowserBridgeLayer = BrowserBridgeServiceLive;

	// AttachmentService writes uploaded image bytes under userData and runs
	// the GC sweep that reaps orphaned blobs. Disk I/O comes from
	// NodeServices; persistence joins MigratedSqlite. Defined before
	// ProviderLayer because the Claude driver reads attachment bytes when
	// building image content blocks for outbound user messages.
	const AttachmentLayer = AttachmentServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(NodeServices.layer),
	);

	// McpService reads the user's native Claude/Codex MCP configs, tracks
	// per-server connection status (SDK probe for claude-source, ephemeral
	// codex app-server for codex-source), stores enable/disable overrides in
	// settings, and runs OAuth flows (tokens in the keychain).
	const McpLayer = McpServiceLive.pipe(
		Layer.provide(ConfigStoreLayer),
		Layer.provide(RepositorySettingsLayer),
		Layer.provide(CredentialsLayer),
		Layer.provide(BrowserBridgeLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	// ProviderService probes installed CLIs via CommandExecutor, consults
	// CredentialsService for SDK keys, resolves folderId → cwd via
	// WorkspaceService, and forwards the SDK's tool-permission callback to
	// PermissionService.
	const ProviderLayer = ProviderServiceLive.pipe(
		Layer.provide(CredentialsLayer),
		Layer.provide(WorkspaceLayer),
		Layer.provide(PermissionLayer),
		Layer.provide(AttachmentLayer),
		Layer.provide(BrowserBridgeLayer),
		// OpenCode session-start reads `opencodeCustomProviders` from settings to
		// inject user-defined providers into `opencode serve`; Claude session
		// start resolves the user's native MCP servers through McpService.
		Layer.provide(ConfigStoreLayer),
		Layer.provide(McpLayer),
		Layer.provide(AnalyticsLayer),
		Layer.provide(NodeServices.layer),
	);

	// NdjsonLogger writes a best-effort transcript audit file alongside the
	// SQLite store. Provided to Conversation services so the same daemon that persists
	// a row also tail-writes the NDJSON line.
	const NdjsonLoggerLayer = NdjsonLoggerLive.pipe(Layer.provide(AppPathsLayer));

	// Conversation services composes ProviderService with the SQLite-backed sessions /
	// messages tables. The chat-MVP RPC surface (session.* / messages.*) talks
	// through this; legacy agent.* handlers stay bound to ProviderService for
	// low-level testing.
	// TitleGenerator names pending chats, sessions, and fresh branches after
	// their first submitted turn succeeds, using the chat's OWN provider, so
	// it reuses whatever auth that provider has — a Grok-only user is never
	// forced onto Claude.
	const TitleGeneratorLayer = TitleGeneratorLive.pipe(
		Layer.provide(ProviderLayer),
	);

	// Replay durable domain events before accepting transport traffic.
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
	const LinearLayer = LinearServiceLive.pipe(
		Layer.provide(CredentialsLayer),
		Layer.provide(AuthShellLayer),
		Layer.provide(AttachmentLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);
	const MachineControlLayer = MachineControlServiceLive.pipe(
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

	const ConversationServicesLayer = ConversationServicesLive.pipe(
		Layer.provide(ConversationState.layer),
		Layer.provide(ProviderLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(RepositorySettingsLayer),
		Layer.provide(PtyLayer),
		// GitService + ConfigStore + TitleGenerator back the background auto-namer
		// (independent chat/session/branch naming); see `autoNameChat`.
		Layer.provide(GitLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(TitleGeneratorLayer),
		Layer.provide(ApiActivityPublisherLayer),
		Layer.provide(LinearLayer),
		Layer.provide(ProjectorCatchup),
		Layer.provide(SessionDomainLayer),
		Layer.provide(ChatDomainLayer),
		Layer.provide(SessionQueriesLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NdjsonLoggerLayer),
	);
	const CloudWorkspaceRuntimeLayer = makeCloudWorkspaceRuntimeLayer(
		deps.cloudWorkspaceRuntime,
	).pipe(
		Layer.provide(CredentialsLayer),
		Layer.provide(EnrolledLanAuthLayer),
		Layer.provide(WorkspaceLayer),
		Layer.provide(ConversationServicesLayer),
		Layer.provide(SessionDomainLayer),
		Layer.provide(NodeServices.layer),
	);

	const DiagnosticsLayer = DiagnosticsServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(ProviderLayer),
		Layer.provide(TelemetryStoreLayer),
	);

	const ExternalThreadLayer = ExternalThreadServiceLive.pipe(
		Layer.provide(WorkspaceLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(ConversationServicesLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NodeServices.layer),
	);

	// SkillBridge surfaces the user's per-provider skill library to the
	// composer's slash popover. Discovery walks disk; the bridge caches per
	// (provider, projectCwd) and re-emits on watcher fire so editing a
	// SKILL.md updates the popover within ~2 s.
	const SkillDiscoveryLayer = SkillDiscoveryServiceLive.pipe(
		Layer.provide(NodeServices.layer),
	);
	const SkillBridgeLayer = SkillBridgeLive.pipe(
		Layer.provide(SkillDiscoveryLayer),
		Layer.provide(ConversationServicesLayer),
		Layer.provide(WorkspaceLayer),
	);
	// ApiLinkService orchestrates the desktop's self-registration with the
	// account api (challenge → Ed25519 proof → link → persist → heartbeat). It
	// reuses the environment identity (LanAuthService) and the WorkOS token
	// (AuthService); the renderer's Devices pane drives it via api.* RPCs.
	const ApiLinkLayer =
		deps.apiEnabled === false
			? makeDisabledApiLinkService(lanAuthConfig)
			: ApiLinkServiceLive.pipe(
					Layer.provide(AccountAccessLayer),
					Layer.provide(EnrolledLanAuthLayer),
					Layer.provide(LanAuthConfigLayer),
					Layer.provide(AuthLayer),
					// The managed-tunnel connector (`cloudflared`) spawns via CommandExecutor.
					Layer.provide(ManagedTunnelLayer),
					Layer.provide(AppPathsLayer),
					Layer.provide(TelemetryStoreLayer),
				);
	const autoApiLink = deps.autoApiLink;
	// Linking must never block or fail server boot: it runs in a background
	// fiber and retries with capped backoff until it sticks. Persistent causes
	// (signed out, api down) self-heal on a later attempt without a restart.
	const AutoApiLinkLayer =
		autoApiLink === undefined
			? Layer.empty
			: Layer.effectDiscard(
					Effect.gen(function* () {
						const api = yield* ApiLinkService;
						yield* Effect.gen(function* () {
							const status = yield* api.status();
							if (!status.linked) {
								yield* api.link(autoApiLink);
							}
						}).pipe(
							Effect.tapError((error) =>
								Effect.logWarning("api auto-link attempt failed", error),
							),
							Effect.retry(
								Schedule.exponential("3 seconds").pipe(
									Schedule.modifyDelay(({ duration }) =>
										Effect.succeed(
											Duration.millis(
												Math.min(Duration.toMillis(duration), 60_000),
											),
										),
									),
									Schedule.jittered,
								),
							),
							Effect.forkScoped({ startImmediately: true }),
						);
					}),
				).pipe(Layer.provide(ApiLinkLayer));

	const HandlerSupportLayer = Layer.mergeAll(
		AppPathsLayer,
		MigratedSqlite,
		NodeServices.layer,
		LanAuthConfigLayer,
		// AuthLayer is fully self-contained (its keychain + shell deps are already
		// provided), merged in here to satisfy the auth.* handlers without adding
		// another `.pipe` step — the Handlers pipe is at its 20-arg overload cap.
		AuthLayer,
	);

	const HandlerDomainLayer = Layer.mergeAll(
		WorkspaceLayer,
		PtyLayer,
		GitLayer,
		WorktreeLayer,
		RepositorySettingsLayer,
		PokemonLayer,
		ConfigStoreLayer,
		AnalyticsLayer,
		FsLayer,
		FileSearchLayer,
		ProjectScaffoldLayer,
		ProviderLayer,
		McpLayer,
		SessionDomainLayer,
		SessionQueriesLayer,
		ConversationServicesLayer,
		PermissionLayer,
		AttachmentLayer,
		BrowserBridgeLayer,
		// browser.* credential RPCs share the encrypted local vault.
		CredentialsLayer,
		SkillBridgeLayer,
		DiagnosticsLayer,
		EnrolledLanAuthLayer,
		ApiLinkLayer,
		ExternalThreadLayer,
		LinearLayer,
		MachineControlLayer,
		MachineHostLayer,
		MachineResourceServiceLive,
		AccountAccessLayer,
		FolderPickerLayer,
	);

	const Handlers = HandlersLayer.pipe(
		Layer.provide(HandlerDomainLayer),
		// `agent.opencodeInventory` calls `resolveCliPath("opencode")` directly
		// (it spins up a short-lived `opencode serve` to read the user's
		// connected providers + agents). That uses `CommandExecutor` from
		// NodeServices, so the handler layer must see it.
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
			Layer.provide(Handlers),
			Layer.provide(
				serverProtocol.pipe(
					Layer.provide(Layer.merge(EnrolledLanAuthLayer, AttachmentLayer)),
				),
			),
		);

	const ServerLayer = Layer.mergeAll(
		makeServerLayer(serverProtocols[0]),
		...serverProtocols.slice(1).map(makeServerLayer),
	);

	const UsagePoller = UsageLimitsPollerLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
	);
	return Layer.mergeAll(
		ServerLayer,
		NodeServices.layer,
		MigrationsReady,
		ProjectorsReady,
		UsagePoller,
		AutoApiLinkLayer,
		CloudWorkspaceRuntimeLayer,
		RuntimePerformanceLayer,
		CliAccessLayer,
	).pipe(Layer.provide(TelemetryLayer));
};
