import { NodeContext } from "@effect/platform-node";
import { RpcServer } from "@effect/rpc";
import { Layer } from "effect";

import { MemoizeRpcs } from "@zuse/wire";

import { AppPaths } from "./app-paths.ts";
import { AuthServiceLive } from "./auth/layers/auth-service.ts";
import { AuthShell } from "./auth/services/auth-shell.ts";
import { AttachmentServiceLive } from "./attachment/layers/attachment-service.ts";
import { ConfigStoreServiceLive } from "./config-store/layers/config-store-service.ts";
import { DiagnosticsServiceLive } from "./diagnostics/layers/diagnostics-service.ts";
import { FsServiceLive } from "./fs/layers/fs-service.ts";
import { GitServiceLive } from "./git/layers/git-service.ts";
import { HandlersLayer } from "./handlers.ts";
import { importWorkspacesJson } from "./persistence/import-workspaces.ts";
import { MigrationsLive } from "./persistence/migrations.ts";
import { NdjsonLoggerLive } from "./persistence/ndjson-logger.ts";
import { SqliteLive } from "./persistence/sqlite.ts";
import { PokemonServiceLive } from "./pokemon/layers/pokemon-service.ts";
import { BrowserBridgeServiceLive } from "./provider/layers/browser-bridge-service.ts";
import { CredentialsServiceLive } from "./provider/layers/credentials-service.ts";
import { MessageStoreLive } from "./provider/layers/message-store.ts";
import { PermissionServiceLive } from "./provider/layers/permission-service.ts";
import { ProviderServiceLive } from "./provider/layers/provider-service.ts";
import { TitleGeneratorLive } from "./provider/title-generator.ts";
import { PtyServiceLive } from "./pty/layers/pty-service.ts";
import { SkillBridgeLive } from "./skill/layers/skill-bridge.ts";
import { SkillDiscoveryServiceLive } from "./skill/layers/skill-discovery.ts";
import { RepositorySettingsServiceLive } from "./repository-settings/layers/repository-settings-service.ts";
import { FileSearchServiceLive } from "./workspace/layers/file-search.ts";
import { ProjectScaffoldLive } from "./workspace/layers/project-scaffold-live.ts";
import { WorkspaceServiceLive } from "./workspace/layers/workspace-service.ts";
import { FolderPicker } from "./workspace/services/folder-picker.ts";
import { WorktreeServiceLive } from "./worktree/layers/worktree-service.ts";

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
 *   IPC protocol; the future WS server will supply a WebSocket protocol.
 * - `authShell`: the WorkOS OAuth deep-link seam. Electron opens the system
 *   browser via `shell.openExternal` and funnels the `zuse://auth/callback`
 *   deep link back in; a headless server supplies a loopback-HTTP variant.
 */
export interface MainLayerDeps {
  readonly userData: string;
  readonly folderPicker: typeof FolderPicker.Service;
  readonly serverProtocol: Layer.Layer<RpcServer.Protocol>;
  readonly authShell: typeof AuthShell.Service;
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

  // SqlClient is the shared persistence handle. The migrator runs once on
  // boot via `Layer.provideMerge` so any layer that consumes SqlClient sees
  // the schema already applied.
  const SqliteLayer = SqliteLive.pipe(Layer.provide(AppPathsLayer));
  const MigratedSqlite = SqliteLayer.pipe(
    Layer.provideMerge(
      MigrationsLive.pipe(
        Layer.provide(SqliteLayer),
        Layer.provide(NodeContext.layer),
      ),
    ),
  );

  // After migrations: import any pre-existing `workspaces.json` once.
  // `provideMerge` keeps the SqlClient available downstream.
  const ImportShim = Layer.effectDiscard(importWorkspacesJson).pipe(
    Layer.provide(MigratedSqlite),
    Layer.provide(NodeContext.layer),
    Layer.provide(AppPathsLayer),
  );

  const WorkspaceLayer = WorkspaceServiceLive.pipe(
    Layer.provide(MigratedSqlite),
    Layer.provide(ImportShim),
    Layer.provide(NodeContext.layer),
  );

