import type {
	AgentEvent,
	AgentItemId,
	AgentTurnId,
	AttemptId,
	ProviderEventEnvelope,
} from "@zuse/contracts";
import { type Cause, Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type {
	GoalCapableSessionHandle,
	ProviderDriverEvent,
	ProviderSessionHandle,
} from "../../../src/kernel/driver.ts";
import { makeTurnScopedSessionHandle } from "../../../src/kernel/turn-protocol.ts";

const turnId = "turn-1" as AgentTurnId;
const itemId = "item-1" as AgentItemId;

const handleWithEvents = (
	events: ReadonlyArray<ProviderDriverEvent>,
): ProviderSessionHandle => ({
	events: Stream.fromIterable(events),
	send: () => Effect.void,
	interrupt: () => Effect.void,
	close: () => Effect.void,
	setPermissionMode: () => Effect.void,
	answerQuestion: () => Effect.void,
});

describe("turn-scoped provider protocol", () => {
	it("binds native goal output and completion to the durable attempt before setGoal executes", async () => {
		let admittedExecutions = 0;
		const native: GoalCapableSessionHandle = {
			...handleWithEvents([
				{
					_tag: "NativeTurnStarted",
					reference: {
						provider: "codex",
						nativeThreadId: "goal-thread",
						nativeTurnId: "first",
					},
				},
				{
					_tag: "NativeTurnStarted",
					reference: {
						provider: "codex",
						nativeThreadId: "goal-thread",
						nativeTurnId: "second",
					},
				},
				{ _tag: "AssistantMessage", itemId, text: "goal result" },
				{ _tag: "Completed", reason: "ended" },
			]),
			getGoal: () => Effect.succeed(null),
			clearGoal: () => Effect.void,
			setGoal: (_goal, options) =>
				Effect.sync(() => {
					if (options?.execute) admittedExecutions += 1;
					return {
						threadId: "grok-thread",
						objective: "work",
						status: "active",
						tokenBudget: null,
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 1,
						updatedAt: 1,
					};
				}),
		};
		const attemptId = "goal-attempt" as AttemptId;
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(native, turnId, attemptId),
		);
		await Effect.runPromise(
			scoped.sendGoal(turnId, { objective: "work", status: "active" }),
		);
		await Effect.runPromise(
			scoped.sendGoal(turnId, { objective: "work", status: "active" }),
		);
		expect(admittedExecutions).toBe(1);
		const events = await Effect.runPromise(Stream.runCollect(scoped.events));
		expect(events.map((value) => value.event._tag)).toEqual([
			"AssistantMessage",
			"Completed",
		]);
		expect(
			events.every(
				(value) =>
					value.scope === "turn" && value.ownership?.attemptId === attemptId,
			),
		).toBe(true);
	});

	it("correlates native execution only while the attempt is active", async () => {
		const native: AgentEvent = {
			_tag: "NativeTurnStarted",
			reference: {
				provider: "codex",
				nativeThreadId: "native-thread",
				nativeTurnId: "native-turn",
			},
		};
		const attemptId = "attempt-1" as AttemptId;
		const idle = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([native]),
				turnId,
				attemptId,
			),
		);
		expect(await Effect.runPromise(Stream.runCollect(idle.events))).toEqual([]);
		const active = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([
					native,
					{ _tag: "Completed", reason: "ended" },
					native,
				]),
				turnId,
				attemptId,
			),
		);
		await Effect.runPromise(active.send(turnId, "run"));
		const events = await Effect.runPromise(Stream.runCollect(active.events));
		expect(
			events.filter((envelope) => envelope.event._tag === "NativeTurnStarted"),
		).toEqual([
			{
				scope: "turn",
				turnId,
				ownership: { turnId, attemptId },
				event: native,
			},
		]);
	});

	it("rejects an unsent attempt whose event stream already ended", async () => {
		let sends = 0;
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				{
					...handleWithEvents([]),
					send: () =>
						Effect.sync(() => {
							sends++;
						}),
				},
				turnId,
				"attempt-dead" as AttemptId,
			),
		);
		await Effect.runPromise(Stream.runCollect(scoped.events));
		const result = await Effect.runPromise(
			scoped.send(turnId, "must not disappear").pipe(Effect.result),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "ProviderHandleUnavailable" },
		});
		expect(sends).toBe(0);
	});

	it("keeps attempt ownership on buffered events and never rebinds a finished handle", async () => {
		let sends = 0;
		const attemptId = "attempt-1" as AttemptId;
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				{
					...handleWithEvents([
						{ _tag: "AssistantMessage", itemId, text: "late response" },
						{ _tag: "Completed", reason: "ended" },
						{
							_tag: "SessionCursor",
							strategy: "claude-session-id",
							cursor: "native-head",
						},
					]),
					send: () =>
						Effect.sync(() => {
							sends++;
						}),
				},
				turnId,
				attemptId,
			),
		);
		await Effect.runPromise(scoped.send(turnId, "first"));
		const events = Array.from(
			await Effect.runPromise(Stream.runCollect(scoped.events)),
		);
		expect(events).toHaveLength(3);
		expect(events.map((event) => event.ownership)).toEqual(
			Array(3).fill({ turnId, attemptId }),
		);
		await Effect.runPromise(scoped.send(turnId, "duplicate"));
		expect(sends).toBe(1);
		await expect(
			Effect.runPromise(scoped.send("turn-other" as AgentTurnId, "new")),
		).rejects.toThrow("requires its own handle");
	});
	it("does not mistake startup idle for completion of an unsent attempt", async () => {
		const events = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const idle = yield* Deferred.make<void>();
					const sent = yield* Deferred.make<void>();
					const scoped = yield* makeTurnScopedSessionHandle(
						{
							...handleWithEvents([]),
							events: Stream.concat(
								Stream.succeed<ProviderDriverEvent>({
									_tag: "Status",
									status: "idle",
								}),
								Stream.fromEffect(
									Deferred.await(sent).pipe(
										Effect.as<ProviderDriverEvent>({
											_tag: "Completed",
											reason: "ended",
										}),
									),
								),
							),
							send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
						},
						turnId,
						"attempt-1" as AttemptId,
					);
					const consumer = yield* Effect.forkScoped(
						Stream.runCollect(
							scoped.events.pipe(
								Stream.tap((event) =>
									event.event._tag === "Status"
										? Deferred.succeed(idle, undefined)
										: Effect.void,
								),
							),
						),
					);
					yield* Deferred.await(idle);
					yield* scoped.send(turnId, "first");
					return Array.from(yield* Fiber.join(consumer));
				}),
			),
		);
		expect(events.map((event) => event.event._tag)).toEqual([
			"Status",
			"Completed",
		]);
	});

	it.each([
		false,
		true,
	])("preserves question lifecycle outside an active turn (after completion=%s)", async (afterCompletion) => {
		const question: AgentEvent = {
			_tag: "UserQuestion",
			itemId,
			questions: [{ question: "Continue?", options: ["Yes"] }],
		};
		const resolution: AgentEvent = {
			_tag: "UserQuestionResolved",
			itemId,
			resolution: "timed-out",
		};
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([
					{ _tag: "Completed", reason: "ended" },
					question,
					resolution,
					{ _tag: "AssistantMessage", itemId, text: "uncorrelated" },
				]),
			),
		);
		if (afterCompletion) await Effect.runPromise(scoped.send(turnId, "start"));
		const events = await Effect.runPromise(Stream.runCollect(scoped.events));
		expect(
			events.filter((envelope) => envelope.event._tag !== "Completed"),
		).toEqual([
			{ scope: "session", event: question },
			{ scope: "session", event: resolution },
		]);
	});

	it("forwards ephemeral question callback release independently of turn state", async () => {
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([
					{
						_tag: "QuestionCallbackReleased",
						itemId,
						reason: "transport_lost",
					},
				]),
			),
		);

		expect(
			Array.from(await Effect.runPromise(Stream.runCollect(scoped.events))),
		).toEqual([
			{
				scope: "session",
				event: {
					_tag: "QuestionCallbackReleased",
					itemId,
					reason: "transport_lost",
				},
			},
		]);
	});
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

	it("attributes background work to its spawning turn and opens provider turns", async () => {
		const agentId = "agent-1" as AgentItemId;
		const scoped = await Effect.runPromise(
			makeTurnScopedSessionHandle(
				handleWithEvents([
					{ _tag: "ProviderTurnStarted" },
					{
						_tag: "ToolUse",
						itemId: agentId,
						tool: "Agent",
						input: { prompt: "build", run_in_background: true },
					},
					{ _tag: "Completed", reason: "ended" },
					{
						_tag: "AssistantMessage",
						itemId: "child-1" as AgentItemId,
						text: "working",
						parentItemId: agentId,
					},
					{
						_tag: "SubagentSummary",
						itemId: agentId,
						agentName: "builder",
						model: "inherit",
						turns: 1,
						durationMs: 5,
						summary: "built",
						isError: false,
					},
					{ _tag: "ProviderTurnStarted" },
					{ _tag: "AssistantMessage", itemId, text: "builder finished" },
					{ _tag: "Completed", reason: "ended" },

					{ _tag: "AssistantMessage", itemId, text: "stray" },
				]),
			),
		);
		await Effect.runPromise(scoped.send(turnId, "start builders"));
		const events = Array.from(
			await Effect.runPromise(Stream.runCollect(scoped.events)),
		) as ReadonlyArray<ProviderEventEnvelope>;

		expect(
			events.map((envelope) => [
				envelope.scope === "turn" ? envelope.turnId : null,
				envelope.event._tag,
			]),
		).toEqual([
			[turnId, "ToolUse"],
			[turnId, "Completed"],
			[turnId, "AssistantMessage"],
			[turnId, "SubagentSummary"],
			[expect.stringMatching(/^turn_/), "ProviderTurnStarted"],
			[expect.stringMatching(/^turn_/), "AssistantMessage"],
			[expect.stringMatching(/^turn_/), "Completed"],
		]);
		const providerTurns = new Set(
			events
				.slice(4)
				.map((envelope) =>
					envelope.scope === "turn" ? envelope.turnId : null,
				),
		);
		expect(providerTurns.size).toBe(1);
		expect(providerTurns.has(turnId)).toBe(false);
	});

	it("routes a background child to its origin while a later turn runs", async () => {
		const agentId = "agent-1" as AgentItemId;
		const secondTurnId = "turn-2" as AgentTurnId;
		await Effect.runPromise(
			Effect.gen(function* () {
				const events = yield* Queue.make<AgentEvent, Cause.Done>();
				const scoped = yield* makeTurnScopedSessionHandle({
					...handleWithEvents([]),
					events: Stream.fromQueue(events),
				});
				yield* scoped.send(turnId, "first");
				yield* Queue.offerAll(events, [
					{
						_tag: "ToolUse",
						itemId: agentId,
						tool: "Agent",
						input: { prompt: "build", run_in_background: true },
					},
					{ _tag: "Completed", reason: "ended" },
				]);
				const firstBatch = yield* Stream.take(scoped.events, 2).pipe(
					Stream.runCollect,
				);
				expect(Array.from(firstBatch).length).toBe(2);
				yield* scoped.send(secondTurnId, "second");
				yield* Queue.offerAll(events, [
					{
						_tag: "ToolUse",
						itemId: "child-tool" as AgentItemId,
						tool: "Read",
						input: {},
						parentItemId: agentId,
					},
					{ _tag: "AssistantMessage", itemId, text: "reply" },
				]);
				yield* Queue.end(events);
				const rest = Array.from(
					yield* Stream.runCollect(scoped.events),
				) as ReadonlyArray<ProviderEventEnvelope>;
				expect(
					rest.map((envelope) =>
						envelope.scope === "turn" ? envelope.turnId : null,
					),
				).toEqual([turnId, secondTurnId, secondTurnId, secondTurnId]);
				expect(rest.at(-1)?.event).toEqual({
					_tag: "Completed",
					reason: "error",
				});
			}),
		);
	});

	it("adopts a provider-opened turn into a racing application send", async () => {
		const send = vi.fn(() => Effect.void);
		await Effect.runPromise(
			Effect.gen(function* () {
				const events = yield* Queue.make<AgentEvent, Cause.Done>();
				const scoped = yield* makeTurnScopedSessionHandle({
					...handleWithEvents([]),
					events: Stream.fromQueue(events),
					send,
				});
				yield* Queue.offerAll(events, [
					{ _tag: "ProviderTurnStarted" },
					{ _tag: "AssistantMessage", itemId, text: "woke up" },
				]);
				const opened = Array.from(
					yield* Stream.take(scoped.events, 2).pipe(Stream.runCollect),
				) as ReadonlyArray<ProviderEventEnvelope>;
				const providerTurn =
					opened[0]?.scope === "turn" ? opened[0].turnId : undefined;
				expect(providerTurn).toMatch(/^turn_/);

				yield* scoped.send(turnId, "hi");
				yield* Queue.offerAll(events, [
					{ _tag: "AssistantMessage", itemId, text: "reply" },
					{ _tag: "Completed", reason: "ended" },
				]);
				yield* Queue.end(events);
				const rest = Array.from(
					yield* Stream.runCollect(scoped.events),
				) as ReadonlyArray<ProviderEventEnvelope>;
				expect(
					rest.map((envelope) =>
						envelope.scope === "turn" ? envelope.turnId : null,
					),
				).toEqual([turnId, turnId]);
			}),
		);
		expect(send).toHaveBeenCalledOnce();
	});
});

