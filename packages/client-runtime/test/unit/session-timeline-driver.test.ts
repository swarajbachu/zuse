import {
	AgentTurnId,
	EnvironmentId,
	Message,
	MessageId,
	QueueState,
	SessionId,
	type SessionTimelineFrame,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type {
	ResourceDriverContext,
	ResourceDriverUpdate,
} from "../../src/client-bus.ts";
import { makeResourceKey, type ResourceKey } from "../../src/resource-ref.ts";
import type { ResourceCursor, ResourceView } from "../../src/resource-state.ts";
import {
	makeSessionTimelineResourceDriver,
	type SessionTimelineDriverClient,
} from "../../src/session-timeline-driver.ts";

const environmentId = EnvironmentId.make("environment-driver");
const sessionId = SessionId.make("session-driver");
const key = makeResourceKey<SessionTimelineProjection>("session-timeline", {
	environmentId,
	sessionId,
});
const turnId = AgentTurnId.make("turn-driver");
const projection = SessionTimelineProjection.make({
	messages: [],
	status: "running",
	currentTurn: { turnId, phase: "running" },
	queue: QueueState.make({ items: [], paused: false }),
	permissionMode: "default",
	runtimeMode: "approval-required",
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

type Harness<Data> = Readonly<{
	context: ResourceDriverContext<SessionTimelineDriverClient, Data>;
	updates: Array<ResourceDriverUpdate<Data>>;
	view: () => ResourceView<Data>;
}>;

const harness = <Data>(input: {
	key: ResourceKey<Data>;
	client: SessionTimelineDriverClient;
	data: Data | null;
	cursor: ResourceCursor | null;
}): Harness<Data> => {
	const updates: Array<ResourceDriverUpdate<Data>> = [];
	let view: ResourceView<Data> = {
		data: input.data,
		origin: input.data === null ? "none" : "cache",
		connection: "connected",
		sync: input.data === null ? "empty" : "cached",
		generation: 4,
		cursor: input.cursor,
		pendingCommands: [],
		failedCommands: [],
	};
	const context: ResourceDriverContext<SessionTimelineDriverClient, Data> = {
		key: input.key,
		client: input.client,
		generation: 4,
		data: input.data,
		cursor: input.cursor,
		snapshot: () => view,
		isCurrent: () => true,
		emit: (update) => {
			if (update.notify !== false) updates.push(update);
			view = {
				...view,
				data: update.data ?? view.data,
				cursor: update.cursor ?? view.cursor,
				sync: update.sync ?? view.sync,
			};
			return true;
		},
	};
	return { context, updates, view: () => view };
};

describe("shared session timeline resource driver", () => {
	it("renders the recent tail immediately while automatic history chunks complete", async () => {
		const frames = Effect.runSync(Queue.unbounded<SessionTimelineFrame>());
		const test = harness({
			key,
			client: { "session.events": () => Stream.fromQueue(frames) },
			data: null,
			cursor: null,
		});
		const driver = makeSessionTimelineResourceDriver({
			reportFailure: () => undefined,
		});
		driver.start(test.context);
		const recent = Message.make({
			id: MessageId.make("message-recent"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "recent" },
			createdAt: new Date(2),
		});
		const older = Message.make({
			id: MessageId.make("message-older"),
			sessionId,
			role: "user",
			content: { _tag: "user", text: "older" },
			createdAt: new Date(1),
		});
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 2,
			cursor: { epoch: "progressive", version: 2 },
			projection: {
				...projection,
				messages: [recent],
				olderMessageSequence: 2,
			},
			totalMessageCount: 2,
		});
		await waitUntil(() => test.view().data?.messages.length === 1);
		expect(test.updates.at(-1)).toMatchObject({ persist: false });
		Queue.offerUnsafe(frames, {
			kind: "snapshot-chunk",
			sessionId,
			throughVersion: 2,
			cursor: { epoch: "progressive", version: 2 },
			messages: [older],
			olderMessageSequence: null,
		});
		Queue.offerUnsafe(frames, {
			kind: "synchronized",
			sessionId,
			throughVersion: 2,
			cursor: { epoch: "progressive", version: 2 },
		});
		await waitUntil(() => test.view().sync === "live");
		expect(test.view().data?.messages).toEqual([older, recent]);
		expect(test.updates.at(-1)).toMatchObject({ persist: true });
		driver.stop();
	});

	it("requests an authoritative snapshot for a cached active turn", async () => {
		const requests: unknown[] = [];
		const driver = makeSessionTimelineResourceDriver({
			reportFailure: () => undefined,
		});
		const test = harness({
			key,
			client: {
				"session.events": (input) => {
					requests.push(input);
					return Stream.never;
				},
			},
			data: projection,
			cursor: { epoch: "cached", version: 454 },
		});

		driver.start(test.context);
		await waitUntil(() => requests.length === 1);
		expect(requests[0]).toMatchObject({
			afterVersion: 454,
			streamEpoch: "cached",
			hasProjection: false,
		});
		driver.stop();
	});

	it("requests an authoritative snapshot for an incomplete cached transcript", async () => {
		const requests: unknown[] = [];
		const driver = makeSessionTimelineResourceDriver({
			reportFailure: () => undefined,
		});
		const test = harness({
			key,
			client: {
				"session.events": (input) => {
					requests.push(input);
					return Stream.never;
				},
			},
			data: { ...projection, olderMessageSequence: 20 },
			cursor: { epoch: "cached-partial", version: 454 },
		});

		driver.start(test.context);
		await waitUntil(() => requests.length === 1);
		expect(requests[0]).toMatchObject({
			afterVersion: 454,
			streamEpoch: "cached-partial",
			hasProjection: false,
		});
		driver.stop();
	});

	it("owns projection, cursor, synchronization, and persistence", async () => {
		const frames = Effect.runSync(Queue.unbounded<SessionTimelineFrame>());
		const requests: unknown[] = [];
		const client: SessionTimelineDriverClient = {
			"session.events": (input) => {
				requests.push(input);
				return Stream.fromQueue(frames);
			},
		};
		const failures: unknown[] = [];
		const test = harness({ key, client, data: null, cursor: null });
		const driver =
			makeSessionTimelineResourceDriver<SessionTimelineDriverClient>({
				reportFailure: (_environmentId, _generation, cause) =>
					failures.push(cause),
			});
		driver.start(test.context);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 2,
			cursor: { epoch: "epoch-driver", version: 2 },
			projection,
		});
		const message = Message.make({
			id: MessageId.make("message-driver"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "shared" },
			createdAt: new Date(1),
		});
		Queue.offerUnsafe(frames, {
			kind: "event",
			sessionId,
			streamVersion: 3,
			cursor: { epoch: "epoch-driver", version: 3 },
			eventId: "event-driver",
			event: { _tag: "MessagePersisted", message },
		});
		Queue.offerUnsafe(frames, {
			kind: "synchronized",
			sessionId,
			throughVersion: 3,
			cursor: { epoch: "epoch-driver", version: 3 },
		});
		await waitUntil(() => test.view().sync === "live");

		expect(test.view().data?.messages).toEqual([message]);
		expect(test.view().cursor).toEqual({
			epoch: "epoch-driver",
			version: 3,
		});
		expect(requests).toEqual([
			{
				sessionId,
				afterVersion: undefined,
				streamEpoch: undefined,
				hasProjection: false,
			},
		]);
		expect(failures).toEqual([]);
		// Snapshot + replay deltas publish atomically at the synchronization
		// barrier, so reconnect never animates historical output token-by-token.
		expect(test.updates).toHaveLength(1);
		expect(test.updates.at(-1)).toMatchObject({
			sync: "live",
			persist: true,
		});
		driver.stop();
	});

	it("publishes a settled turn as idle on the retained live stream", async () => {
		const frames = Effect.runSync(Queue.unbounded<SessionTimelineFrame>());
		const test = harness({
			key,
			client: { "session.events": () => Stream.fromQueue(frames) },
			data: null,
			cursor: null,
		});
		const driver = makeSessionTimelineResourceDriver({
			reportFailure: () => undefined,
		});
		driver.start(test.context);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 1,
			cursor: { epoch: "settlement", version: 1 },
			projection,
		});
		Queue.offerUnsafe(frames, {
			kind: "synchronized",
			sessionId,
			throughVersion: 1,
			cursor: { epoch: "settlement", version: 1 },
		});
		await waitUntil(() => test.view().sync === "live");
		Queue.offerUnsafe(frames, {
			kind: "event",
			sessionId,
			streamVersion: 2,
			cursor: { epoch: "settlement", version: 2 },
			eventId: "event-settled",
			event: { _tag: "TurnSettled", turnId, outcome: "completed" },
		});

		await waitUntil(() => test.view().cursor?.version === 2);
		expect(test.view().data).toMatchObject({
			status: "idle",
			currentTurn: null,
		});
		expect(test.updates.at(-1)).toMatchObject({ persist: true });
		driver.stop();
	});

	it("checkpoints at one bounded timer without resetting on each delta", async () => {
		const frames = Effect.runSync(Queue.unbounded<SessionTimelineFrame>());
		const scheduled: Array<{ task: () => void; cancelled: boolean }> = [];
		const test = harness({
			key,
			client: { "session.events": () => Stream.fromQueue(frames) },
			data: null,
			cursor: null,
		});
		const driver =
			makeSessionTimelineResourceDriver<SessionTimelineDriverClient>({
				reportFailure: () => undefined,
				schedule: (_delay, task) => {
					const item = { task, cancelled: false };
					scheduled.push(item);
					return () => {
						item.cancelled = true;
					};
				},
			});
		driver.start(test.context);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "checkpoint", version: 0 },
			projection,
		});
		Queue.offerUnsafe(frames, {
			kind: "synchronized",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "checkpoint", version: 0 },
		});
		await waitUntil(() => test.view().sync === "live");
		for (let version = 1; version <= 2; version += 1) {
			Queue.offerUnsafe(frames, {
				kind: "event",
				sessionId,
				streamVersion: version,
				cursor: { epoch: "checkpoint", version },
				eventId: `event-${version}`,
				event: { _tag: "Noop" },
			});
		}
		await waitUntil(() => test.view().cursor?.version === 2);
		expect(scheduled).toHaveLength(1);
		scheduled[0]?.task();
		expect(test.updates.at(-1)).toMatchObject({ persist: true });
		driver.stop();
	});

	it("checkpoints the latest projection when its connection stops", async () => {
		const frames = Effect.runSync(Queue.unbounded<SessionTimelineFrame>());
		const test = harness({
			key,
			client: { "session.events": () => Stream.fromQueue(frames) },
			data: null,
			cursor: null,
		});
		const driver = makeSessionTimelineResourceDriver({
			reportFailure: () => undefined,
		});
		driver.start(test.context);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 1,
			cursor: { epoch: "disconnect", version: 1 },
			projection,
		});
		Queue.offerUnsafe(frames, {
			kind: "synchronized",
			sessionId,
			throughVersion: 1,
			cursor: { epoch: "disconnect", version: 1 },
		});
		await waitUntil(() => test.view().sync === "live");
		Queue.offerUnsafe(frames, {
			kind: "event",
			sessionId,
			streamVersion: 2,
			cursor: { epoch: "disconnect", version: 2 },
			eventId: "before-disconnect",
			event: { _tag: "Noop" },
		});
		await waitUntil(() => test.view().cursor?.version === 2);

		driver.stop();

		expect(test.updates.at(-1)).toMatchObject({
			cursor: { epoch: "disconnect", version: 2 },
			persist: true,
		});
	});

	it("accepts a bounded same-epoch reset snapshot", async () => {
		const frames = Effect.runSync(Queue.unbounded<SessionTimelineFrame>());
		const test = harness({
			key,
			client: { "session.events": () => Stream.fromQueue(frames) },
			data: projection,
			cursor: { epoch: "reset", version: 8 },
		});
		const driver =
			makeSessionTimelineResourceDriver<SessionTimelineDriverClient>({
				reportFailure: () => undefined,
			});
		driver.start(test.context);
		Queue.offerUnsafe(frames, {
			kind: "reset-required",
			sessionId,
			throughVersion: 3,
			cursor: { epoch: "reset", version: 3 },
			reason: "cursor-invalid",
		});
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 3,
			cursor: { epoch: "reset", version: 3 },
			projection,
		});
		Queue.offerUnsafe(frames, {
			kind: "synchronized",
			sessionId,
			throughVersion: 3,
			cursor: { epoch: "reset", version: 3 },
		});
		await waitUntil(() => test.view().sync === "live");

		expect(test.view().cursor).toEqual({ epoch: "reset", version: 3 });
		expect(test.updates).toHaveLength(1);
		expect(test.updates[0]).toMatchObject({ sync: "live", persist: true });
		driver.stop();
	});

	it("reports one generation-fenced continuity failure", async () => {
		const frames = Effect.runSync(Queue.unbounded<SessionTimelineFrame>());
		const failures: Array<{
			environmentId: EnvironmentId;
			generation: number;
			message: string;
		}> = [];
		const test = harness({
			key,
			client: { "session.events": () => Stream.fromQueue(frames) },
			data: null,
			cursor: null,
		});
		const driver =
			makeSessionTimelineResourceDriver<SessionTimelineDriverClient>({
				reportFailure: (reportedEnvironmentId, generation, cause) => {
					failures.push({
						environmentId: reportedEnvironmentId,
						generation,
						message: cause instanceof Error ? cause.message : String(cause),
					});
				},
			});
		driver.start(test.context);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 2,
			cursor: { epoch: "gap", version: 2 },
			projection,
		});
		Queue.offerUnsafe(frames, {
			kind: "event",
			sessionId,
			streamVersion: 4,
			cursor: { epoch: "gap", version: 4 },
			eventId: "gap-event",
			event: { _tag: "Noop" },
		});
		await waitUntil(() => failures.length === 1);
		expect(test.view()).toMatchObject({
			sync: "failed",
			cursor: { epoch: "gap", version: 2 },
		});
		expect(failures[0]).toMatchObject({
			environmentId,
			generation: 4,
			message: expect.stringMatching(/expected version 3/i),
		});
		driver.stop();
	});
});