  // Per-repo settings overrides on top of the global defaults.
  const RepositorySettingsLayer = RepositorySettingsServiceLive.pipe(
    Layer.provide(MigratedSqlite),
  );

  const PokemonLayer = PokemonServiceLive.pipe(
    Layer.provide(MigratedSqlite),
    Layer.provide(AppPathsLayer),
    Layer.provide(NodeContext.layer),
  );

  // WorktreeService manages memoize-owned `git worktree` checkouts. Same
  // shape as GitLayer + the SqlClient for persisting the rows.
  const WorktreeLayer = WorktreeServiceLive.pipe(
    Layer.provide(WorkspaceLayer),
    Layer.provide(RepositorySettingsLayer),
    Layer.provide(PokemonLayer),
    Layer.provide(MigratedSqlite),
    Layer.provide(NodeContext.layer),
  );

  // GitService yields WorkspaceService for folderId → path, WorktreeService
  // so `git.status` can resolve cwd to the active worktree when set, and
  // CommandExecutor (via NodeContext) for spawning git.
  const GitLayer = GitServiceLive.pipe(
    Layer.provide(WorkspaceLayer),
    Layer.provide(WorktreeLayer),
    Layer.provide(NodeContext.layer),
  );

  const PtyLayer = PtyServiceLive;

  // Global settings + user keybindings live in JSON files under userData
  // (Electron's `app.getPath("userData")`). Watched for external hand-edits.
  const ConfigStoreLayer = ConfigStoreServiceLive.pipe(
    Layer.provide(AppPathsLayer),
    Layer.provide(NodeContext.layer),
  );

  // FsService walks the project tree one directory at a time. WorkspaceService
  // resolves folderId → path; WorktreeService swaps the root to a worktree's
  // path when the renderer passes `worktreeId`; FileSystem reads dirs/stats.
  const FsLayer = FsServiceLive.pipe(
    Layer.provide(WorkspaceLayer),
    Layer.provide(WorktreeLayer),
    Layer.provide(NodeContext.layer),
  );

  // FileSearchService backs the composer's `@` file picker. Same deps as
  // FsLayer — recursive walk skipping common heavy directories. WorktreeLayer
  // lets the search reroot at a worktree's path when the renderer passes
  // `worktreeId`, so a session on a worktree only sees its own files.
  const FileSearchLayer = FileSearchServiceLive.pipe(
    Layer.provide(WorkspaceLayer),
    Layer.provide(WorktreeLayer),
    Layer.provide(NodeContext.layer),
  );

  // ProjectScaffold shells out to `git`, `bunx`, and `gh` for the Clone
  // and Quick-start flows. Pure CommandExecutor + FileSystem consumer —
  // no SqlClient, since persistence happens via WorkspaceService.add
  // *after* the scaffold produces a path.
  const ProjectScaffoldLayer = ProjectScaffoldLive.pipe(
    Layer.provide(NodeContext.layer),
  );

  // PermissionService brokers between the SDK permission callback (driver
  // side) and the renderer toast (RPC side). It writes decisions to
  // SQLite so an `AllowForSession` row survives a process crash and the
  // user isn't re-prompted on resume.
  const PermissionLayer = PermissionServiceLive.pipe(
    Layer.provide(MigratedSqlite),
    Layer.provide(AppPathsLayer),
  );

  // BrowserBridge brokers between the in-process browser MCP tools (driver
  // side) and the renderer's `<webview>` (RPC side). Ephemeral — no SQLite.
  // Same instance is provided to both ProviderLayer (the driver publishes
  // commands) and Handlers (the renderer subscribes + responds); Effect
  // memoizes the layer by reference so they share one PubSub + pending map.
  const BrowserBridgeLayer = BrowserBridgeServiceLive;