const childSpawn: AgentEvent = {
	_tag: "ToolUse",
	itemId,
	tool: "Custom delegated tool",
	input: {},
	subagent: { childSessionId: "native-child", presentation: "detached" },
};
const childSummary: AgentEvent = {
	_tag: "SubagentSummary",
	itemId,
	agentName: "Worker",
	model: "test",
	turns: 1,
	durationMs: 1,
	summary: "Done",
	isError: false,
	childSessionId: "native-child",
	presentation: "detached",
};

it("keeps exact child output after physical root completion and settles once after its summary", async () => {
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			handleWithEvents([
				childSpawn,
				{ _tag: "Completed", reason: "ended" },
				{
					_tag: "AssistantMessage",
					itemId: "child-message" as AgentItemId,
					parentItemId: itemId,
					text: "Still finishing",
				},
				childSummary,
				{ _tag: "Completed", reason: "ended" },
				{
					_tag: "AssistantMessage",
					itemId: "late" as AgentItemId,
					text: "stale",
				},
			]),
			turnId,
		),
	);
	const events = await Effect.runPromise(Stream.runCollect(scoped.events));
	expect(events.map((e) => e.event._tag)).toEqual([
		"ToolUse",
		"SubagentProgress",
		"AssistantMessage",
		"SubagentSummary",
		"Completed",
	]);
	expect(events[1]?.event).toMatchObject({ rootCompleted: true });
	expect(events.every((e) => e.scope === "turn" && e.turnId === turnId)).toBe(
		true,
	);
});
it("forwards a running child's progress update after root completion", async () => {
	const progress: AgentEvent = {
		...childSpawn,
		input: { workflow_progress: { phases: [], agents: [] } },
	};
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			handleWithEvents([
				childSpawn,
				{ _tag: "Completed", reason: "ended" },
				progress,
				childSummary,
			]),
			turnId,
		),
	);
	const events = await Effect.runPromise(Stream.runCollect(scoped.events));
	expect(events.map((e) => e.event._tag)).toEqual([
		"ToolUse",
		"SubagentProgress",
		"ToolUse",
		"SubagentSummary",
		"Completed",
	]);
	expect(events[2]?.event).toBe(progress);
});
it("does not wait for a child that already finished before the root", async () => {
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			handleWithEvents([
				childSpawn,
				childSummary,
				{ _tag: "Completed", reason: "ended" },
			]),
			turnId,
		),
	);
	expect(
		(await Effect.runPromise(Stream.runCollect(scoped.events))).map(
			(e) => e.event._tag,
		),
	).toEqual(["ToolUse", "SubagentSummary", "Completed"]);
});
it.each([
	"error",
	"interrupted",
	"missing",
] as const)("closes owned native processes before publishing %s terminal with open children", async (mode) => {
	let closed = false;
	const ending: AgentEvent[] =
		mode === "missing"
			? []
			: mode === "interrupted"
				? [{ _tag: "Interrupted" }]
				: [{ _tag: "Error", message: "failed" }];
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			{
				...handleWithEvents([
					childSpawn,
					{ _tag: "Completed", reason: "ended" },
					...ending,
				]),
				close: () =>
					Effect.sleep("10 millis").pipe(
						Effect.andThen(
							Effect.sync(() => {
								closed = true;
							}),
						),
					),
			},
			turnId,
		),
	);
	const events = await Effect.runPromise(
		scoped.events.pipe(
			Stream.tap((e) =>
				Effect.sync(() => {
					if (e.event._tag === "Completed") expect(closed).toBe(true);
				}),
			),
			Stream.runCollect,
		),
	);
	expect(events.filter((e) => e.event._tag === "Completed")).toHaveLength(1);
	expect(events.at(-1)?.event).toMatchObject({
		_tag: "Completed",
		reason: mode === "interrupted" ? "interrupted" : "error",
	});
});
it("interrupts the child-draining window even though the native root already ended", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const events = yield* Queue.unbounded<AgentEvent>();
				const rootFinished = yield* Deferred.make<void>();
				let closed = false;
				const scoped = yield* makeTurnScopedSessionHandle(
					{
						...handleWithEvents([]),
						events: Stream.fromQueue(events),
						interrupt: () => Effect.die("native root is already finished"),
						close: () =>
							Effect.sync(() => {
								closed = true;
							}),
					},
					turnId,
				);
				const result = yield* Effect.forkChild(
					scoped.events.pipe(
						Stream.tap((e) =>
							e.event._tag === "SubagentProgress"
								? Deferred.succeed(rootFinished, undefined)
								: Effect.void,
						),
						Stream.take(5),
						Stream.runCollect,
					),
				);
				yield* Queue.offer(events, childSpawn);
				yield* Queue.offer(events, { _tag: "Completed", reason: "ended" });
				yield* Deferred.await(rootFinished);
				yield* scoped.interrupt(turnId);
				const collected = yield* Fiber.join(result);
				expect(closed).toBe(true);
				expect(collected.at(-1)?.event).toMatchObject({
					_tag: "Completed",
					reason: "interrupted",
				});
			}),
		),
	);
});

