import { Layer } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import { Migration0001Initial } from "./migrations/0001_initial.ts";
import { Migration0002Permissions } from "./migrations/0002_permissions.ts";
import { Migration0003ResumeAndExport } from "./migrations/0003_resume_and_export.ts";
import { Migration0004PermissionScope } from "./migrations/0004_permission_scope.ts";
import { Migration0005RuntimeMode } from "./migrations/0005_runtime_mode.ts";
import { Migration0006Attachments } from "./migrations/0006_attachments.ts";
import { Migration0007Subagents } from "./migrations/0007_subagents.ts";
import { Migration0008WorktreesAndRepoSettings } from "./migrations/0008_worktrees_and_repo_settings.ts";
import { Migration0009PermissionModeAndToolSearch } from "./migrations/0009_permission_mode_and_tool_search.ts";
import { Migration0010NestedSessions } from "./migrations/0010_nested_sessions.ts";
import { Migration0011ChatsTable } from "./migrations/0011_chats_table.ts";
import { Migration0012ChatIdNotNull } from "./migrations/0012_chat_id_not_null.ts";
import { Migration0013ArchiveCleanup } from "./migrations/0013_archive_cleanup.ts";
import { Migration0014ScriptsAndSetup } from "./migrations/0014_scripts_and_setup.ts";
import { Migration0015QueuedMessages } from "./migrations/0015_queued_messages.ts";
import { Migration0016QueuedMessagesQueueOrderRepair } from "./migrations/0016_queued_messages_queue_order_repair.ts";
import { Migration0017ChatReadState } from "./migrations/0017_chat_read_state.ts";
import { Migration0018PokemonWorktrees } from "./migrations/0018_pokemon_worktrees.ts";
import { Migration0019QueuePaused } from "./migrations/0019_queue_paused.ts";
import { Migration0020Events } from "./migrations/0020_events.ts";
import { Migration0021AuthTokens } from "./migrations/0021_auth_tokens.ts";
import { Migration0022AttachmentAbsPath } from "./migrations/0022_attachment_abs_path.ts";
import { Migration0023ChatLineage } from "./migrations/0023_chat_lineage.ts";
import { Migration0024RemoteConnectState } from "./migrations/0024_remote_connect_state.ts";
import { Migration0025RelayEnvironmentKeys } from "./migrations/0025_relay_environment_keys.ts";
import { Migration0026RelayConnectorToken } from "./migrations/0026_relay_connector_token.ts";
import { Migration0027RelayTunnelHostname } from "./migrations/0027_relay_tunnel_hostname.ts";
import { Migration0028RelayMintPublicKey } from "./migrations/0028_relay_mint_public_key.ts";
import { Migration0029ChatLineageRepair } from "./migrations/0029_chat_lineage_repair.ts";
import { Migration0030CqrsEngine } from "./migrations/0030_cqrs_engine.ts";
import { Migration0031BackfillRuns } from "./migrations/0031_backfill_runs.ts";
import { Migration0032ReactorEffectReceipts } from "./migrations/0032_reactor_effect_receipts.ts";
import { Migration0033ReactorEffectSteps } from "./migrations/0033_reactor_effect_steps.ts";
import { Migration0034ToolEventLookup } from "./migrations/0034_tool_event_lookup.ts";
import { Migration0035UsageLimitSnapshots } from "./migrations/0035_usage_limit_snapshots.ts";
import { Migration0036UsageCostDaily } from "./migrations/0036_usage_cost_daily.ts";
import { Migration0037ProviderEventCursor } from "./migrations/0037_provider_event_cursor.ts";
import { Migration0038QueuedMessageReady } from "./migrations/0038_queued_message_ready.ts";
import { Migration0039AuthTokenDevices } from "./migrations/0039_auth_token_devices.ts";
import { Migration0040BlockedNearbyDevices } from "./migrations/0040_blocked_nearby_devices.ts";
import { Migration0041ChatArchiveJobs } from "./migrations/0041_chat_archive_jobs.ts";
import { Migration0042NameProvenance } from "./migrations/0042_name_provenance.ts";