  // AttachmentService writes uploaded image bytes under userData and runs
  // the GC sweep that reaps orphaned blobs. Disk I/O comes from
  // NodeContext; persistence joins MigratedSqlite. Defined before
  // ProviderLayer because the Claude driver reads attachment bytes when
  // building image content blocks for outbound user messages.
  const AttachmentLayer = AttachmentServiceLive.pipe(
    Layer.provide(MigratedSqlite),
    Layer.provide(AppPathsLayer),
    Layer.provide(NodeContext.layer),
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
    Layer.provide(NodeContext.layer),
  );

  // NdjsonLogger writes a best-effort transcript audit file alongside the
  // SQLite store. Provided to MessageStore so the same daemon that persists
  // a row also tail-writes the NDJSON line.
  const NdjsonLoggerLayer = NdjsonLoggerLive.pipe(Layer.provide(AppPathsLayer));

  // MessageStore composes ProviderService with the SQLite-backed sessions /
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

  const MessageStoreLayer = MessageStoreLive.pipe(
    Layer.provide(ProviderLayer),
    Layer.provide(WorktreeLayer),
    Layer.provide(RepositorySettingsLayer),
    Layer.provide(PtyLayer),
    // GitService + ConfigStore + TitleGenerator back the first-message
    // auto-namer (rename chat + branch); see message-store `autoNameChat`.
    Layer.provide(GitLayer),
    Layer.provide(ConfigStoreLayer),
    Layer.provide(TitleGeneratorLayer),
    Layer.provide(MigratedSqlite),
    Layer.provide(NdjsonLoggerLayer),
  );

  const DiagnosticsLayer = DiagnosticsServiceLive.pipe(
    Layer.provide(MigratedSqlite),
    Layer.provide(AppPathsLayer),
    Layer.provide(ProviderLayer),
  );

  // SkillBridge surfaces the user's per-provider skill library to the
  // composer's slash popover. Discovery walks disk; the bridge caches per
  // (provider, projectCwd) and re-emits on watcher fire so editing a
  // SKILL.md updates the popover within ~2 s.
  const SkillDiscoveryLayer = SkillDiscoveryServiceLive.pipe(
    Layer.provide(NodeContext.layer),
  );
  const SkillBridgeLayer = SkillBridgeLive.pipe(
    Layer.provide(SkillDiscoveryLayer),
    Layer.provide(MessageStoreLayer),
    Layer.provide(WorkspaceLayer),
  );
  // AuthService owns the WorkOS PKCE flow + keychain token bundle. Depends on
  // CredentialsService (keychain) and the host-supplied AuthShell (browser +
  // deep-link). It registers its callback sink with the shell at build time,
  // so it must be constructed at boot — Handlers depends on it, which forces
  // that. No SqlClient: the (non-secret) profile rides along in the keychain
  // bundle, so there's no users table to migrate.
  const AuthLayer = AuthServiceLive.pipe(
    Layer.provide(CredentialsServiceLive),
    Layer.provide(AuthShellLayer),
  );

  const HandlerSupportLayer = Layer.mergeAll(
    AppPathsLayer,
    MigratedSqlite,
    NodeContext.layer,
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
    MessageStoreLayer,
    PermissionLayer,
    AttachmentLayer,
    BrowserBridgeLayer,
    // browser.* credential RPCs read/write the keychain directly.
    CredentialsServiceLive,
    SkillBridgeLayer,
    DiagnosticsLayer,
    FolderPickerLayer,
  );

  const Handlers = HandlersLayer.pipe(
    Layer.provide(HandlerDomainLayer),
    // `agent.opencodeInventory` calls `resolveCliPath("opencode")` directly
    // (it spins up a short-lived `opencode serve` to read the user's
    // connected providers + agents). That uses `CommandExecutor` from
    // NodeContext, so the handler layer must see it.
    Layer.provide(HandlerSupportLayer),
  );

  const ServerLayer = RpcServer.layer(MemoizeRpcs).pipe(
    Layer.provide(Handlers),
    Layer.provide(deps.serverProtocol),
  );

  return Layer.mergeAll(ServerLayer, NodeContext.layer);
};
