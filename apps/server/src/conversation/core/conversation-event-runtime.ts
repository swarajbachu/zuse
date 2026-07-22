/** Owns provider-event subscriptions and durable turn settlement. */
import type {
	AgentTurnId,
	MessageContent,
	PermissionMode,
	ProviderEventEnvelope,
	ProviderId,
	ResumeStrategy,
	SessionId,
	ThreadGoal,
} from "@zuse/contracts";
import {
	Deferred,
	Effect,
	Fiber,
	Ref,
	type Scope,
	Semaphore,
	Stream,
} from "effect";

import { eventToContent } from "./conversation-message-mapping.ts";

type RelayActivity =
	| "approval-needed"
	| "question-needed"
	| "completed"
	| "error"
	| "running";

export interface ConversationEventRuntimeOptions {
	readonly scope: Scope.Scope;
	readonly events: (
		sessionId: SessionId,
	) => Stream.Stream<ProviderEventEnvelope, unknown>;
	readonly providerId: (sessionId: SessionId) => Effect.Effect<ProviderId>;
	readonly settleTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly setResume: (
		sessionId: SessionId,
		cursor: string,
		strategy: ResumeStrategy,
		providerEventCursor?: string,
	) => Effect.Effect<void>;
	readonly releaseProviderEventCursor?: (
		sessionId: SessionId,
		cursor: string,
	) => Effect.Effect<void>;
	readonly setPermissionMode: (
		sessionId: SessionId,
		mode: PermissionMode,
	) => Effect.Effect<void>;
	readonly publishGoal: (
		sessionId: SessionId,
		goal: ThreadGoal | null,
	) => Effect.Effect<void>;
	readonly publishRelayActivity: (
		sessionId: SessionId,
		activity: RelayActivity,
	) => Effect.Effect<void>;
	readonly ignoreError: (providerId: ProviderId, message: string) => boolean;
	readonly isDuplicateToolUse: (
		sessionId: SessionId,
		content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
	) => Effect.Effect<boolean>;
	readonly persist: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		content: MessageContent,
		providerItemIdentity?: string,
	) => Effect.Effect<void>;
}

export interface ConversationEventRuntime {
	readonly start: (sessionId: SessionId) => Effect.Effect<void>;
	readonly interrupt: (sessionId: SessionId) => Effect.Effect<void>;
}

interface SessionEventFiber {
	readonly token: object;
	readonly fiber: Fiber.Fiber<unknown, unknown>;
}

interface SessionLifecycleLock {
	readonly semaphore: Semaphore.Semaphore;
	readonly users: number;
}