it("does not publish a terminal event when native process quiescence fails", async () => {
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			{
				...handleWithEvents([childSpawn, { _tag: "Interrupted" }]),
				close: () => Effect.die("process still alive"),
			},
			turnId,
		),
	);
	const received: ProviderDriverEvent[] = [];
	const exit = await Effect.runPromise(
		scoped.events.pipe(
			Stream.tap((e) =>
				Effect.sync(() => {
					received.push(e.event);
				}),
			),
			Stream.runDrain,
			Effect.exit,
		),
	);
	expect(exit._tag).toBe("Failure");
	expect(received.some((event) => event._tag === "Completed")).toBe(false);
});
it("does not reopen a finished child when a provider repeats its spawn item", async () => {
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			handleWithEvents([
				childSpawn,
				childSummary,
				childSpawn,
				{ _tag: "Completed", reason: "ended" },
			]),
			turnId,
		),
	);
	const events = await Effect.runPromise(Stream.runCollect(scoped.events));
	expect(events.at(-1)?.event).toMatchObject({
		_tag: "Completed",
		reason: "ended",
	});
	expect(events.some((e) => e.event._tag === "SubagentProgress")).toBe(false);
});

it.each([
	"closed",
	"error",
] as const)("joins native children before terminal provider status %s", async (status) => {
	let closed = false;
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			{
				...handleWithEvents([childSpawn, { _tag: "Status", status }]),
				close: () =>
					Effect.sync(() => {
						closed = true;
					}),
			},
			turnId,
		),
	);
	const events = await Effect.runPromise(
		scoped.events.pipe(
			Stream.tap((e) =>
				Effect.sync(() => {
					if (
						e.event._tag === "SubagentSummary" ||
						e.event._tag === "Completed"
					)
						expect(closed).toBe(true);
				}),
			),
			Stream.runCollect,
		),
	);
	expect(
		events.some((e) => e.event._tag === "SubagentSummary" && e.event.isError),
	).toBe(true);
	expect(events.filter((e) => e.event._tag === "Completed")).toHaveLength(1);
});

