import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, test } from "vitest";
import type { SessionCommand } from "../core/commands.js";
import { createSessionCommand } from "../test/session.js";
import { DispatchEngine, InMemoryDispatchStorage } from "./dispatch.js";

const create: SessionCommand = createSessionCommand;

const run = Effect.runPromise;

describe("DispatchEngine", () => {
	test("returns the original receipt when a command is re-dispatched", async () => {
		const storage = new InMemoryDispatchStorage();
		let nextId = 0;
		const engine = new DispatchEngine(storage, () =>
			Effect.succeed(`event-${++nextId}`),
		);

		const [first, replay] = await run(
			Effect.gen(function* () {
				const first = yield* engine.dispatch({
					commandId: "command-1",
					streamId: "session-1",
					command: create,
				});
				const replay = yield* engine.dispatch({
					commandId: "command-1",
					streamId: "session-1",
					command: create,
				});
				return [first, replay] as const;
			}),
		);

		expect(replay).toEqual(first);
		expect(first.eventIds).toEqual(["event-1"]);
		expect(storage.eventsFor("session-1")).toHaveLength(1);
	});

	test("serializes every distinct concurrent command on one stream", async () => {
		const storage = new InMemoryDispatchStorage();
		let nextId = 0;
		const engine = new DispatchEngine(storage, () =>
			Effect.succeed(`event-${++nextId}`),
		);

		const created = engine.dispatch({
			commandId: "command-create",
			streamId: "session-1",
			command: create,
		});
		const titled = engine.dispatch({
			commandId: "command-title",
			streamId: "session-1",
			command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
		});
		const retitled = engine.dispatch({
			commandId: "command-retitle",
			streamId: "session-1",
			command: { _tag: "SetTitle", title: "Renamed again", updatedAt: 3 },
		});

		const [createReceipt, titleReceipt, retitleReceipt] = await run(
			Effect.all([created, titled, retitled], { concurrency: "unbounded" }),
		);
		expect(createReceipt.streamVersion).toBe(1);
		expect(titleReceipt.streamVersion).toBe(2);
		expect(retitleReceipt.streamVersion).toBe(3);
		expect(
			storage.eventsFor("session-1").map((event) => event.event._tag),
		).toEqual(["SessionCreated", "SessionTitleSet", "SessionTitleSet"]);
	});

	test("does not append events when the decider rejects a command", async () => {
		const storage = new InMemoryDispatchStorage();
		const engine = new DispatchEngine(storage, () => Effect.succeed("unused"));
		await expect(
			run(
				engine.dispatch({
					commandId: "command-title",
					streamId: "missing",
					command: { _tag: "SetTitle", title: "No session", updatedAt: 1 },
				}),
			),
		).rejects.toMatchObject({ _tag: "SessionNotFound" });
		expect(storage.eventsFor("missing")).toEqual([]);
	});

	test("allows different streams to dispatch concurrently", async () => {
		const calls: string[] = [];
		await run(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>();
				const base = new InMemoryDispatchStorage();
				const storage = {
					receipt: base.receipt.bind(base),
					append: base.append.bind(base),
					events: (streamId: string) =>
						Effect.gen(function* () {
							calls.push(streamId);
							if (streamId === "session-a") yield* Deferred.await(gate);
							return yield* base.events(streamId);
						}),
				};
				let nextId = 0;
				const engine = new DispatchEngine(storage, () =>
					Effect.succeed(`event-${++nextId}`),
				);
				const dispatched = Effect.all(
					[
						engine.dispatch({
							commandId: "command-a",
							streamId: "session-a",
							command: { ...create, sessionId: "session-a" },
						}),
						engine.dispatch({
							commandId: "command-b",
							streamId: "session-b",
							command: { ...create, sessionId: "session-b" },
						}),
					],
					{ concurrency: "unbounded" },
				);
				const fiber = yield* dispatched.pipe(
					Effect.forkChild({ startImmediately: true }),
				);
				yield* Effect.yieldNow;
				expect(calls).toEqual(["session-a", "session-b"]);
				yield* Deferred.succeed(gate, undefined);
				yield* Fiber.join(fiber);
			}),
		);
	});

	test("records correlation and causation metadata on emitted events", async () => {
		const storage = new InMemoryDispatchStorage();
		const engine = new DispatchEngine(storage, () => Effect.succeed("event-1"));

		await run(
			engine.dispatch({
				commandId: "reactor:event-0:0",
				streamId: "session-1",
				correlationId: "request-1",
				causationEventId: "event-0",
				command: create,
			}),
		);

		expect(storage.eventsFor("session-1")[0]).toMatchObject({
			correlationId: "request-1",
			causationEventId: "event-0",
		});
	});
});