/**
 * Runs every numbered migration on boot. `fromRecord` keys must match
 * `^\d+_<name>$` — the leading number is the migration id, used by the
 * `effect_sql_migrations` table to track what's applied.
 *
 * Uses the generic `@effect/sql` Migrator (not the driver-specific
 * `SqliteMigrator`): identical `fromRecord` semantics and tracking table,
 * but it only requires the generic `SqlClient` tag, so it runs on any
 * driver — the node:sqlite client in prod, the bun client in tests.
 *
 * Add new migrations by appending entries. Never edit a shipped migration —
 * supersede it with a new id.
 */
const MigrationDefinitions = {
	"0001_initial": Migration0001Initial,
	"0002_permissions": Migration0002Permissions,
	"0003_resume_and_export": Migration0003ResumeAndExport,
	"0004_permission_scope": Migration0004PermissionScope,
	"0005_runtime_mode": Migration0005RuntimeMode,
	"0006_attachments": Migration0006Attachments,
	"0007_subagents": Migration0007Subagents,
	"0008_worktrees_and_repo_settings": Migration0008WorktreesAndRepoSettings,
	"0009_permission_mode_and_tool_search":
		Migration0009PermissionModeAndToolSearch,
	"0010_nested_sessions": Migration0010NestedSessions,
	"0011_chats_table": Migration0011ChatsTable,
	"0012_chat_id_not_null": Migration0012ChatIdNotNull,
	"0013_archive_cleanup": Migration0013ArchiveCleanup,
	"0014_scripts_and_setup": Migration0014ScriptsAndSetup,
	"0015_queued_messages": Migration0015QueuedMessages,
	"0016_queued_messages_queue_order_repair":
		Migration0016QueuedMessagesQueueOrderRepair,
	"0017_chat_read_state": Migration0017ChatReadState,
	"0018_pokemon_worktrees": Migration0018PokemonWorktrees,
	"0019_queue_paused": Migration0019QueuePaused,
	"0020_events": Migration0020Events,
	"0021_auth_tokens": Migration0021AuthTokens,
	"0022_attachment_abs_path": Migration0022AttachmentAbsPath,
	"0023_chat_lineage": Migration0023ChatLineage,
	"0024_remote_connect_state": Migration0024RemoteConnectState,
	"0025_relay_environment_keys": Migration0025RelayEnvironmentKeys,
	"0026_relay_connector_token": Migration0026RelayConnectorToken,
	"0027_relay_tunnel_hostname": Migration0027RelayTunnelHostname,
	"0028_relay_mint_public_key": Migration0028RelayMintPublicKey,
	"0029_chat_lineage_repair": Migration0029ChatLineageRepair,
	"0030_cqrs_engine": Migration0030CqrsEngine,
	"0031_backfill_runs": Migration0031BackfillRuns,
	"0032_reactor_effect_receipts": Migration0032ReactorEffectReceipts,
	"0033_reactor_effect_steps": Migration0033ReactorEffectSteps,
	"0034_tool_event_lookup": Migration0034ToolEventLookup,
	"0035_usage_limit_snapshots": Migration0035UsageLimitSnapshots,
	"0036_usage_cost_daily": Migration0036UsageCostDaily,
	"0037_provider_event_cursor": Migration0037ProviderEventCursor,
	"0038_queued_message_ready": Migration0038QueuedMessageReady,
	"0039_auth_token_devices": Migration0039AuthTokenDevices,
	"0040_blocked_nearby_devices": Migration0040BlockedNearbyDevices,
	"0041_chat_archive_jobs": Migration0041ChatArchiveJobs,
	"0042_name_provenance": Migration0042NameProvenance,
} as const;

export const MigrationsLive = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitions),
	}),
);