it("keeps a background shell task alive after root completion until its explicit result arrives", async () => {
	const task: AgentEvent = {
		_tag: "ToolUse",
		itemId,
		tool: "Bash",
		input: { command: "work" },
		backgroundTask: { taskId: "background-shell" },
	};
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			handleWithEvents([
				task,
				{ _tag: "Completed", reason: "ended" },
				{ _tag: "ToolResult", itemId, output: "Finished", isError: false },
			]),
			turnId,
		),
	);
	const events = await Effect.runPromise(Stream.runCollect(scoped.events));
	expect(events.map((e) => e.event._tag)).toEqual([
		"ToolUse",
		"SubagentProgress",
		"ToolResult",
		"Completed",
	]);
	expect(events[1]?.event).toMatchObject({
		rootCompleted: true,
		childSessionId: "background-shell",
	});
});

it("interrupts an autonomous goal between native turns only after process quiescence", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const events = yield* Queue.unbounded<AgentEvent>();
				const closing = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let terminal = false;
				const native: GoalCapableSessionHandle = {
					...handleWithEvents([]),
					events: Stream.fromQueue(events),
					getGoal: () => Effect.succeed(null),
					clearGoal: () => Effect.void,
					setGoal: () =>
						Effect.succeed({
							threadId: "goal",
							objective: "work",
							status: "active",
							tokenBudget: null,
							tokensUsed: 0,
							timeUsedSeconds: 0,
							createdAt: 1,
							updatedAt: 1,
						}),
					interrupt: () => Effect.die("no physical turn to interrupt"),
					close: () =>
						Deferred.succeed(closing, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
				};
				const scoped = yield* makeTurnScopedSessionHandle(
					native,
					turnId,
					"attempt-goal" as AttemptId,
				);
				yield* scoped.sendGoal(turnId, { objective: "work", status: "active" });
				const result = yield* scoped.events.pipe(
					Stream.tap((e) =>
						Effect.sync(() => {
							if (e.event._tag === "Completed") terminal = true;
						}),
					),
					Stream.takeUntil((e) => e.event._tag === "Completed"),
					Stream.runCollect,
					Effect.forkChild,
				);
				const stop = yield* scoped.interrupt(turnId).pipe(Effect.forkChild);
				yield* Deferred.await(closing);
				expect(terminal).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(stop);
				expect((yield* Fiber.join(result)).at(-1)?.event).toEqual({
					_tag: "Completed",
					reason: "interrupted",
				});
			}),
		),
	);
});

