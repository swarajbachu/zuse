import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
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
import { Migration0042AnalyticsOutbox } from "./migrations/0042_analytics_outbox.ts";
import { Migration0043NameProvenance } from "./migrations/0043_name_provenance.ts";
import { Migration0044ChatCreationOperations } from "./migrations/0044_chat_creation_operations.ts";
import { Migration0045ChatCatalogRevision } from "./migrations/0045_chat_catalog_revision.ts";
import { Migration0046SessionTimelineHead } from "./migrations/0046_session_timeline_head.ts";
import { Migration0047MessageCheckpoints } from "./migrations/0047_message_checkpoints.ts";
import { Migration0048FsWriteReceipts } from "./migrations/0048_fs_write_receipts.ts";
import { Migration0049ChatCreationStartupReady } from "./migrations/0049_chat_creation_startup_ready.ts";
import { Migration0050DurableChatCreation } from "./migrations/0050_durable_chat_creation.ts";
import { Migration0051LegacyChatCreationPhaseRepair } from "./migrations/0051_legacy_chat_creation_phase_repair.ts";
import { Migration0052ApiConfig } from "./migrations/0052_api_config.ts";
import { Migration0053CloudCommandReceipts } from "./migrations/0053_cloud_command_receipts.ts";
import { Migration0054ProviderEffectOutcomes } from "./migrations/0054_provider_effect_outcomes.ts";
import { Migration0055StagingApiOrigin } from "./migrations/0055_staging_api_origin.ts";
import { Migration0056DeviceBridge } from "./migrations/0056_device_bridge.ts";
import { Migration0057DeviceBridgeDefaultAccess } from "./migrations/0057_device_bridge_default_access.ts";
import { Migration0058QuestionAnswerDeliveries } from "./migrations/0058_question_answer_deliveries.ts";
import { Migration0059EventSequenceIndex } from "./migrations/0059_event_sequence_index.ts";
import { Migration0060ChatUserMessageTime } from "./migrations/0060_chat_user_message_time.ts";
import { Migration0061HarnessExecutions } from "./migrations/0061_harness_executions.ts";
import { Migration0062ModelConnections } from "./migrations/0062_model_connections.ts";
import { Migration0063Jobs } from "./migrations/0063_jobs.ts";
import { Migration0063ProjectWorkspaceKey } from "./migrations/0063_project_workspace_key.ts";
import { Migration0064ProviderAccounts } from "./migrations/0064_provider_accounts.ts";
import { Migration0064SessionGraph } from "./migrations/0064_session_graph.ts";
import { Migration0065ProviderThreadOwnership } from "./migrations/0065_provider_thread_ownership.ts";
import { Migration0066JobAttemptOwnership } from "./migrations/0066_job_attempt_ownership.ts";
import { Migration0067ProviderReservations } from "./migrations/0067_provider_reservations.ts";
import { Migration0068AttemptHistory } from "./migrations/0068_attempt_history.ts";
import { Migration0069AttemptProviderTurn } from "./migrations/0069_attempt_provider_turn.ts";
import { Migration0070IngestionLeases } from "./migrations/0070_ingestion_leases.ts";
import { Migration0071SessionInputs } from "./migrations/0071_session_inputs.ts";
import { Migration0072InputOwnership } from "./migrations/0072_input_ownership.ts";
import { Migration0073QuestionExpiry } from "./migrations/0073_question_expiry.ts";
import { Migration0074PlanDeliveries } from "./migrations/0074_plan_deliveries.ts";
import { Migration0075ContextHandoffs } from "./migrations/0075_context_handoffs.ts";
import { Migration0076TurnActivityIndex } from "./migrations/0076_turn_activity_index.ts";
import { Migration0077ForkConstructions } from "./migrations/0077_fork_constructions.ts";
import { Migration0078SessionCheckpoints } from "./migrations/0078_session_checkpoints.ts";
import { Migration0079ContextLinks } from "./migrations/0079_context_links.ts";
import { Migration0080SessionDelegations } from "./migrations/0080_session_delegations.ts";
import { Migration0081ProviderContexts } from "./migrations/0081_provider_contexts.ts";
import { Migration0082ExecutionSteps } from "./migrations/0082_execution_steps.ts";
import { Migration0083NativeCheckpointHistory } from "./migrations/0083_native_checkpoint_history.ts";
import { Migration0086Automation } from "./migrations/0086_automation.ts";
import { Migration0087ScratchFolders } from "./migrations/0087_scratch_folders.ts";
import { Migration0088ScratchFoldersRepair } from "./migrations/0088_scratch_folders_repair.ts";
import { Migration0089DeviceBridgeEnrollment } from "./migrations/0089_device_bridge_enrollment.ts";

