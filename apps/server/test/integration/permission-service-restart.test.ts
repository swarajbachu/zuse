import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { FolderId, PermissionRequest, SessionId } from "@zuse/contracts";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, test } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { PermissionServiceLive } from "../../src/provider/layers/permission-service.ts";
import { PermissionService } from "../../src/provider/services/permission-service.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const makeRuntime = (filename: string, userData: string) => {
	const sql = sqliteLayer({ filename });
	const domain = SessionDomain.layer.pipe(
		Layer.provide(sql),
		Layer.provide(NodeServices.layer),
	);
	return ManagedRuntime.make(
		PermissionServiceLive.pipe(
			Layer.provideMerge(domain),
			Layer.provideMerge(sql),
			Layer.provide(Layer.succeed(AppPaths, { userData })),
		),
	);
};

const createSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE chats (
			id TEXT PRIMARY KEY, project_id TEXT, worktree_id TEXT, title TEXT,
			active_session_id TEXT, origin_session_id TEXT, archived_at TEXT,
			archived_worktree_json TEXT, last_message_at TEXT, last_read_at TEXT,
			created_at TEXT, updated_at TEXT
		)
	`;
	yield* sql`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
			provider_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
			archived_at TEXT, cursor TEXT, resume_strategy TEXT NOT NULL,
			runtime_mode TEXT NOT NULL, agents_json TEXT, worktree_id TEXT,
			chat_id TEXT NOT NULL, forked_from_session_id TEXT,
			forked_from_message_id TEXT, permission_mode TEXT NOT NULL,
			tool_search INTEGER NOT NULL, queue_paused INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
			kind TEXT NOT NULL, content_json TEXT NOT NULL, parent_item_id TEXT,
			created_at TEXT NOT NULL, sequence INTEGER NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
			correlation_id TEXT, causation_event_id TEXT, stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL, type TEXT NOT NULL,
			occurred_at TEXT NOT NULL, actor TEXT, payload_json TEXT NOT NULL,
			UNIQUE (stream_kind, stream_id, stream_version)
		)
	`;
	yield* sql`
		CREATE TABLE projector_cursors (
			projector_name TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE command_receipts (
			command_id TEXT PRIMARY KEY, stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
			event_ids_json TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE permission_decisions (
			request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
			kind_tag TEXT NOT NULL, kind_key TEXT NOT NULL, kind_json TEXT NOT NULL,
			decision TEXT NOT NULL, decided_at TEXT NOT NULL, project_id TEXT,
			scope TEXT NOT NULL DEFAULT 'session'
		)
	`;
	yield* sql`
		INSERT INTO chats (id, project_id, title, created_at, updated_at)
		VALUES ('chat-1', 'project-1', 'Chat', '1970-01-01T00:00:00.001Z',
			'1970-01-01T00:00:00.001Z')
	`;
});

const createSession = Effect.gen(function* () {
	const domain = yield* SessionDomain;
	yield* domain.dispatch({
		commandId: "create-session",
		streamId: "session-1",
		command: {
			_tag: "CreateSession",
			sessionId: "session-1",
			chatId: "chat-1",
			projectId: "project-1",
			title: "Session",
			providerId: "claude",
			model: "model-1",
			status: "running",
			cursor: null,
			resumeStrategy: "none",
			runtimeMode: "approval-required",
			agentsJson: null,
			worktreeId: null,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: "default",
			toolSearch: false,
			queuePaused: false,
			createdAt: 1,
		},
	});
});

describe("PermissionService restart recovery", () => {
	test("replays an unresolved durable request and accepts its decision", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-permission-restart-"));
		directories.push(directory);
		const filename = join(directory, "test.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(createSchema);
		await schemaRuntime.dispose();
		const first = makeRuntime(filename, directory);
		await first.runPromise(createSession);
		const requestFiber = first.runFork(
			Effect.flatMap(PermissionService, (service) =>
				service.request(
					SessionId.make("session-1"),
					{ _tag: "Bash", command: "git status" },
					{ projectId: FolderId.make("project-1") },
				),
			),
		);
		const [published] = await first.runPromise(
			Effect.flatMap(PermissionService, (service) =>
				service.requests().pipe(Stream.take(1), Stream.runCollect),
			),
		);
		expect(published).toBeInstanceOf(PermissionRequest);
		await first.dispose();
		await Effect.runPromise(Fiber.interrupt(requestFiber));

		const restarted = makeRuntime(filename, directory);
		try {
			const pending = await restarted.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.listPending(SessionId.make("session-1")),
				),
			);
			expect(pending.map((request) => request.id)).toEqual([published?.id]);
			await restarted.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.decide(published?.id ?? "missing", { _tag: "AllowOnce" }),
				),
			);
			const decisions = await restarted.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.listDecisions({ projectId: FolderId.make("project-1") }),
				),
			);
			expect(decisions.map((decision) => decision.requestId)).toEqual([
				published?.id,
			]);
		} finally {
			await restarted.dispose();
		}
	});
});