it("does not attach a completed application's attempt to a provider-started turn", async () => {
	const attemptId = "attempt-background" as AttemptId;
	const scoped = await Effect.runPromise(
		makeTurnScopedSessionHandle(
			handleWithEvents([
				{ _tag: "Completed", reason: "ended" },
				{ _tag: "ProviderTurnStarted" },
				{ _tag: "AssistantMessage", itemId, text: "background continuation" },
				{ _tag: "Completed", reason: "ended" },
			]),
			turnId,
			attemptId,
		),
	);
	await Effect.runPromise(scoped.send(turnId, "run"));
	const events = await Effect.runPromise(Stream.runCollect(scoped.events));
	expect(events[0]?.ownership).toEqual({ turnId, attemptId });
	const continuation = events.slice(1);
	expect(continuation.map((value) => value.event._tag)).toEqual([
		"ProviderTurnStarted",
		"AssistantMessage",
		"Completed",
	]);
	expect(
		continuation.every(
			(value) =>
				value.scope === "turn" &&
				value.turnId !== turnId &&
				value.ownership === undefined,
		),
	).toBe(true);
});

it("still sends an admitted attempt when a provider-only turn finishes before delivery", async () => {
	let sends = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const queue = yield* Queue.unbounded<ProviderDriverEvent>();
				const completed = yield* Deferred.make<void>();
				const scoped = yield* makeTurnScopedSessionHandle(
					{
						...handleWithEvents([]),
						events: Stream.fromQueue(queue),
						send: () =>
							Effect.sync(() => {
								sends++;
							}),
					},
					turnId,
					"attempt-before-send" as AttemptId,
				);
				yield* Effect.forkScoped(
					Stream.runForEach(scoped.events, (value) =>
						value.event._tag === "Completed"
							? Deferred.succeed(completed, undefined)
							: Effect.void,
					),
				);
				yield* Queue.offer(queue, { _tag: "ProviderTurnStarted" });
				yield* Queue.offer(queue, { _tag: "Completed", reason: "ended" });
				yield* Deferred.await(completed);
				yield* scoped.send(turnId, "run");
			}),
		),
	);
	expect(sends).toBe(1);
});

