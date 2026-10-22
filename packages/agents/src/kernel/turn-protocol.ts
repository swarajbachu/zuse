import type {
	AgentEvent,
	AgentItemId,
	AgentTurnId,
	AttemptId,
	ProviderAttemptOwnership,
	ProviderEventEnvelope,
	ThreadGoalSetInput,
} from "@zuse/contracts";
import { Deferred, Effect, Queue, Ref, Schema, Stream } from "effect";
import type {
	GoalCapableSessionHandle,
	ProviderDriverEvent,
	ProviderSessionHandle,
	QuestionCallbackReleased,
} from "./driver.ts";

export type TurnScopedProviderEventEnvelope =
	| ProviderEventEnvelope
	| {
			readonly scope: "session";
			readonly ownership?: ProviderAttemptOwnership;
			readonly event: QuestionCallbackReleased;
	  };

type NativeChild = Extract<AgentEvent, { _tag: "ToolUse" }> & {
	readonly nativeChildId: string;
	readonly childKind: "subagent" | "background";
};

type ActiveTurn = {
	readonly turnId: AgentTurnId;
	readonly released: Deferred.Deferred<void>;
	readonly sent: boolean;

	readonly origin: "application" | "provider";
	readonly children: ReadonlyMap<string, NativeChild>;
	readonly completedChildren: ReadonlySet<string>;
	readonly pendingCompletion?: Extract<AgentEvent, { _tag: "Completed" }>;
};

const MAX_ITEM_TURNS = 4096;

const terminalEventTags = new Set<AgentEvent["_tag"]>([
	"Completed",
	"Interrupted",
	"Error",
]);

type NormalizedBatch = {
	readonly events: ReadonlyArray<TurnScopedProviderEventEnvelope>;
	readonly released?: Deferred.Deferred<void>;
};

export class ProviderHandleUnavailable extends Schema.TaggedErrorClass<ProviderHandleUnavailable>()(
	"ProviderHandleUnavailable",
	{ reason: Schema.String },
) {}

export interface TurnScopedProviderSessionHandle
	extends Omit<
		ProviderSessionHandle,
		"events" | "send" | "interrupt" | "stopBackgroundTask"
	> {
	readonly events: Stream.Stream<TurnScopedProviderEventEnvelope>;
	readonly send: (
		turnId: AgentTurnId,
		...args: Parameters<ProviderSessionHandle["send"]>
	) => Effect.Effect<void, ProviderHandleUnavailable>;
	readonly sendGoal: (
		turnId: AgentTurnId,
		goal: ThreadGoalSetInput,
		fallbackObjective?: string,
	) => Effect.Effect<void, ProviderHandleUnavailable>;
	readonly stopBackgroundTask: (
		turnId: AgentTurnId,
		taskId: string,
	) => Effect.Effect<void, Error>;
	readonly interrupt: (turnId: AgentTurnId) => Effect.Effect<void>;
}

const sessionEventTags = new Set<AgentEvent["_tag"]>([
	"Started",
	"Auth",
	"Version",
	"Capabilities",
	"SessionCursor",
	"ProviderNotificationMetadata",
	"PermissionModeChanged",
	"GoalUpdated",
	"GoalCleared",
	"UsageLimit",
]);

const sessionEnvelope = (
	event: AgentEvent | QuestionCallbackReleased,
): TurnScopedProviderEventEnvelope => {
	if (event._tag === "QuestionCallbackReleased") {
		return { scope: "session", event };
	}
	return { scope: "session", event };
};

const turnEnvelope = (
	turnId: AgentTurnId,
	event: AgentEvent,
): ProviderEventEnvelope => ({ scope: "turn", turnId, event });

const parentItemIdOf = (event: AgentEvent): string | undefined =>
	"parentItemId" in event && typeof event.parentItemId === "string"
		? event.parentItemId
		: undefined;

const referencesToolUse = (
	event: AgentEvent,
): event is Extract<AgentEvent, { readonly itemId: AgentItemId }> =>
	event._tag === "ToolUse" ||
	event._tag === "ToolResult" ||
	event._tag === "SubagentSummary";

