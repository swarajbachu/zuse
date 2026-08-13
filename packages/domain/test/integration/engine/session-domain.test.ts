import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	type Scope,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import {
	makeSessionDomain,
	SessionDomain,
} from "../../../src/engine/session-domain.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
	Effect.runPromise(
		Effect.scoped(
			program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
		),
	);

const makeDomainRuntime = (filename: string, eventPrefix: string) => {
	const sqlite = sqliteLayer({ filename });
	let nextEventId = 0;
	const domain = Layer.effect(
		SessionDomain,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* makeSessionDomain(sql, () =>
				Effect.succeed(`${eventPrefix}-${++nextEventId}`),
			);
		}),
	).pipe(Layer.provideMerge(sqlite));
	return ManagedRuntime.make(domain);
};

describe("SessionDomain", () => {
	test("rolls back events and receipts when projection fails", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					CREATE TRIGGER fail_session_projection
					BEFORE INSERT ON sessions
					BEGIN
						SELECT RAISE(ABORT, 'projection failed');
					END
				`;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed("event-rollback"),
				);
				yield* domain
					.dispatch({
						commandId: "command-rollback",
						streamId: "session-1",
						command: createSessionCommand,
					})
					.pipe(Effect.flip);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events
				`;
				const receipts = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM command_receipts
				`;
				return {
					events: events[0]?.count ?? -1,
					receipts: receipts[0]?.count ?? -1,
				};
			}),
		);

		expect(result).toEqual({ events: 0, receipts: 0 });
	});

	test("rolls back events, projection, and receipt when a transactional callback fails", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed("event-callback-rollback"),
				);
				yield* domain
					.dispatchTransactionally(
						{
							commandId: "command-callback-rollback",
							streamId: "session-1",
							command: createSessionCommand,
						},
						() => Effect.fail("creation receipt failed" as const),
					)
					.pipe(Effect.flip);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events
				`;
				const receipts = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM command_receipts
				`;
				const sessions = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM sessions
				`;
				return {
					events: events[0]?.count ?? -1,
					receipts: receipts[0]?.count ?? -1,
					sessions: sessions[0]?.count ?? -1,
				};
			}),
		);

		expect(result).toEqual({ events: 0, receipts: 0, sessions: 0 });
	});

	test("dispatches, projects, and replays a durable receipt", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				const first = yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const restarted = yield* makeSessionDomain(sql, () =>
					Effect.succeed("unexpected-event"),
				);
				const replay = yield* restarted.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const sessions = yield* sql<{ readonly id: string }>`
					SELECT id FROM sessions
				`;
				const events = yield* sql<{ readonly event_id: string }>`
					SELECT event_id FROM events
				`;
				const cursor = yield* sql<{ readonly last_sequence: number }>`
					SELECT last_sequence FROM projector_cursors
					WHERE projector_name = 'session-read-model'
				`;
				return { first, replay, sessions, events, cursor };
			}),
		);

		expect(result.replay).toEqual(result.first);
		expect(result.sessions).toEqual([{ id: "session-1" }]);
		expect(result.events).toEqual([{ event_id: "event-1" }]);
		expect(result.cursor).toEqual([{ last_sequence: 1 }]);
	});

	test("projects provider replay cursors transactionally with resume state", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`resume-event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "create-for-resume",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "resume-with-provider-event",
					streamId: "session-1",
					command: {
						_tag: "SetResume",
						cursor: "provider-session",
						resumeStrategy: "grok-session-id",
						providerEventCursor: "provider-event-7",
						updatedAt: 2,
					},
				});
				return yield* sql<{
					readonly cursor: string | null;
					readonly resume_strategy: string;
					readonly provider_event_cursor: string | null;
				}>`
					SELECT cursor, resume_strategy, provider_event_cursor
					FROM sessions WHERE id = 'session-1'
				`;
			}),
		);

		expect(result).toEqual([
			{
				cursor: "provider-session",
				resume_strategy: "grok-session-id",
				provider_event_cursor: "provider-event-7",
			},
		]);
	});

	test("rebuilds checkpoint high-water and rejects stale content after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-checkpoint-"));
		const filename = join(directory, "checkpoint.sqlite");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* createDomainTestSchema();
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO chats (id, updated_at)
						VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
					`;
				}).pipe(Effect.provide(sqliteLayer({ filename }))),
			),
		);

		const firstRuntime = makeDomainRuntime(filename, "first-checkpoint");
		const secondRuntime = makeDomainRuntime(filename, "second-checkpoint");
		try {
			await firstRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						yield* domain.dispatch({
							commandId: "create",
							streamId: "session-1",
							command: createSessionCommand,
						});
						yield* domain.dispatch({
							commandId: "checkpoint-2",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson: '{"_tag":"assistant","text":"winner"}',
								parentItemId: null,
								checkpointRevision: 2,
								checkpointFinal: false,
								createdAt: 2,
							},
						});
					}),
				),
			);
			const result = await secondRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						const stale = yield* domain.dispatch({
							commandId: "checkpoint-1-late",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson: '{"_tag":"assistant","text":"stale"}',
								parentItemId: null,
								checkpointRevision: 1,
								checkpointFinal: false,
								createdAt: 3,
							},
						});
						const sql = yield* SqlClient.SqlClient;
						const messages = yield* sql<{
							readonly content_json: string;
							readonly checkpoint_revision: number;
						}>`
							SELECT content_json, checkpoint_revision FROM messages
							WHERE id = 'provider-message-1'
						`;
						return { stale, messages };
					}),
				),
			);
			expect(result.stale.eventIds).toEqual([]);
			expect(result.messages).toEqual([
				{
					content_json: '{"_tag":"assistant","text":"winner"}',
					checkpoint_revision: 2,
				},
			]);
		} finally {
			await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()]);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("replays then tails one ordered stream without duplicate receipts", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const replay = yield* domain
					.events({ streamId: "session-1" })
					.pipe(Stream.take(1), Stream.runCollect);
				const liveFiber = yield* domain
					.events({ streamId: "session-1", afterSequence: 1 })
					.pipe(
						Stream.take(1),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
				});
				const live = yield* Fiber.join(liveFiber);
				return { replay: [...replay], live: [...live] };
			}),
		);

		expect(result.replay.map(({ sequence }) => sequence)).toEqual([1]);
		expect(result.live.map(({ sequence }) => sequence)).toEqual([2]);
		expect(result.live[0]?.event._tag).toBe("SessionTitleSet");
	});

	test("replays and tails all session streams with one global cursor", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z'),
					       ('chat-2', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create-1",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const cursor = yield* domain.currentSequence;
				const liveFiber = yield* domain
					.allEvents({ afterSequence: cursor })
					.pipe(
						Stream.take(1),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* domain.dispatch({
					commandId: "command-create-2",
					streamId: "session-2",
					command: {
						...createSessionCommand,
						sessionId: "session-2",
						chatId: "chat-2",
					},
				});
				const live = yield* Fiber.join(liveFiber);
				return { cursor, live: [...live] };
			}),
		);

		expect(result.cursor).toBe(1);
		expect(result.live.map((event) => event.streamId)).toEqual(["session-2"]);
		expect(result.live.map((event) => event.sequence)).toEqual([2]);
	});

	test("publishes live events only after the session projection is current", async () => {
		const observedStatus = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const cursor = yield* domain.currentSequence;
				const observed = yield* domain
					.allEvents({ afterSequence: cursor })
					.pipe(
						Stream.take(1),
						Stream.mapEffect(() =>
							sql<{ readonly status: string }>`
								SELECT status FROM sessions WHERE id = 'session-1'
							`.pipe(Effect.map((rows) => rows[0]?.status ?? "missing")),
						),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* domain.dispatch({
					commandId: "command-running",
					streamId: "session-1",
					command: { _tag: "SetStatus", status: "running", updatedAt: 2 },
				});
				return yield* Fiber.join(observed);
			}),
		);

		expect(observedStatus).toMatchObject({
			_tag: "Some",
			value: "running",
		});
	});

	test("attaches live delivery before snapshot and emits a versioned barrier", async () => {
		const frames = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const collecting = yield* domain
					.synchronizedEvents({
						streamId: "session-1",
						hasProjection: false,
					})
					.pipe(
						Stream.take(3),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* Effect.yieldNow;
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
				});
				return [...(yield* Fiber.join(collecting))];
			}),
		);
		expect(frames[0]).toMatchObject({ kind: "snapshot", throughVersion: 1 });
		expect(frames[1]).toMatchObject({
			kind: "synchronized",
			streamEpoch: "legacy",
			throughVersion: 1,
		});
		expect(frames[2]).toMatchObject({
			kind: "event",
			record: { streamVersion: 2 },
		});
		expect(
			frames
				.flatMap((frame) =>
					frame.kind === "snapshot"
						? [frame.throughVersion]
						: frame.kind === "event"
							? [frame.record.streamVersion]
							: [],
				)
				.sort((left, right) => left - right),
		).toEqual([1, 2]);
	});

	test("tails durable session events dispatched by another runtime", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-session-domain-sync-"));
		const filename = join(directory, "shared.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
			}),
		);
		await schemaRuntime.dispose();
		const firstRuntime = makeDomainRuntime(filename, "first-event");
		const secondRuntime = makeDomainRuntime(filename, "second-event");
		try {
			await firstRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "command-create",
						streamId: "session-1",
						command: createSessionCommand,
					}),
				),
			);
			const synchronized = Deferred.makeUnsafe<void>();
			const collecting = secondRuntime.runFork(
				Effect.flatMap(SessionDomain, (domain) =>
					domain
						.synchronizedEvents({
							streamId: "session-1",
							afterVersion: 1,
							hasProjection: true,
						})
						.pipe(
							Stream.filter(
								(frame) =>
									frame.kind === "synchronized" ||
									(frame.kind === "event" &&
										frame.record.event._tag === "MessagePersisted"),
							),
							Stream.tap((frame) =>
								frame.kind === "synchronized"
									? Deferred.succeed(synchronized, undefined)
									: Effect.void,
							),
							Stream.take(2),
							Stream.runCollect,
						),
				),
			);
			await Effect.runPromise(Deferred.await(synchronized));
			await firstRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "command-submit-turn",
						streamId: "session-1",
						command: {
							_tag: "SubmitTurn",
							turnId: "turn-remote",
							messageId: "message-remote",
							role: "user",
							kind: "user",
							contentJson: '{"_tag":"user","text":"hello from web"}',
							parentItemId: null,
							providerInputJson: '{"text":"hello from web"}',
							createdAt: 2,
						},
					}),
				),
			);
			const frames = await Effect.runPromise(
				Fiber.join(collecting).pipe(Effect.timeout(1_000)),
			);

			expect([...frames]).toMatchObject([
				{ kind: "synchronized", throughVersion: 1 },
				{
					kind: "event",
					record: {
						streamVersion: 2,
						event: {
							_tag: "MessagePersisted",
							messageId: "message-remote",
							contentJson: '{"_tag":"user","text":"hello from web"}',
						},
					},
				},
			]);
		} finally {
			await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()]);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("replays only the retained session version prefix", async () => {
		const frames = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
				});
				return yield* domain
					.synchronizedEvents({
						streamId: "session-1",
						afterVersion: 1,
						hasProjection: true,
					})
					.pipe(Stream.take(2), Stream.runCollect);
			}),
		);

		expect([...frames]).toMatchObject([
			{ kind: "event", record: { streamVersion: 2 } },
			{ kind: "synchronized", throughVersion: 2 },
		]);
	});

	test("falls back to one bounded snapshot when the delta byte budget is exceeded", async () => {
		const frames = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: {
						_tag: "SetTitle",
						title: "A title that cannot fit in a one-byte delta budget",
						updatedAt: 2,
					},
				});
				return yield* domain
					.synchronizedEvents({
						streamId: "session-1",
						afterVersion: 1,
						hasProjection: true,
						maxDeltaBytes: 1,
					})
					.pipe(Stream.take(2), Stream.runCollect);
			}),
		);

		expect([...frames]).toMatchObject([
			{ kind: "snapshot", throughVersion: 2 },
			{ kind: "synchronized", throughVersion: 2 },
		]);
	});

	test("catches a completed disconnected turn through one bounded cursor without regression", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-client-reconnect-"));
		const filename = join(directory, "session.sqlite");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* createDomainTestSchema();
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO app_state (key, value)
						VALUES ('session_stream_epoch', 'epoch-reconnect')
					`;
					yield* sql`
						INSERT INTO chats (id, updated_at)
						VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
					`;
				}).pipe(Effect.provide(sqliteLayer({ filename }))),
			),
		);

		const runtimeBeforeDisconnect = makeDomainRuntime(filename, "before");
		let retainedVersion = 0;
		try {
			retainedVersion = await runtimeBeforeDisconnect.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						yield* domain.dispatch({
							commandId: "create-reconnect-session",
							streamId: "session-1",
							command: createSessionCommand,
						});
						const accepted = yield* domain.dispatch({
							commandId: "accepted-prompt",
							streamId: "session-1",
							command: {
								_tag: "SubmitTurn",
								turnId: "turn-1",
								messageId: "user-message-1",
								role: "user",
								kind: "user",
								contentJson:
									'{"_tag":"user","text":"finish while closed","goal":false}',
								parentItemId: null,
								providerInputJson:
									'{"text":"finish while closed","attachments":[],"fileRefs":[],"skillRefs":[]}',
								createdAt: 2,
							},
						});
						return accepted.streamVersion;
					}),
				),
			);
		} finally {
			await runtimeBeforeDisconnect.dispose();
		}

		// No client or old process is attached now. A fresh runtime continues the
		// provider turn from the shared SQLite log and durably checkpoints output.
		const runtimeWhileClientGone = makeDomainRuntime(filename, "background");
		try {
			await runtimeWhileClientGone.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						yield* domain.dispatch({
							commandId: "provider-checkpoint-1",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson:
									'{"_tag":"assistant","text":"partial","checkpoint":{"revision":1,"final":false}}',
								parentItemId: null,
								checkpointRevision: 1,
								checkpointFinal: false,
								createdAt: 3,
							},
						});
						yield* domain.dispatch({
							commandId: "provider-checkpoint-2",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson:
									'{"_tag":"assistant","text":"complete","checkpoint":{"revision":2,"final":true}}',
								parentItemId: null,
								checkpointRevision: 2,
								checkpointFinal: true,
								createdAt: 4,
							},
						});
						yield* domain.dispatch({
							commandId: "settle-background-turn",
							streamId: "session-1",
							command: {
								_tag: "SettleTurn",
								turnId: "turn-1",
								outcome: "completed",
								settledAt: 5,
							},
						});
					}),
				),
			);
		} finally {
			await runtimeWhileClientGone.dispose();
		}

		const reconnectRuntime = makeDomainRuntime(filename, "reconnect");
		try {
			const result = await reconnectRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						const frames = yield* domain
							.synchronizedEvents({
								streamId: "session-1",
								afterVersion: retainedVersion,
								streamEpoch: "epoch-reconnect",
								hasProjection: true,
							})
							.pipe(
								Stream.takeUntil((frame) => frame.kind === "synchronized"),
								Stream.runCollect,
							);
						const sql = yield* SqlClient.SqlClient;
						const messages = yield* sql<{
							readonly id: string;
							readonly content_json: string;
							readonly checkpoint_revision: number | null;
							readonly checkpoint_final: number | null;
						}>`
							SELECT id, content_json, checkpoint_revision, checkpoint_final
							FROM messages WHERE session_id = 'session-1'
							ORDER BY sequence
						`;
						const session = yield* sql<{
							readonly status: string;
							readonly current_turn_id: string | null;
						}>`
							SELECT status, current_turn_id FROM sessions
							WHERE id = 'session-1'
						`;
						return { frames: [...frames], messages, session };
					}),
				),
			);

			expect(result.frames.at(-1)).toMatchObject({
				kind: "synchronized",
				streamEpoch: "epoch-reconnect",
			});
			const eventFrames = result.frames.filter(
				(frame) => frame.kind === "event",
			);
			expect(eventFrames).toHaveLength(4);
			expect(eventFrames.map((frame) => frame.record.streamVersion)).toEqual(
				Array.from(
					{ length: eventFrames.length },
					(_, index) => retainedVersion + index + 1,
				),
			);
			expect(
				new Set(eventFrames.map((frame) => frame.record.eventId)).size,
			).toBe(eventFrames.length);
			expect(result.frames.some((frame) => frame.kind === "snapshot")).toBe(
				false,
			);
			expect(result.messages).toEqual([
				expect.objectContaining({ id: "user-message-1" }),
				{
					id: "provider-message-1",
					content_json:
						'{"_tag":"assistant","text":"complete","checkpoint":{"revision":2,"final":true}}',
					checkpoint_revision: 2,
					checkpoint_final: 1,
				},
			]);
			expect(result.session).toEqual([
				{ status: "idle", current_turn_id: null },
			]);
		} finally {
			await reconnectRuntime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("receipts fence a delayed interrupt from a successor turn", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`interrupt-event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "start-1",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 2 },
				});
				yield* domain.dispatch({
					commandId: "settle-1",
					streamId: "session-1",
					command: {
						_tag: "SettleTurn",
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 3,
					},
				});
				yield* domain.dispatch({
					commandId: "start-2",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-2", startedAt: 4 },
				});
				const stale = yield* domain.dispatch({
					commandId: "interrupt-stale",
					streamId: "session-1",
					command: {
						_tag: "RequestTurnInterrupt",
						expectedTurnId: "turn-1",
						requestedAt: 5,
					},
				});
				const current = yield* domain.dispatch({
					commandId: "interrupt-current",
					streamId: "session-1",
					command: {
						_tag: "RequestTurnInterrupt",
						expectedTurnId: "turn-2",
						requestedAt: 6,
					},
				});
				const interruptRows = yield* sql<{
					readonly turn_id: string | null;
				}>`
					SELECT json_extract(payload_json, '$.turnId') AS turn_id
					FROM events WHERE stream_id = 'session-1'
						AND type = 'TurnInterruptRequested'
					ORDER BY stream_version
				`;
				return { stale, current, interruptRows };
			}),
		);

		expect(result.stale.result).toEqual({
			_tag: "not-active",
			reason: "turn-mismatch",
			expectedTurnId: "turn-1",
			actualTurnId: "turn-2",
		});
		expect(result.stale.eventIds).toEqual([]);
		expect(result.current.result).toEqual({
			_tag: "requested",
			turnId: "turn-2",
		});
		expect(result.interruptRows).toEqual([{ turn_id: "turn-2" }]);
	});
});
