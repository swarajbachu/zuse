import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { verifyBackfillDatabase } from "../../src/persistence/backfill-verifier.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";

describe("backfill verifier", () => {
	test("rebuilds a synthetic legacy database byte-for-byte", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-backfill-source-"));
		const filename = join(directory, "source.sqlite");
		const sqlite = sqliteLayer({ filename, disableWAL: true });
		const runtime = ManagedRuntime.make(
			Layer.merge(sqlite, MigrationsLive.pipe(Layer.provide(sqlite))),
		);
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const createdAt = "2026-01-01T00:00:00.000Z";
					const messageAt = "2026-01-02T00:00:00.000Z";
					const sessionUpdatedAt = "2026-01-03T00:00:00.000Z";
					const createdAtMs = Date.parse(createdAt);
					yield* sql`
            INSERT INTO projects (id, path, name, created_at, updated_at)
            VALUES ('project-1', '/tmp/project-1', 'Project', ${createdAt}, ${createdAt})
          `;
					yield* sql`
            INSERT INTO chats
              (id, project_id, worktree_id, title, active_session_id,
               origin_session_id, archived_at, archived_worktree_json,
               last_message_at, last_read_at, created_at, updated_at)
            VALUES
              ('chat-1', 'project-1', NULL, 'Existing title', NULL,
               NULL, NULL, NULL, ${messageAt}, ${createdAt}, ${createdAt}, ${messageAt})
          `;
					yield* sql`
            INSERT INTO sessions
              (id, project_id, title, provider_id, model, status, archived_at,
               cursor, resume_strategy, runtime_mode, agents_json, worktree_id,
               chat_id, forked_from_session_id, forked_from_message_id,
               permission_mode, tool_search, queue_paused, created_at, updated_at)
            VALUES
              ('session-1', 'project-1', 'Existing title', 'claude', 'model-1',
               'idle', NULL, NULL, 'none', 'approval-required', NULL, NULL,
							   'chat-1', NULL, NULL, 'default', 0, 1, ${createdAt}, ${sessionUpdatedAt})
					  `;
					yield* sql`
            INSERT INTO messages
              (id, session_id, role, kind, content_json, parent_item_id,
               created_at, sequence)
            VALUES
              ('message-1', 'session-1', 'user', 'user',
               '{"_tag":"user","text":"hello","goal":false}', NULL,
               ${messageAt}, NULL)
          `;
					yield* sql`
            INSERT INTO events
              (event_id, correlation_id, causation_event_id, stream_kind,
               stream_id, stream_version, type, occurred_at, actor, payload_json)
            VALUES
              ('live-chat-created', 'live-chat-created', NULL, 'chat', 'chat-1', 1,
               'ChatCreated', ${createdAt}, 'user', ${JSON.stringify({
									_tag: "ChatCreated",
									chatId: "chat-1",
									projectId: "project-1",
									worktreeId: null,
									title: "Existing title",
									originSessionId: null,
									lastReadAt: createdAtMs,
									createdAt: createdAtMs,
								})}),
              ('live-session-created', 'live-session-created', NULL, 'session',
               'session-1', 1, 'SessionCreated', ${createdAt}, 'user', ${JSON.stringify(
									{
										_tag: "SessionCreated",
										sessionId: "session-1",
										chatId: "chat-1",
										projectId: "project-1",
										title: "Existing title",
										providerId: "claude",
										model: "model-1",
										status: "idle",
										cursor: null,
										resumeStrategy: "none",
										runtimeMode: "approval-required",
										agentsJson: null,
										worktreeId: null,
										forkedFromSessionId: null,
										forkedFromMessageId: null,
										permissionMode: "default",
										toolSearch: false,
										queuePaused: true,
										createdAt: createdAtMs,
									},
								)})
          `;
				}),
			);
			await runtime.dispose();

			await expect(verifyBackfillDatabase(filename)).resolves.toBeUndefined();
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