it.each([
	"agent",
	"process",
] as const)("stops one owned background %s without interrupting its parent or peers", async (kind) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const events = yield* Queue.unbounded<AgentEvent>();
			const rootFinished = yield* Deferred.make<void>();
			const taskFinished = yield* Deferred.make<void>();
			const stop = vi.fn(() => Effect.void);
			const interrupt = vi.fn(() => Effect.void);
			const scoped = yield* makeTurnScopedSessionHandle(
				{
					...handleWithEvents([]),
					events: Stream.fromQueue(events),
					stopBackgroundTask: stop,
					interrupt,
				},
				turnId,
			);
			const fiber = yield* scoped.events.pipe(
				Stream.tap((envelope) => {
					if (envelope.event._tag === "SubagentProgress")
						return Deferred.succeed(rootFinished, undefined);
					if (envelope.event._tag === "Completed")
						return Deferred.succeed(taskFinished, undefined);
					return Effect.void;
				}),
				Stream.runDrain,
				Effect.forkChild,
			);
			const spawn: AgentEvent =
				kind === "agent"
					? childSpawn
					: {
							_tag: "ToolUse",
							itemId,
							tool: "Bash",
							input: {},
							backgroundTask: { taskId: "native-child" },
						};
			yield* Queue.offer(events, spawn);
			yield* Queue.offer(events, { _tag: "Completed", reason: "ended" });
			yield* Deferred.await(rootFinished);
			const stale = yield* scoped
				.stopBackgroundTask("another-turn" as AgentTurnId, "native-child")
				.pipe(Effect.result);
			expect(stale._tag).toBe("Failure");
			yield* scoped.stopBackgroundTask(turnId, "unrelated-task");
			expect(stop).not.toHaveBeenCalled();
			yield* scoped.stopBackgroundTask(turnId, "native-child");
			expect(stop).toHaveBeenCalledExactlyOnceWith("native-child");
			expect(interrupt).not.toHaveBeenCalled();
			// A successful stop request is not a terminal event. The native outcome settles the task.
			expect(yield* Deferred.isDone(taskFinished)).toBe(false);
			yield* Queue.offer(
				events,
				kind === "agent"
					? childSummary
					: { _tag: "ToolResult", itemId, output: "Stopped", isError: true },
			);
			yield* Deferred.await(taskFinished);
			yield* Fiber.interrupt(fiber);
		}),
	);
});