const stoppedChildren = (
	active: ActiveTurn,
): ReadonlyArray<ProviderEventEnvelope> =>
	[...active.children.values()].map((child) =>
		turnEnvelope(
			active.turnId,
			child.childKind === "background"
				? {
						_tag: "ToolResult",
						itemId: child.itemId,
						output: "Background task stopped when its parent execution ended.",
						isError: true,
					}
				: {
						_tag: "SubagentSummary",
						itemId: child.itemId,
						childSessionId: child.nativeChildId,
						presentation: child.subagent?.presentation ?? "detached",
						agentName: "Delegated work",
						model: "unknown",
						turns: 0,
						durationMs: 0,
						summary: "Child stopped when its parent execution ended.",
						isError: true,
					},
		),
	);

/**
 * Converts every legacy provider handle at one kernel boundary. This is the
 * only place allowed to correlate native events with an application turn.
 * The server admits at most one provider turn through this handle, so a new
 * send cannot silently supersede an unsettled turn.
 */
export const makeTurnScopedSessionHandle = (
	handle: ProviderSessionHandle,
	initialTurnId?: AgentTurnId,
	initialAttemptId?: AttemptId,
): Effect.Effect<TurnScopedProviderSessionHandle> =>
	Effect.gen(function* () {
		if (initialAttemptId !== undefined && initialTurnId === undefined)
			return yield* Effect.die(
				new Error("An attempt-bound handle requires a turn id"),
			);
		const ownership =
			initialTurnId !== undefined && initialAttemptId !== undefined
				? { turnId: initialTurnId, attemptId: initialAttemptId }
				: undefined;
		const injected = yield* Queue.unbounded<ProviderDriverEvent>();
		const finished = yield* Ref.make(false);
		const ended = yield* Ref.make(false);
		const initialReleased = yield* Deferred.make<void>();
		let goalOwned = false;
		const activeTurn = yield* Ref.make<ActiveTurn | null>(
			initialTurnId === undefined || ownership !== undefined
				? null
				: {
						turnId: initialTurnId,
						released: initialReleased,
						sent: false,
						origin: "application",
						children: new Map<string, NativeChild>(),
						completedChildren: new Set<string>(),
					},
		);

		const itemTurns = new Map<string, AgentTurnId>();
		const rememberItem = (event: AgentEvent, turnId: AgentTurnId) => {
			if (event._tag !== "ToolUse") return;
			itemTurns.delete(event.itemId);
			itemTurns.set(event.itemId, turnId);
			if (itemTurns.size > MAX_ITEM_TURNS) {
				const oldest = itemTurns.keys().next().value;
				if (oldest !== undefined) itemTurns.delete(oldest);
			}
		};
		const originTurnOf = (event: AgentEvent): AgentTurnId | undefined => {
			if (terminalEventTags.has(event._tag)) return undefined;
			const parent = parentItemIdOf(event);
			const fromParent =
				parent === undefined ? undefined : itemTurns.get(parent);
			if (fromParent !== undefined) return fromParent;
			return referencesToolUse(event) ? itemTurns.get(event.itemId) : undefined;
		};
		const releaseBatch = (
			batch: NormalizedBatch,
		): Effect.Effect<ReadonlyArray<TurnScopedProviderEventEnvelope>> =>
			(batch.released === undefined
				? Effect.void
				: Deferred.succeed(batch.released, undefined).pipe(
						Effect.andThen(
							ownership === undefined ||
								batch.events.some(
									(event) =>
										event.scope === "turn" &&
										event.turnId === ownership.turnId &&
										event.event._tag === "Completed",
								)
								? Ref.set(finished, true)
								: Effect.void,
						),
					)
			).pipe(
				Effect.as(
					batch.events.map((envelope) =>
						ownership === undefined ||
						(envelope.scope === "turn" && envelope.turnId !== ownership.turnId)
							? envelope
							: { ...envelope, ownership },
					),
				),
			);

		const normalize = (
			event: ProviderDriverEvent,
		): Effect.Effect<ReadonlyArray<TurnScopedProviderEventEnvelope>> => {
			if (goalOwned && event._tag === "NativeTurnStarted")
				return Effect.succeed([]);
			if (event._tag === "QuestionCallbackReleased") {
				return releaseBatch({ events: [sessionEnvelope(event)] });
			}
			if (event._tag === "ProviderTurnStarted") {
				return Ref.modify(
					activeTurn,
					(active): readonly [NormalizedBatch, ActiveTurn | null] => {
						if (active !== null) return [{ events: [] }, active] as const;
						const turnId = `turn_${crypto.randomUUID()}` as AgentTurnId;
						return [
							{ events: [turnEnvelope(turnId, event)] },
							{
								turnId,
								released: Deferred.makeUnsafe<void>(),
								sent: true,
								origin: "provider",
								children: new Map<string, NativeChild>(),
								completedChildren: new Set<string>(),
							},
						] as const;
					},
				).pipe(Effect.flatMap(releaseBatch));
			}
			const quiesce = Effect.gen(function* () {
				const active = yield* Ref.get(activeTurn);
				if (
					active !== null &&
					(active.children.size > 0 || goalOwned) &&
					((event._tag === "Status" &&
						(event.status === "closed" || event.status === "error")) ||
						event._tag === "Interrupted" ||
						event._tag === "Error" ||
						(event._tag === "Completed" &&
							(event.reason === "error" || event.reason === "interrupted")))
				) {
					yield* handle.close();
				}
			});
			return quiesce.pipe(
				Effect.andThen(
					Ref.modify(
						activeTurn,
						(active): readonly [NormalizedBatch, ActiveTurn | null] => {
							if (sessionEventTags.has(event._tag)) {
								return [{ events: [sessionEnvelope(event)] }, active] as const;
							}

							const origin = originTurnOf(event);
							if (origin !== undefined && origin !== active?.turnId) {
								rememberItem(event, origin);
								return [
									{ events: [turnEnvelope(origin, event)] },
									active,
								] as const;
							}

							if (
								active?.pendingCompletion !== undefined &&
								event._tag !== "Completed" &&
								event._tag !== "Interrupted" &&
								event._tag !== "Error" &&
								event._tag !== "Status"
							) {
								// A known child may re-issue its launch to report progress.
								const known =
									event._tag === "SubagentSummary" ||
									(event._tag === "ToolUse" && event.subagent !== undefined) ||
									(event._tag === "ToolResult" &&
										active.children.get(event.itemId)?.childKind ===
											"background")
										? active.children.has(event.itemId)
										: event._tag === "SubagentProgress"
											? [...active.children.values()].some(
													(child) =>
														child.nativeChildId === event.childSessionId,
												)
											: "parentItemId" in event &&
												event.parentItemId !== undefined &&
												active.children.has(event.parentItemId);
								if (!known) return [{ events: [] }, active];
							}
							if (
								active !== null &&
								event._tag === "ToolUse" &&
								(event.subagent !== undefined ||
									event.backgroundTask !== undefined)
							) {
								if (active.completedChildren.has(event.itemId))
									return [{ events: [] }, active];
								rememberItem(event, active.turnId);
								const children = new Map(active.children);
								children.set(event.itemId, {
									...event,
									nativeChildId:
										event.subagent?.childSessionId ??
										event.backgroundTask?.taskId ??
										event.itemId,
									childKind:
										event.subagent === undefined ? "background" : "subagent",
								});
								return [
									{ events: [turnEnvelope(active.turnId, event)] },
									{ ...active, children },
								];
							}
							if (
								active !== null &&
								(event._tag === "SubagentSummary" ||
									(event._tag === "ToolResult" &&
										active.children.get(event.itemId)?.childKind ===
											"background"))
							) {
								const children = new Map(active.children);
								children.delete(event.itemId);
								const completedChildren = new Set(active.completedChildren);
								completedChildren.add(event.itemId);
								const events = [turnEnvelope(active.turnId, event)];
								if (
									children.size === 0 &&
									active.pendingCompletion !== undefined
								) {
									events.push(
										turnEnvelope(active.turnId, active.pendingCompletion),
									);
									return [{ events, released: active.released }, null];
								}
								return [{ events }, { ...active, children, completedChildren }];
							}
							if (
								active !== null &&
								active.children.size > 0 &&
								((event._tag === "Completed" &&
									event.reason !== "error" &&
									event.reason !== "interrupted") ||
									(event._tag === "Status" && event.status === "idle"))
							) {
								const completed =
									event._tag === "Completed"
										? event
										: { _tag: "Completed" as const, reason: "ended" as const };
								if (active.pendingCompletion !== undefined)
									return [{ events: [] }, active];
								const events = [...active.children.values()].map((child) =>
									turnEnvelope(active.turnId, {
										_tag: "SubagentProgress",
										childId: child.itemId,
										parentId: child.itemId,
										childSessionId: child.nativeChildId,
										status: "running",
										rootCompleted: true,
										durationMs: 0,
										turns: 0,
										toolCalls: 0,
										tokens: 0,
										contextPercentage: 0,
										toolsUsed: [],
										errorCount: 0,
									}),
								);
								return [
									{ events },
									{ ...active, pendingCompletion: completed },
								];
							}
							if (event._tag === "Status") {
								if (active !== null && event.status === "idle") {
									return [
										{
											events: [
												...stoppedChildren(active),
												turnEnvelope(active.turnId, {
													_tag: "Completed",
													reason: "ended",
												}),
												sessionEnvelope(event),
											],
											released: active.released,
										},
										null,
									] as const;
								}
								if (
									active !== null &&
									(event.status === "closed" || event.status === "error")
								) {
									return [
										{
											events: [
												...stoppedChildren(active),
												turnEnvelope(active.turnId, {
													_tag: "Error",
													message: `Provider entered ${event.status} state`,
												}),
												turnEnvelope(active.turnId, {
													_tag: "Completed",
													reason: "error",
												}),
												sessionEnvelope(event),
											],
											released: active.released,
										},
										null,
									] as const;
								}
								return [{ events: [sessionEnvelope(event)] }, active] as const;
							}

							if (active === null) {
								return event._tag === "UserQuestion" ||
									event._tag === "UserQuestionResolved"
									? [{ events: [sessionEnvelope(event)] }, null]
									: [{ events: [] }, null];
							}

							if (event._tag === "Completed") {
								return [
									{
										events: [
											...stoppedChildren(active),
											turnEnvelope(active.turnId, event),
										],
										released: active.released,
									},
									null,
								] as const;
							}
							if (event._tag === "Interrupted") {
								return [
									{
										events: [
											...stoppedChildren(active),
											turnEnvelope(active.turnId, event),
											turnEnvelope(active.turnId, {
												_tag: "Completed",
												reason: "interrupted",
											}),
										],
										released: active.released,
									},
									null,
								] as const;
							}
							if (event._tag === "Error") {
								return [
									{
										events: [
											...stoppedChildren(active),
											turnEnvelope(active.turnId, event),
											turnEnvelope(active.turnId, {
												_tag: "Completed",
												reason: "error",
											}),
										],
										released: active.released,
									},
									null,
								] as const;
							}
							rememberItem(event, active.turnId);
							return [
								{ events: [turnEnvelope(active.turnId, event)] },
								active,
							] as const;
						},
					),
				),
				Effect.flatMap(releaseBatch),
			);
		};

		const finalizeUnexpectedExit = Effect.gen(function* () {
			const active = yield* Ref.get(activeTurn);
			if (active !== null && (active.children.size > 0 || goalOwned))
				yield* handle.close();
		}).pipe(
			Effect.andThen(
				Ref.modify(
					activeTurn,
					(active): readonly [NormalizedBatch, ActiveTurn | null] => {
						if (active === null) return [{ events: [] }, null] as const;
						return [
							{
								events: [
									...stoppedChildren(active),
									turnEnvelope(active.turnId, {
										_tag: "Error",
										message:
											"Provider event stream ended before the turn settled",
									}),
									turnEnvelope(active.turnId, {
										_tag: "Completed",
										reason: "error",
									}),
								],
								released: active.released,
							},
							null,
						] as const;
					},
				).pipe(
					Effect.tap(() => Ref.set(ended, true)),
					Effect.flatMap(releaseBatch),
				),
			),
		);

		const sourceEvents = handle.events.pipe(
			Stream.merge(Stream.fromQueue(injected), { haltStrategy: "left" }),
			Stream.catchCause((cause) =>
				Stream.fromIterable<AgentEvent>([
					{
						_tag: "Error",
						message: `Provider event stream failed: ${String(cause)}`,
					},
				]),
			),
		);
		const normalizedEvents = Stream.mapEffect(sourceEvents, normalize).pipe(
			Stream.flatMap((events) => Stream.fromIterable(events)),
			Stream.concat(
				Stream.fromEffect(finalizeUnexpectedExit).pipe(
					Stream.flatMap((events) => Stream.fromIterable(events)),
				),
			),
		);

		const admitSend = (turnId: AgentTurnId, operation: Effect.Effect<void>) =>
			Effect.gen(function* () {
				if (ownership !== undefined) {
					if (turnId !== ownership.turnId)
						return yield* Effect.die(
							new Error("A provider attempt requires its own handle"),
						);
					if (yield* Ref.get(finished)) return;
				}
				if (yield* Ref.get(ended))
					return yield* new ProviderHandleUnavailable({
						reason: "Provider event stream ended before send",
					});
				const released = yield* Deferred.make<void>();
				const send = yield* Ref.modify(activeTurn, (active) => {
					if (active !== null) {
						if (active.turnId === turnId) {
							return active.sent
								? ([Effect.void, active] as const)
								: ([operation, { ...active, sent: true }] as const);
						}
						if (active.origin === "provider") {
							return [
								Deferred.succeed(active.released, undefined).pipe(
									Effect.andThen(operation),
								),
								{
									...active,
									turnId,
									released,
									sent: true,
									origin: "application",
								},
							] as const;
						}
						return [
							Effect.die(
								new Error(
									`Cannot start turn ${turnId}; turn ${active.turnId} is still active`,
								),
							),
							active,
						] as const;
					}
					return [
						operation,
						{
							turnId,
							released,
							sent: true,
							origin: "application",
							children: new Map<string, NativeChild>(),
							completedChildren: new Set<string>(),
						},
					] as const;
				});
				yield* send.pipe(
					Effect.catchCause((cause) =>
						Ref.modify(activeTurn, (active) =>
							active?.turnId === turnId
								? [active.released, null]
								: [undefined, active],
						).pipe(
							Effect.flatMap((currentReleased) =>
								currentReleased === undefined
									? Effect.void
									: Deferred.succeed(currentReleased, undefined),
							),
							Effect.andThen(Effect.failCause(cause)),
						),
					),
				);
			});
		return {
			...handle,
			events: normalizedEvents,
			send: (turnId, ...args) =>
				admitSend(
					turnId,
					Effect.suspend(() => handle.send(...args)),
				),
			sendGoal: (turnId, goal, fallbackObjective) =>
				admitSend(
					turnId,
					Effect.suspend(() => {
						goalOwned = true;
						const capable = handle as ProviderSessionHandle &
							Partial<GoalCapableSessionHandle>;
						const setGoal = capable.setGoal;
						return setGoal === undefined
							? Effect.die(new Error("Provider does not support goals"))
							: Effect.gen(function* () {
									let input = goal;
									if (goal.objective === undefined) {
										const current = yield* capable.getGoal?.() ??
											Effect.succeed(null);
										if (current === null) {
											if (
												fallbackObjective === undefined ||
												fallbackObjective === "Resume goal"
											)
												return yield* Effect.die(
													new Error("The provider has no goal to resume."),
												);
											input = { ...goal, objective: fallbackObjective };
										}
									}
									yield* setGoal(input, { execute: true });
								});
					}),
				),
			stopBackgroundTask: (turnId, taskId) =>
				Effect.gen(function* () {
					const active = yield* Ref.get(activeTurn);
					if (active?.turnId !== turnId)
						return yield* Effect.fail(
							new Error("The background task's turn is no longer active."),
						);
					const child = [...active.children.values()].find(
						(child) => child.nativeChildId === taskId,
					);
					if (child === undefined) return;
					if (
						child.childKind === "subagent" &&
						child.subagent?.presentation !== "detached"
					)
						return yield* Effect.fail(
							new Error("This task is foreground work."),
						);
					if (handle.stopBackgroundTask === undefined)
						return yield* Effect.fail(
							new Error(
								"This provider does not support stopping individual background tasks.",
							),
						);
					yield* handle.stopBackgroundTask(taskId);
				}),
			interrupt: (turnId) =>
				Effect.gen(function* () {
					const active = yield* Ref.get(activeTurn);
					if (active?.turnId !== turnId) {
						return yield* Effect.die(
							new Error(
								`Cannot interrupt turn ${turnId}; current turn is ${active?.turnId ?? "none"}`,
							),
						);
					}
					if (active.pendingCompletion !== undefined || goalOwned) {
						yield* Queue.offer(injected, { _tag: "Interrupted" });
					} else {
						yield* handle.interrupt();
					}
					yield* Deferred.await(active.released);
				}),
		};
	});