export const makeConversationEventRuntime = Effect.fn(
	"ConversationEventRuntime.make",
)(function* (
	options: ConversationEventRuntimeOptions,
): Effect.fn.Return<ConversationEventRuntime> {
	const fibers = yield* Ref.make<ReadonlyMap<SessionId, SessionEventFiber>>(
		new Map(),
	);
	const lifecycleLocks = yield* Ref.make<
		ReadonlyMap<SessionId, SessionLifecycleLock>
	>(new Map());
	const lifecycleLockGuard = yield* Semaphore.make(1);
	const withLifecycle = <A, E, R>(
		sessionId: SessionId,
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E, R> =>
		Effect.gen(function* () {
			const entry = yield* lifecycleLockGuard.withPermits(1)(
				Effect.gen(function* () {
					const existing = (yield* Ref.get(lifecycleLocks)).get(sessionId);
					const entry = existing ?? {
						semaphore: yield* Semaphore.make(1),
						users: 0,
					};
					yield* Ref.update(lifecycleLocks, (current) => {
						const next = new Map(current);
						next.set(sessionId, { ...entry, users: entry.users + 1 });
						return next;
					});
					return entry;
				}),
			);
			const release = lifecycleLockGuard.withPermits(1)(
				Ref.update(lifecycleLocks, (current) => {
					const active = current.get(sessionId);
					if (active === undefined) return current;
					const next = new Map(current);
					if (active.users === 1) next.delete(sessionId);
					else next.set(sessionId, { ...active, users: active.users - 1 });
					return next;
				}),
			);
			return yield* entry.semaphore
				.withPermits(1)(effect)
				.pipe(Effect.ensuring(release));
		});

	const start: ConversationEventRuntime["start"] = (sessionId) =>
		withLifecycle(
			sessionId,
			Effect.gen(function* () {
				const existing = (yield* Ref.get(fibers)).get(sessionId);
				if (existing !== undefined) yield* Fiber.interrupt(existing.fiber);
				const providerId = yield* options.providerId(sessionId);
				const token = {};
				let pendingProviderEventCursor: string | undefined;
				const ready = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkIn(
					Deferred.await(ready).pipe(
						Effect.andThen(
							Stream.runForEach(options.events(sessionId), (envelope) =>
								Effect.gen(function* () {
									const event = envelope.event;
									if (event._tag === "ProviderNotificationMetadata") {
										pendingProviderEventCursor = event.eventId;
										return;
									}
									if (event._tag === "Status") {
										if (event.status === "running") {
											yield* options.publishRelayActivity(sessionId, "running");
										}
										return;
									}
									if (event._tag === "Completed") {
										if (envelope.scope !== "turn") return;
										const outcome =
											event.reason === "interrupted"
												? "interrupted"
												: event.reason === "error"
													? "error"
													: "completed";
										yield* options.settleTurn(
											sessionId,
											envelope.turnId,
											outcome,
										);
										yield* options.publishRelayActivity(
											sessionId,
											event.reason === "error" ? "error" : "completed",
										);
										return;
									}
									if (event._tag === "SessionCursor") {
										yield* options.setResume(
											sessionId,
											event.cursor,
											event.strategy,
											event.providerEventCursor,
										);
										if (
											event.providerEventCursor !== undefined &&
											event.providerEventCursor === pendingProviderEventCursor
										)
											pendingProviderEventCursor = undefined;
										return;
									}
									if (event._tag === "PermissionModeChanged") {
										yield* options.setPermissionMode(sessionId, event.mode);
										return;
									}
									if (event._tag === "GoalUpdated") {
										yield* options.publishGoal(sessionId, event.goal);
										return;
									}
									if (event._tag === "GoalCleared") {
										yield* options.publishGoal(sessionId, null);
										return;
									}
									if (
										event._tag === "Error" &&
										options.ignoreError(providerId, event.message)
									) {
										return;
									}
									if (envelope.scope !== "turn") return;
									if (event._tag === "PermissionRequest") {
										yield* options.publishRelayActivity(
											sessionId,
											"approval-needed",
										);
									}
									if (event._tag === "UserQuestion") {
										yield* options.publishRelayActivity(
											sessionId,
											"question-needed",
										);
									}
									const content = eventToContent(event);
									if (content === null) return;
									if (
										content._tag === "tool_use" &&
										(yield* options.isDuplicateToolUse(sessionId, content))
									) {
										return;
									}
									yield* options.persist(
										sessionId,
										envelope.turnId,
										content,
										"itemId" in event && typeof event.itemId === "string"
											? `${event._tag}:${event.itemId}`
											: undefined,
									);
									if (event._tag === "Error") {
										yield* options.publishRelayActivity(sessionId, "error");
									}
								}),
							),
						),
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								if (pendingProviderEventCursor !== undefined) {
									yield* (
										options.releaseProviderEventCursor?.(
											sessionId,
											pendingProviderEventCursor,
										) ?? Effect.void
									).pipe(Effect.catch(() => Effect.void));
								}
								yield* Effect.logDebug(
									"[ConversationEvents] event stream ended",
								);
								yield* Effect.logDebug(cause);
							}),
						),
						Effect.ensuring(
							Ref.update(fibers, (current) => {
								if (current.get(sessionId)?.token !== token) return current;
								const next = new Map(current);
								next.delete(sessionId);
								return next;
							}),
						),
					),
					options.scope,
				);
				yield* Ref.update(fibers, (current) => {
					const next = new Map(current);
					next.set(sessionId, { token, fiber });
					return next;
				});
				yield* Deferred.succeed(ready, undefined);
			}),
		);

	const interrupt: ConversationEventRuntime["interrupt"] = (sessionId) =>
		withLifecycle(
			sessionId,
			Effect.gen(function* () {
				const entry = (yield* Ref.get(fibers)).get(sessionId);
				if (entry !== undefined) yield* Fiber.interrupt(entry.fiber);
			}),
		);

	return { start, interrupt };
});