it.each([
	"unsupported",
	"provider-error",
	"foreground",
] as const)("reports %s task stop failures without claiming completion", async (reason) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const events = yield* Queue.unbounded<AgentEvent>();
			const launched = yield* Deferred.make<void>();
			const stop = vi.fn(() =>
				reason === "provider-error"
					? Effect.fail(new Error("Stop rejected"))
					: Effect.void,
			);
			const scoped = yield* makeTurnScopedSessionHandle(
				{
					...handleWithEvents([]),
					events: Stream.fromQueue(events),
					...(reason === "unsupported" ? {} : { stopBackgroundTask: stop }),
				},
				turnId,
			);
			const fiber = yield* scoped.events.pipe(
				Stream.tap((envelope) =>
					envelope.event._tag === "ToolUse"
						? Deferred.succeed(launched, undefined)
						: Effect.void,
				),
				Stream.runDrain,
				Effect.forkChild,
			);
			yield* Queue.offer(events, {
				...childSpawn,
				subagent: {
					childSessionId: "native-child",
					presentation: reason === "foreground" ? "inline" : "detached",
				},
			} as AgentEvent);
			yield* Deferred.await(launched);
			const result = yield* scoped
				.stopBackgroundTask(turnId, "native-child")
				.pipe(Effect.result);
			expect(result._tag).toBe("Failure");
			if (reason !== "provider-error") expect(stop).not.toHaveBeenCalled();
			yield* Fiber.interrupt(fiber);
		}),
	);
});