const MigrationDefinitionsThrough0045 = {
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
	"0042_analytics_outbox": Migration0042AnalyticsOutbox,
	"0043_name_provenance": Migration0043NameProvenance,
	"0044_chat_creation_operations": Migration0044ChatCreationOperations,
	"0045_chat_catalog_revision": Migration0045ChatCatalogRevision,
} as const;

const MigrationDefinitionsThrough0054 = {
	...MigrationDefinitionsThrough0045,
	"0046_session_timeline_head": Migration0046SessionTimelineHead,
	"0047_message_checkpoints": Migration0047MessageCheckpoints,
	"0048_fs_write_receipts": Migration0048FsWriteReceipts,
	"0049_chat_creation_startup_ready": Migration0049ChatCreationStartupReady,
	"0050_durable_chat_creation": Migration0050DurableChatCreation,
	"0051_legacy_chat_creation_phase_repair":
		Migration0051LegacyChatCreationPhaseRepair,
	"0052_api_config": Migration0052ApiConfig,
	"0053_cloud_command_receipts": Migration0053CloudCommandReceipts,
	"0054_provider_effect_outcomes": Migration0054ProviderEffectOutcomes,
} as const;

const MigrationDefinitionsThrough0059 = {
	...MigrationDefinitionsThrough0054,
	"0055_staging_api_origin": Migration0055StagingApiOrigin,
	"0056_device_bridge": Migration0056DeviceBridge,
	"0057_device_bridge_default_access": Migration0057DeviceBridgeDefaultAccess,
	"0058_question_answer_deliveries": Migration0058QuestionAnswerDeliveries,
	"0059_event_sequence_index": Migration0059EventSequenceIndex,
} as const;

const MigrationDefinitionsThrough0060 = {
	...MigrationDefinitionsThrough0059,
	"0060_chat_user_message_time": Migration0060ChatUserMessageTime,
} as const;

const MigrationDefinitionsThrough0062 = {
	...MigrationDefinitionsThrough0060,
	"0061_harness_executions": Migration0061HarnessExecutions,
	"0062_model_connections": Migration0062ModelConnections,
} as const;

const MigrationDefinitionsThrough0073 = {
	...MigrationDefinitionsThrough0062,
	"0063_jobs": Migration0063Jobs,
	"0064_session_graph": Migration0064SessionGraph,
	"0065_provider_thread_ownership": Migration0065ProviderThreadOwnership,
	"0066_job_attempt_ownership": Migration0066JobAttemptOwnership,
	"0067_provider_reservations": Migration0067ProviderReservations,
	"0068_attempt_history": Migration0068AttemptHistory,
	"0069_attempt_provider_turn": Migration0069AttemptProviderTurn,
	"0070_ingestion_leases": Migration0070IngestionLeases,
	"0071_session_inputs": Migration0071SessionInputs,
	"0072_input_ownership": Migration0072InputOwnership,
	"0073_question_expiry": Migration0073QuestionExpiry,
} as const;

