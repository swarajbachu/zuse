import { NodeServices } from "@effect/platform-node";
import { MemoizeRpcs } from "@zuse/contracts";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitServiceLive } from "@zuse/git/git-service-live";
import { WorktreeServiceLive } from "@zuse/git/worktree-service-live";
import { Effect, Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";

import { AppPaths } from "./app-paths.ts";
import { AttachmentServiceLive } from "./attachment/layers/attachment-service.ts";
import { AuthServiceLive } from "./auth/layers/auth-service.ts";
import { SessionStoreLive } from "./auth/layers/session-store.ts";
import { AuthShell } from "./auth/services/auth-shell.ts";
import { ConfigStoreServiceLive } from "./config-store/layers/config-store-service.ts";
import { DiagnosticsServiceLive } from "./diagnostics/layers/diagnostics-service.ts";
import { ExternalThreadServiceLive } from "./external-thread/layers/external-thread-service.ts";
import { FsServiceLive } from "./fs/layers/fs-service.ts";
import { RepositoryLocatorLive } from "./git/repository-locator-live.ts";
import { HandlersLayer } from "./handlers.ts";
import { LanAuthServiceLive } from "./lan-auth/layers/lan-auth-service.ts";
import type { LanAuthPolicy } from "./lan-auth/policy.ts";
import {
	LanAuthConfig,
	type LanAuthService,
} from "./lan-auth/services/lan-auth-service.ts";
import { runLifecycleBackfill } from "./persistence/backfill.ts";
import { importWorkspacesJson } from "./persistence/import-workspaces.ts";
import { MigrationsLive } from "./persistence/migrations.ts";
import { NdjsonLoggerLive } from "./persistence/ndjson-logger.ts";
import { SqliteLive } from "./persistence/sqlite.ts";
import { PokemonServiceLive } from "./pokemon/layers/pokemon-service.ts";
import { ConversationState } from "./provider/conversation-state.ts";
import { BrowserBridgeServiceLive } from "./provider/layers/browser-bridge-service.ts";
import { ConversationServicesLive } from "./provider/layers/conversation-services.ts";
import { CredentialsServiceLive } from "./provider/layers/credentials-service.ts";
import { PermissionServiceLive } from "./provider/layers/permission-service.ts";
import { ProviderServiceLive } from "./provider/layers/provider-service.ts";
import { TitleGeneratorLive } from "./provider/title-generator.ts";
import { PtyServiceLive } from "./pty/layers/pty-service.ts";
import { RelayActivityPublisherLive } from "./relay/activity-publisher.ts";
import { ManagedTunnelRuntimeLive } from "./relay/managed-tunnel-runtime.ts";
import { RelayLinkServiceLive } from "./relay/relay-link-service.ts";
import { RepositorySettingsServiceLive } from "./repository-settings/layers/repository-settings-service.ts";
import { SkillBridgeLive } from "./skill/layers/skill-bridge.ts";
import { SkillDiscoveryServiceLive } from "./skill/layers/skill-discovery.ts";
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
 *   protected local WebSocket origin for relay tunnels.
 * - `authShell`: the WorkOS OAuth deep-link seam. Electron opens the system
 *   browser via `shell.openExternal` and funnels the `zuse://auth/callback`
 *   deep link back in; a headless server supplies a loopback-HTTP variant.
 */
export interface MainLayerDeps {
	readonly userData: string;
	readonly folderPicker: typeof FolderPicker.Service;
	readonly serverProtocol: Layer.Layer<
		RpcServer.Protocol,
		never,
		LanAuthService
	>;
	readonly additionalServerProtocols?: ReadonlyArray<
		Layer.Layer<RpcServer.Protocol, never, LanAuthService>
	>;
	readonly authShell: typeof AuthShell.Service;
	readonly lanAuth?: {
		readonly policy: LanAuthPolicy;
		readonly advertisedHost?: string | null;
		readonly port?: number | null;
		readonly pairingBootstrap?: boolean;
	};
}

/**
 * Compose every Layer the server needs and return a single Layer the host
 * can run via `Layer.launch`. Pure factory — no electron, no transport
 * wiring inside this module.
 */
export const makeMainLayer = (deps: MainLayerDeps) => {
	const AppPathsLayer = Layer.succeed(AppPaths, { userData: deps.userData });
	const FolderPickerLayer = Layer.succeed(FolderPicker, deps.folderPicker);
	const AuthShellLayer = Layer.succeed(AuthShell, deps.authShell);
	const LanAuthConfigLayer = Layer.succeed(LanAuthConfig, {
		policy: deps.lanAuth?.policy ?? "local",
		advertisedHost: deps.lanAuth?.advertisedHost ?? null,
		port: deps.lanAuth?.port ?? null,
		pairingBootstrap: deps.lanAuth?.pairingBootstrap ?? false,
	});

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

	// FsService walks the project tree one directory at a time. WorkspaceService
	// resolves folderId → path; WorktreeService swaps the root to a worktree's
	// path when the renderer passes `worktreeId`; FileSystem reads dirs/stats.
	const FsLayer = FsServiceLive.pipe(
		Layer.provide(WorkspaceLayer),
		Layer.provide(WorktreeLayer),
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

	// ProviderService probes installed CLIs via CommandExecutor, consults
	// CredentialsService for SDK keys, resolves folderId → cwd via
	// WorkspaceService, and forwards the SDK's tool-permission callback to
	// PermissionService.
	const ProviderLayer = ProviderServiceLive.pipe(
		Layer.provide(CredentialsServiceLive),
		Layer.provide(WorkspaceLayer),
		Layer.provide(PermissionLayer),
		Layer.provide(AttachmentLayer),
		Layer.provide(BrowserBridgeLayer),
		// OpenCode session-start reads `opencodeCustomProviders` from settings to
		// inject user-defined providers into `opencode serve`.
		Layer.provide(ConfigStoreLayer),
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
	// TitleGenerator names a chat from its first message by running one
	// throwaway turn through the chat's OWN provider (via ProviderService), so
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

	const RelayActivityPublisherLayer = RelayActivityPublisherLive.pipe(
		Layer.provide(LanAuthLayer),
	);

	const ConversationServicesLayer = ConversationServicesLive.pipe(
		Layer.provide(ConversationState.layer),
		Layer.provide(ProviderLayer),
		Layer.provide(WorktreeLayer),
		Layer.provide(RepositorySettingsLayer),
		Layer.provide(PtyLayer),
		// GitService + ConfigStore + TitleGenerator back the background auto-namer
		// (rename chat + optional branch); see conversation-services `autoNameChat`.
		Layer.provide(GitLayer),
		Layer.provide(ConfigStoreLayer),
		Layer.provide(TitleGeneratorLayer),
		Layer.provide(RelayActivityPublisherLayer),
		Layer.provide(ProjectorCatchup),
		Layer.provide(SessionDomainLayer),
		Layer.provide(ChatDomainLayer),
		Layer.provide(SessionQueriesLayer),
		Layer.provide(MigratedSqlite),
		Layer.provide(NdjsonLoggerLayer),
	);

	const DiagnosticsLayer = DiagnosticsServiceLive.pipe(
		Layer.provide(MigratedSqlite),
		Layer.provide(AppPathsLayer),
		Layer.provide(ProviderLayer),
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
	// AuthService owns the WorkOS PKCE flow + shared file-backed session bundle.
	// It still depends on CredentialsService for one-time migration from older
	// keychain storage. The host supplies AuthShell (browser + callback), and
	// the callback sink is registered at build time, so Handlers forces boot.
	const AuthLayer = AuthServiceLive.pipe(
		Layer.provide(CredentialsServiceLive),
		Layer.provide(SessionStoreLive),
		Layer.provide(AuthShellLayer),
	);

	// RelayLinkService orchestrates the desktop's self-registration with the
	// account relay (challenge → Ed25519 proof → link → persist → heartbeat). It
	// reuses the environment identity (LanAuthService) and the WorkOS token
	// (AuthService); the renderer's Devices pane drives it via relay.* RPCs.
	const RelayLinkLayer = RelayLinkServiceLive.pipe(
		Layer.provide(LanAuthLayer),
		Layer.provide(LanAuthConfigLayer),
		Layer.provide(AuthLayer),
		// The managed-tunnel connector (`cloudflared`) spawns via CommandExecutor.
		Layer.provide(
			ManagedTunnelRuntimeLive.pipe(
				Layer.provide(NodeServices.layer),
				Layer.provide(AppPathsLayer),
			),
		),
		Layer.provide(AppPathsLayer),
	);

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
		FsLayer,
		FileSearchLayer,
		ProjectScaffoldLayer,
		ProviderLayer,
		SessionDomainLayer,
		ConversationServicesLayer,
		PermissionLayer,
		AttachmentLayer,
		BrowserBridgeLayer,
		// browser.* credential RPCs read/write the keychain directly.
		CredentialsServiceLive,
		SkillBridgeLayer,
		DiagnosticsLayer,
		LanAuthLayer,
		RelayLinkLayer,
		ExternalThreadLayer,
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
		serverProtocol: Layer.Layer<RpcServer.Protocol, never, LanAuthService>,
	) =>
		RpcServer.layer(MemoizeRpcs).pipe(
			Layer.provide(Handlers),
			Layer.provide(serverProtocol.pipe(Layer.provide(LanAuthLayer))),
		);

	const ServerLayer = Layer.mergeAll(
		makeServerLayer(serverProtocols[0]),
		...serverProtocols.slice(1).map(makeServerLayer),
	);

	return Layer.mergeAll(ServerLayer, NodeServices.layer);
};
