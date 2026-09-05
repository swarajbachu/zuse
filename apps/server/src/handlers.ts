import { Layer } from "effect";
import { AccountAccessHandlersLayer } from "./account-access/handlers.ts";
import { AnalyticsHandlersLayer } from "./analytics/handlers.ts";
import { ApiHandlersLayer } from "./api/handlers.ts";
import { AttachmentHandlersLayer } from "./attachment/handlers.ts";
import { AuthHandlersLayer } from "./auth/handlers.ts";
import { ConfigStoreHandlersLayer } from "./config-store/handlers.ts";
import { DiagnosticsHandlersLayer } from "./diagnostics/handlers.ts";
import { ExternalThreadHandlersLayer } from "./external-thread/handlers.ts";
import { FsHandlersLayer } from "./fs/handlers.ts";
import { GitHandlersLayer } from "./git/handlers.ts";
import { HostHandlersLayer } from "./host/handlers.ts";
import { LanAuthHandlersLayer } from "./lan-auth/handlers.ts";
import { LinearHandlersLayer } from "./linear/handlers.ts";
import { MachineHandlersLayer } from "./machine/handlers.ts";
import { McpHandlersLayer } from "./mcp/handlers.ts";
import { ModelCatalogHandlersLayer } from "./model-catalog/handlers.ts";
import { PingHandlersLayer } from "./ping/handlers.ts";
import { PokemonHandlersLayer } from "./pokemon/handlers.ts";
import { PreviewsHandlersLayer } from "./previews/handlers.ts";
import { ProviderHandlersLayer } from "./provider/handlers.ts";
import { PtyHandlersLayer } from "./pty/handlers.ts";
import { RepositorySettingsHandlersLayer } from "./repository-settings/handlers.ts";
import { SkillHandlersLayer } from "./skill/handlers.ts";
import { UsageHandlersLayer } from "./usage/handlers.ts";
import { VoiceHandlersLayer } from "./voice/handlers.ts";
import { WorkspaceHandlersLayer } from "./workspace/handlers.ts";
import { WorktreeHandlersLayer } from "./worktree/handlers.ts";

/**
 * Top-level merge of every domain's RPC handlers. New domains add a line
 * here — service composition (which Layer satisfies which yield) is wired in
 * `runtime.ts`. Keeping this list narrow prevents transport-bound code from
 * sneaking into the handler boundary.
 */
export const HandlersLayer = Layer.mergeAll(
	PingHandlersLayer,
	PreviewsHandlersLayer,
	AccountAccessHandlersLayer,
	AnalyticsHandlersLayer,
	LanAuthHandlersLayer,
	ApiHandlersLayer,
	AuthHandlersLayer,
	LinearHandlersLayer,
	MachineHandlersLayer,
	WorkspaceHandlersLayer,
	PtyHandlersLayer,
	GitHandlersLayer,
	HostHandlersLayer,
	WorktreeHandlersLayer,
	RepositorySettingsHandlersLayer,
	ConfigStoreHandlersLayer,
	ProviderHandlersLayer,
	McpHandlersLayer,
	ModelCatalogHandlersLayer,
	FsHandlersLayer,
	AttachmentHandlersLayer,
	SkillHandlersLayer,
	PokemonHandlersLayer,
	UsageHandlersLayer,
	VoiceHandlersLayer,
	DiagnosticsHandlersLayer,
	ExternalThreadHandlersLayer,
);
