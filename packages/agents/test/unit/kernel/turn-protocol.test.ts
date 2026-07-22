import type {
	AgentEvent,
	AgentItemId,
	AgentTurnId,
	ProviderEventEnvelope,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
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
		const interrupt = vi.fn(() => Effect.void);
		const base = { ...handleWithEvents([]), interrupt };
		const scoped = await Effect.runPromise(makeTurnScopedSessionHandle(base));
		await Effect.runPromise(scoped.send(turnId, "hi"));

		await Effect.runPromise(scoped.interrupt(turnId));
		expect(interrupt).toHaveBeenCalledOnce();
		await expect(
			Effect.runPromise(scoped.interrupt("turn-2" as AgentTurnId)),
		).rejects.toThrow(/turn-2.*turn-1/);
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
