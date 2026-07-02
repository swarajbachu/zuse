import * as Migrator from "@effect/sql/Migrator";
import { Layer } from "effect";

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
export const MigrationsLive = Layer.effectDiscard(
  Migrator.make({})({
    loader: Migrator.fromRecord({
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
    }),
  }),
);