const LegacyMigrationDefinitionsThrough0083 = {
	"0083_native_checkpoint_history": Migration0083NativeCheckpointHistory,
	...MigrationDefinitionsThrough0073,
	"0074_plan_deliveries": Migration0074PlanDeliveries,
	"0075_context_handoffs": Migration0075ContextHandoffs,
	"0076_turn_activity_index": Migration0076TurnActivityIndex,
	"0077_fork_constructions": Migration0077ForkConstructions,
	"0079_context_links": Migration0079ContextLinks,
	"0080_session_delegations": Migration0080SessionDelegations,
	"0081_provider_contexts": Migration0081ProviderContexts,
	"0082_execution_steps": Migration0082ExecutionSteps,
	"0078_session_checkpoints": Migration0078SessionCheckpoints,
} as const;

const MigrationDefinitionsThrough0064 = {
	...MigrationDefinitionsThrough0062,
	"0063_project_workspace_key": Migration0063ProjectWorkspaceKey,
	"0064_provider_accounts": Migration0064ProviderAccounts,
} as const;

const MigrationDefinitionsThrough0086 = {
	...MigrationDefinitionsThrough0064,
	"0065_jobs": Migration0063Jobs,
	"0066_session_graph": Migration0064SessionGraph,
	"0067_provider_thread_ownership": Migration0065ProviderThreadOwnership,
	"0068_job_attempt_ownership": Migration0066JobAttemptOwnership,
	"0069_provider_reservations": Migration0067ProviderReservations,
	"0070_attempt_history": Migration0068AttemptHistory,
	"0071_attempt_provider_turn": Migration0069AttemptProviderTurn,
	"0072_ingestion_leases": Migration0070IngestionLeases,
	"0073_session_inputs": Migration0071SessionInputs,
	"0074_input_ownership": Migration0072InputOwnership,
	"0075_question_expiry": Migration0073QuestionExpiry,
	"0076_plan_deliveries": Migration0074PlanDeliveries,
	"0077_context_handoffs": Migration0075ContextHandoffs,
	"0078_turn_activity_index": Migration0076TurnActivityIndex,
	"0079_fork_constructions": Migration0077ForkConstructions,
	"0080_session_checkpoints": Migration0078SessionCheckpoints,
	"0081_context_links": Migration0079ContextLinks,
	"0082_session_delegations": Migration0080SessionDelegations,
	"0083_provider_contexts": Migration0081ProviderContexts,
	"0084_execution_steps": Migration0082ExecutionSteps,
	"0085_native_checkpoint_history": Migration0083NativeCheckpointHistory,
	"0086_automation": Migration0086Automation,
} as const;

const MigrationDefinitions = {
	...MigrationDefinitionsThrough0086,
	"0087_scratch_folders": Migration0087ScratchFolders,
	"0088_scratch_folders_repair": Migration0088ScratchFoldersRepair,
	"0089_device_bridge_enrollment": Migration0089DeviceBridgeEnrollment,
} as const;

/** Schema before projectless threads, retained for populated upgrade fixtures. */
export const MigrationsThrough0086Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0086),
	}),
);

/** Shipped 0.16 schema boundary, exported for upgrade compatibility tests. */
export const MigrationsThrough0045Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0045),
	}),
);

/** Pre-device-bridge schema boundary for upgrade compatibility tests. */
export const MigrationsThrough0054Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0054),
	}),
);

