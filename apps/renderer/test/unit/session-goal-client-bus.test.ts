import {
	CommandId,
	EnvironmentId,
	SessionId,
	ThreadGoal,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearSessionGoal,
	resetSessionGoalClientBusForTest,
	retainSessionGoal,
	sessionGoalDriverStartsForTest,
	setSessionGoal,
} from "../../src/lib/session-goal-client-bus.ts";
import {
	getRendererClientBus,
	registerRendererResourcePersistence,
	resetSessionTimelineClientBusForTest,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const environmentId = EnvironmentId.make("goal-environment");
const sessionId = SessionId.make("goal-session");
const ref = { environmentId, sessionId } as const;

const goal = ThreadGoal.make({
	threadId: "thread-1",
	objective: "Ship the unified bus",
	status: "active",
	tokenBudget: 10_000,
	tokensUsed: 100,
	timeUsedSeconds: 2,
	createdAt: 1,
	updatedAt: 2,
});

describe("renderer session goal ClientBus adapter", () => {
	afterEach(() => {
		resetSessionGoalClientBusForTest();
		resetSessionTimelineClientBusForTest();
	});

	it("shares one qualified stream and applies provider goal updates", async () => {
		const events = Effect.runSync(
			Queue.unbounded<{ sessionId: SessionId; goal: ThreadGoal | null }>(),
		);
		let streamStarts = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.goal.stream": () => {
						streamStarts += 1;
						return Stream.fromQueue(events);
					},
				}) as never,
		);

		const first = retainSessionGoal(ref);
		const second = retainSessionGoal(ref);
		await waitUntil(() => streamStarts === 1);
		Queue.offerUnsafe(events, { sessionId, goal });
		await waitUntil(
			() => getRendererClientBus().snapshot(first.key).data?.goal === goal,
		);

		expect(sessionGoalDriverStartsForTest()).toBe(1);
		expect(getRendererClientBus().snapshot(second.key)).toMatchObject({
			connection: "connected",
			sync: "live",
			data: { goal },
		});
		first.lease.release();
		expect(streamStarts).toBe(1);
		second.lease.release();
	});

	it("fences identical session ids by environment", () => {
		const first = retainSessionGoal(ref, "cache-only");
		const other = retainSessionGoal(
			{ ...ref, environmentId: EnvironmentId.make("other-environment") },
			"cache-only",
		);

		expect(first.key).not.toEqual(other.key);
		first.lease.release();
		other.lease.release();
	});

	it("hydrates cached goal state without connecting", async () => {
		const unregister = registerRendererResourcePersistence("session-goal", {
			loadResource: async <Data>() =>
				({
					data: { goal },
					cursor: { epoch: "cached-goal", version: 4 },
					storedAt: 1,
				}) as import("@zuse/client-runtime/client-persistence").PersistedResource<Data>,
			saveResource: async () => undefined,
			removeResource: async () => undefined,
		});
		const retained = retainSessionGoal(ref, "cache-only");
		try {
			await waitUntil(
				() => getRendererClientBus().snapshot(retained.key).sync === "cached",
			);
			expect(getRendererClientBus().snapshot(retained.key)).toMatchObject({
				origin: "cache",
				connection: "dormant",
				data: { goal },
				cursor: { epoch: "cached-goal", version: 4 },
			});
			expect(sessionGoalDriverStartsForTest()).toBe(0);
		} finally {
			retained.lease.release();
			unregister();
		}
	});

	it("dispatches set and clear through the keyed command lane", async () => {
		const events = Effect.runSync(
			Queue.unbounded<{ sessionId: SessionId; goal: ThreadGoal | null }>(),
		);
		const calls: string[] = [];
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.goal.stream": () => Stream.fromQueue(events),
					"session.goal.set": () =>
						Effect.sync(() => {
							calls.push("set");
							return goal;
						}),
					"session.goal.clear": () =>
						Effect.sync(() => {
							calls.push("clear");
						}),
				}) as never,
		);

		const retained = retainSessionGoal(ref);
		await waitUntil(
			() =>
				getRendererClientBus().connection(environmentId).phase === "connected",
		);
		await setSessionGoal({
			ref,
			goal: { objective: goal.objective, status: "active" },
			commandId: CommandId.make("goal-set-command"),
		});
		await clearSessionGoal({
			ref,
			commandId: CommandId.make("goal-clear-command"),
		});

		expect(calls).toEqual(["set", "clear"]);
		expect(getRendererClientBus().snapshot(retained.key)).toMatchObject({
			pendingCommands: [],
			failedCommands: [],
		});
		// Commands do not overwrite canonical provider state before its stream
		// notification (Grok acknowledges mutations before goal_updated).
		expect(getRendererClientBus().snapshot(retained.key).data).toBeNull();
		retained.lease.release();
	});
});
