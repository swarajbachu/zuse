import type {
	AgentEvent,
	AgentItemId,
	AgentTurnId,
	ProviderEventEnvelope,
} from "@zuse/contracts";
import { Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSessionHandle } from "../../../src/kernel/driver.ts";
import { makeTurnScopedSessionHandle } from "../../../src/kernel/turn-protocol.ts";

const turnId = "turn-1" as AgentTurnId;
const itemId = "item-1" as AgentItemId;

const handleWithEvents = (
	events: ReadonlyArray<AgentEvent>,
): ProviderSessionHandle => ({
	events: Stream.fromIterable(events),
	send: () => Effect.void,
	interrupt: () => Effect.void,
	close: () => Effect.void,
	setPermissionMode: () => Effect.void,
	answerQuestion: () => Effect.void,
});

describe("turn-scoped provider protocol", () => {
	it("scopes provider events buffered during resume to the durable turn", async () => {
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([
					{ _tag: "AssistantMessage", itemId, text: "recovered" },
					{ _tag: "Status", status: "idle" },
				]),
				turnId,
			),
		);
		const events = Array.from(
			await Effect.runPromise(Stream.runCollect(scoped.events)),
		);

		expect(events).toEqual([
			{
				scope: "turn",
				turnId,
				event: { _tag: "AssistantMessage", itemId, text: "recovered" },
			},
			{
				scope: "turn",
				turnId,
				event: { _tag: "Completed", reason: "ended" },
			},
			{
				scope: "session",
				event: { _tag: "Status", status: "idle" },
			},
		]);
	});

	it("forwards one replay for an initially active durable turn", async () => {
		const send = vi.fn(() => Effect.void);
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle({ ...handleWithEvents([]), send }, turnId),
		);

		await Effect.runPromise(scoped.send(turnId, "recovered"));
		await Effect.runPromise(scoped.send(turnId, "duplicate"));

		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith("recovered");
	});

	it("preserves the supplied application turn id and emits one terminal", async () => {
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([
					{ _tag: "AssistantMessage", itemId, text: "hello" },
					{ _tag: "Completed", reason: "ended" },
					{ _tag: "Completed", reason: "ended" },
				]),
			),
		);
		await Effect.runPromise(scoped.send(turnId, "hi"));
		const events = await Effect.runPromise(Stream.runCollect(scoped.events));
		const values = Array.from(events) as ReadonlyArray<ProviderEventEnvelope>;

		expect(values).toEqual([
			{
				scope: "turn",
				turnId,
				event: { _tag: "AssistantMessage", itemId, text: "hello" },
			},
			{
				scope: "turn",
				turnId,
				event: { _tag: "Completed", reason: "ended" },
			},
		]);
	});

	it("targets interrupt at the exact current turn", async () => {
		const events = await Effect.runPromise(Queue.unbounded<AgentEvent>());
		const interrupt = vi.fn(() =>
			Queue.offer(events, { _tag: "Interrupted" }).pipe(Effect.asVoid),
		);
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle({
				...handleWithEvents([]),
				events: Stream.fromQueue(events),
				interrupt,
			}),
		);
		const eventFiber = Effect.runFork(Stream.runDrain(scoped.events));
		await Effect.runPromise(scoped.send(turnId, "hi"));
		await expect(
			Effect.runPromise(scoped.interrupt("turn-2" as AgentTurnId)),
		).rejects.toThrow(/turn-2.*turn-1/);
		await Effect.runPromise(scoped.interrupt(turnId));
		expect(interrupt).toHaveBeenCalledOnce();
		await Effect.runPromise(Fiber.interrupt(eventFiber));
	});

	it("waits for the interrupted provider turn to drain before admitting its successor", async () => {
		const sends: string[] = [];
		const successorTurnId = "turn-2" as AgentTurnId;

		await Effect.runPromise(
			Effect.gen(function* () {
				const events = yield* Queue.unbounded<AgentEvent>();
				const scoped = yield* makeTurnScopedSessionHandle({
					...handleWithEvents([]),
					events: Stream.fromQueue(events),
					send: (text) =>
						Effect.sync(() => {
							sends.push(text);
						}),
					interrupt: () =>
						Queue.offer(events, { _tag: "Interrupted" }).pipe(
							Effect.delay("20 millis"),
							Effect.forkDetach,
							Effect.asVoid,
						),
				});
				const eventFiber = yield* Stream.runDrain(scoped.events).pipe(
					Effect.forkDetach,
				);

				yield* scoped.send(turnId, "first");
				yield* scoped.interrupt(turnId);
				yield* scoped.send(successorTurnId, "second");
				yield* Fiber.interrupt(eventFiber);
			}),
		);

		expect(sends).toEqual(["first", "second"]);
	});

	it("deduplicates a replayed send for the same exact turn", async () => {
		const send = vi.fn(() => Effect.void);
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle({ ...handleWithEvents([]), send }),
		);
		await Effect.runPromise(scoped.send(turnId, "hi"));
		await Effect.runPromise(scoped.send(turnId, "hi"));
		expect(send).toHaveBeenCalledOnce();
	});

	it("releases a failed send so its durable intent can retry", async () => {
		let attempts = 0;
		const send = vi.fn(() => {
			attempts += 1;
			return attempts === 1 ? Effect.die(new Error("offline")) : Effect.void;
		});
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle({ ...handleWithEvents([]), send }),
		);

		await expect(Effect.runPromise(scoped.send(turnId, "hi"))).rejects.toThrow(
			"offline",
		);
		await Effect.runPromise(scoped.send(turnId, "hi"));
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("turn-scopes an error and synthesizes its exact terminal", async () => {
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([{ _tag: "Error", message: "provider exited" }]),
			),
		);
		await Effect.runPromise(scoped.send(turnId, "hi"));
		const events = Array.from(
			await Effect.runPromise(Stream.runCollect(scoped.events)),
		);

		expect(events).toEqual([
			{
				scope: "turn",
				turnId,
				event: { _tag: "Error", message: "provider exited" },
			},
			{
				scope: "turn",
				turnId,
				event: { _tag: "Completed", reason: "error" },
			},
		]);
	});

	it("synthesizes an exact error terminal when the provider stream fails", async () => {
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle({
				...handleWithEvents([]),
				events: Stream.die(new Error("process exited")),
			}),
		);
		await Effect.runPromise(scoped.send(turnId, "hi"));
		const events = Array.from(
			await Effect.runPromise(Stream.runCollect(scoped.events)),
		);

		expect(events.at(-1)).toEqual({
			scope: "turn",
			turnId,
			event: { _tag: "Completed", reason: "error" },
		});
	});
});