export const MigrationsLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const tables =
			yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
		if (tables.length > 0) {
			yield* sql.withTransaction(
				Effect.gen(function* () {
					const legacy = yield* sql<{
						migration_id: number;
					}>`SELECT migration_id FROM effect_sql_migrations WHERE migration_id IN (61, 63) AND name = 'jobs'`;
					const boundary = legacy[0]?.migration_id;
					if (boundary === undefined) return;
					const rows = yield* sql<{
						migration_id: number;
						name: string;
					}>`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id >= ${boundary} ORDER BY migration_id DESC`;
					const names = [
						"jobs",
						"session_graph",
						"provider_thread_ownership",
						"job_attempt_ownership",
						"provider_reservations",
						"attempt_history",
						"attempt_provider_turn",
						"ingestion_leases",
						"session_inputs",
						"input_ownership",
						"question_expiry",
						"plan_deliveries",
						"context_handoffs",
						"turn_activity_index",
						"fork_constructions",
						"session_checkpoints",
						"context_links",
						"session_delegations",
						"provider_contexts",
						"execution_steps",
						"native_checkpoint_history",
					];
					for (const [index, row] of rows.entries()) {
						if (
							row.migration_id !== boundary + rows.length - 1 - index ||
							names[row.migration_id - boundary] !== row.name
						)
							return yield* Effect.die(
								new Error(
									"Unrecognized migration history after the legacy engine boundary",
								),
							);
					}
					if (boundary === 61) {
						yield* Migration0061HarnessExecutions;
						yield* Migration0062ModelConnections;
					}
					yield* Migration0063ProjectWorkspaceKey;
					yield* Migration0064ProviderAccounts;
					for (const row of rows)
						yield* sql`UPDATE effect_sql_migrations SET migration_id = ${row.migration_id + 65 - boundary} WHERE migration_id = ${row.migration_id}`;
					if (boundary === 61)
						yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (61,'harness_executions'),(62,'model_connections')`;
					yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (63,'project_workspace_key'),(64,'provider_accounts')`;
				}),
			);

			yield* sql.withTransaction(
				Effect.gen(function* () {
					const legacy = yield* sql<{
						migration_id: number;
					}>`SELECT migration_id FROM effect_sql_migrations WHERE migration_id IN (58, 59) AND name = 'collaboration_foundation'`;
					if (legacy.length === 0) return;
					const masters =
						yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 58 AND name = 'masters'`;
					if (legacy[0]?.migration_id === 58 || masters.length > 0) {
						yield* Migration0058QuestionAnswerDeliveries;
						yield* sql`UPDATE effect_sql_migrations SET name = 'question_answer_deliveries' WHERE migration_id = 58`;
					}
					if (legacy[0]?.migration_id === 58) {
						yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (59, 'event_sequence_index')`;
					} else {
						yield* sql`UPDATE effect_sql_migrations SET name = 'event_sequence_index' WHERE migration_id = 59`;
					}
					yield* Migration0059EventSequenceIndex;
					const recency =
						yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 60 AND name = 'chat_user_message_time'`;
					if (recency.length === 0) {
						yield* Migration0060ChatUserMessageTime;
						yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'chat_user_message_time')`;
					}
					yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'collaboration_foundation')`;
				}),
			);

			yield* sql.withTransaction(
				Effect.gen(function* () {
					const legacy =
						yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 61 AND name = 'collaboration_foundation'`;
					if (legacy.length === 0) return;
					yield* Migration0061HarnessExecutions;
					yield* sql`UPDATE effect_sql_migrations SET name = 'harness_executions' WHERE migration_id = 61`;
				}),
			);
		}
		yield* Migrator.make({})({
			loader: Migrator.fromRecord(MigrationDefinitions),
		});
	}),
);

/** Main's pre-recency schema boundary for upgrade compatibility tests. */
export const MigrationsThrough0059Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0059),
	}),
);

/** Historical main schema before the first engine rebase. */
export const MigrationsThrough0062Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0062),
	}),
);

/** Pre-engine schema, retained for real upgrade fixtures. */
export const MigrationsThrough0060Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0060),
	}),
);

/** Fixed historical engine boundary used to reproduce pre-rebase database upgrades. */
export const MigrationsThrough0073Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0073),
	}),
);

/** Main's published schema before the rebased engine migrations. */
export const MigrationsThrough0064Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(MigrationDefinitionsThrough0064),
	}),
);

/** Last unpublished engine ledger, retained to verify upgrades from real builds. */
export const LegacyMigrationsThrough0083Live = Layer.effectDiscard(
	Migrator.make({})({
		loader: Migrator.fromRecord(LegacyMigrationDefinitionsThrough0083),
	}),
);
