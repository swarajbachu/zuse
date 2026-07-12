import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ChatEvent } from "@zuse/domain/chat/events";
import { SessionEvent } from "@zuse/domain/core/events";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import { makeSqlChatProjector } from "@zuse/domain/projectors/sql-chat-projector";
import { makeSqlSessionProjector } from "@zuse/domain/projectors/sql-session-projector";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { runLifecycleBackfill } from "./backfill.ts";
import { MigrationsLive } from "./migrations.ts";

interface EventRow {
	readonly sequence: number;
	readonly event_id: string;
	readonly correlation_id: string | null;
	readonly causation_event_id: string | null;
	readonly stream_kind: "chat" | "session";
	readonly stream_id: string;
	readonly stream_version: number;
	readonly occurred_at: string;
	readonly actor: string | null;
	readonly payload_json: string;
}

interface ReadModelSnapshot {
	readonly chats: ReadonlyArray<Record<string, unknown>>;
	readonly sessions: ReadonlyArray<Record<string, unknown>>;
	readonly messages: ReadonlyArray<Record<string, unknown>>;
}

interface StreamInvariantRow {
	readonly stream_kind: string;
	readonly stream_id: string;
	readonly event_count: number;
	readonly min_version: number;
	readonly max_version: number;
}

interface DuplicateCreationRow {
	readonly stream_kind: string;
	readonly stream_id: string;
	readonly type: string;
	readonly event_count: number;
}

const decodeChatEvent = Schema.decodeUnknownSync(
	Schema.fromJsonString(ChatEvent),
);
const decodeSessionEvent = Schema.decodeUnknownSync(
	Schema.fromJsonString(SessionEvent),
);

const snapshotReadModels = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const chats = yield* sql<Record<string, unknown>>`
    SELECT * FROM chats ORDER BY id
  `;
	const sessions = yield* sql<Record<string, unknown>>`
    SELECT * FROM sessions ORDER BY id
  `;
	const messages = yield* sql<Record<string, unknown>>`
    SELECT * FROM messages ORDER BY id
  `;
	return { chats, sessions, messages } satisfies ReadModelSnapshot;
});

const assertEventInvariants = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const brokenStreams = yield* sql<StreamInvariantRow>`
    SELECT stream_kind, stream_id, COUNT(*) AS event_count,
           MIN(stream_version) AS min_version,
           MAX(stream_version) AS max_version
    FROM events
    GROUP BY stream_kind, stream_id
    HAVING MIN(stream_version) <> 1 OR MAX(stream_version) <> COUNT(*)
  `;
	if (brokenStreams.length > 0) {
		throw new Error(
			`non-contiguous stream versions: ${JSON.stringify(brokenStreams)}`,
		);
	}
	const duplicateCreations = yield* sql<DuplicateCreationRow>`
    SELECT stream_kind, stream_id, type, COUNT(*) AS event_count
    FROM events
    WHERE type IN ('ChatCreated', 'SessionCreated')
    GROUP BY stream_kind, stream_id, type
    HAVING COUNT(*) > 1
  `;
	if (duplicateCreations.length > 0) {
		throw new Error(
			`duplicate creation events: ${JSON.stringify(duplicateCreations)}`,
		);
	}
});

const rebuildReadModels = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const events = yield* sql<EventRow>`
    SELECT sequence, event_id, correlation_id, causation_event_id,
           stream_kind, stream_id, stream_version, occurred_at, actor,
           payload_json
    FROM events
    WHERE stream_kind IN ('chat', 'session')
    ORDER BY sequence
  `;

	yield* sql`PRAGMA foreign_keys = OFF`;
	yield* sql`DELETE FROM messages`;
	yield* sql`DELETE FROM sessions`;
	yield* sql`DELETE FROM chats`;
	yield* sql`
    DELETE FROM projector_cursors
    WHERE projector_name IN ('chat-read-model', 'session-read-model')
  `;

	const chatProjector = makeSqlChatProjector(sql);
	const sessionProjector = makeSqlSessionProjector(sql);
	for (const row of events) {
		const common = {
			eventId: row.event_id,
			correlationId: row.correlation_id ?? row.event_id,
			causationEventId: row.causation_event_id,
			streamId: row.stream_id,
			streamVersion: row.stream_version,
			sequence: row.sequence,
			occurredAt: row.occurred_at,
			actor: row.actor,
		};
		if (row.stream_kind === "chat") {
			yield* chatProjector.apply({
				...common,
				event: decodeChatEvent(row.payload_json),
			});
		} else {
			yield* sessionProjector.apply({
				...common,
				event: decodeSessionEvent(row.payload_json),
			} as StoredEvent);
		}
	}
	yield* sql`PRAGMA foreign_keys = ON`;
});

const snapshotMismatch = (
	expected: ReadModelSnapshot,
	actual: ReadModelSnapshot,
): string | null => {
	for (const table of ["chats", "sessions", "messages"] as const) {
		const expectedRows = expected[table];
		const actualRows = actual[table];
		const length = Math.max(expectedRows.length, actualRows.length);
		for (let index = 0; index < length; index += 1) {
			const expectedRow = expectedRows[index];
			const actualRow = actualRows[index];
			if (JSON.stringify(expectedRow) !== JSON.stringify(actualRow)) {
				return [
					`${table} differs after sequence-zero replay at row ${index}`,
					`expected=${JSON.stringify(expectedRow)}`,
					`actual=${JSON.stringify(actualRow)}`,
				].join("; ");
			}
		}
	}
	return null;
};

export const verifyBackfillDatabase = async (source: string): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-backfill-verify-"));
	const filename = join(directory, basename(source));
	await copyFile(source, filename);
	const sqlite = sqliteLayer({ filename, disableWAL: true });
	const runtime = ManagedRuntime.make(
		Layer.merge(sqlite, MigrationsLive.pipe(Layer.provide(sqlite))),
	);
	try {
		const result = await runtime.runPromise(runLifecycleBackfill);
		await runtime.runPromise(assertEventInvariants);
		const expected = await runtime.runPromise(snapshotReadModels);
		await runtime.runPromise(rebuildReadModels);
		const actual = await runtime.runPromise(snapshotReadModels);
		const mismatch = snapshotMismatch(expected, actual);
		if (mismatch !== null) throw new Error(`${source}: ${mismatch}`);
		console.log(
			JSON.stringify({
				database: source,
				backfill: result.status,
				eventCount: result.eventCount,
				chats: actual.chats.length,
				sessions: actual.sessions.length,
				messages: actual.messages.length,
				verified: true,
			}),
		);
	} finally {
		await runtime.dispose();
		await rm(directory, { recursive: true, force: true });
	}
};
