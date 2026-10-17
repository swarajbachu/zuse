import {
	GoalUnsupportedError,
	type ProviderId,
	type Session,
	type SessionId,
	SessionNotFoundError,
	SessionStartError,
	ThreadGoal,
	type ThreadGoalSetInput,
} from "@zuse/contracts";
import type { SqlAdmission } from "@zuse/domain/engine/admission";
import { Effect, Stream } from "effect";
import type { GoalResidency } from "../../provider/provider-goal.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import type { ConversationGoalState } from "./conversation-goal-state.ts";

const GOAL_CAPABLE_PROVIDERS: ReadonlySet<ProviderId> = new Set([
	"codex",
	"grok",
]);
export const isGoalCapableProvider = (providerId: ProviderId): boolean =>
	GOAL_CAPABLE_PROVIDERS.has(providerId);
export interface ConversationGoalOperationsOptions {
	readonly provider: Pick<
		ProviderServiceShape,
		"getGoal" | "setGoal" | "clearGoal"
	>;
	readonly state: ConversationGoalState;
	readonly isCurrent: (
		sessionId: SessionId,
		residency: GoalResidency,
	) => Effect.Effect<boolean>;
	readonly publishCurrent: (
		sessionId: SessionId,
		residency: GoalResidency,
		goal: ThreadGoal | null,
	) => Effect.Effect<boolean>;
	readonly lookupSession: (
		sessionId: SessionId,
	) => Effect.Effect<Session, SessionNotFoundError>;
	readonly admission: SqlAdmission;
	readonly hasActiveTurn: (sessionId: SessionId) => Effect.Effect<boolean>;
	readonly lastGoalObjective: (
		sessionId: SessionId,
	) => Effect.Effect<string | null>;
	readonly submitGoal: (
		session: Session,
		goal: ThreadGoalSetInput,
		displayObjective: string,
	) => Effect.Effect<void, SessionStartError>;
}
export type ConversationGoalOperations = Pick<
	ConversationOperations,
	"getGoal" | "setGoal" | "clearGoal" | "streamGoal"
>;
export const makeConversationGoalOperations = (
	options: ConversationGoalOperationsOptions,
): ConversationGoalOperations => {
	const ensureSession = (sessionId: SessionId) =>
		Effect.gen(function* () {
			const session = yield* options.lookupSession(sessionId);
			if (session.archivedAt !== null)
				return yield* new SessionNotFoundError({ sessionId });
			if (!isGoalCapableProvider(session.providerId))
				return yield* new GoalUnsupportedError({
					providerId: session.providerId,
				});
			return session;
		});
	const admitted = <A, E, R>(
		sessionId: SessionId,
		work: Effect.Effect<A, E, R>,
	) =>
		options.admission.withOperation(work).pipe(
			Effect.catchTag("AdmissionClosed", () =>
				Effect.fail(new SessionNotFoundError({ sessionId })),
			),
			Effect.catchTag("SqlError", () =>
				Effect.fail(new SessionNotFoundError({ sessionId })),
			),
		);
	const getGoal = (sessionId: SessionId) =>
		admitted(
			sessionId,
			Effect.gen(function* () {
				yield* ensureSession(sessionId);
				return yield* options.provider
					.getGoal(
						sessionId,
						(goal, residency) =>
							options.publishCurrent(sessionId, residency, goal),
						(residency) => options.isCurrent(sessionId, residency),
					)
					.pipe(
						Effect.map((goal) => {
							const current = options.state.current(sessionId);
							return current === undefined ? goal : current;
						}),
						Effect.catchTag("AgentSessionNotFoundError", () =>
							Effect.fail(new SessionNotFoundError({ sessionId })),
						),
					);
			}),
		);
	return {
		getGoal,
		setGoal: (sessionId, input) =>
			admitted(
				sessionId,
				Effect.gen(function* () {
					const session = yield* ensureSession(sessionId);
					const current = options.state.current(sessionId);
					const active = yield* options.hasActiveTurn(sessionId);

					if (
						!active &&
						(input.status === "active" ||
							(input.objective !== undefined && input.status === undefined))
					) {
						const objective =
							input.objective ??
							current?.objective ??
							(yield* options.lastGoalObjective(sessionId)) ??
							"Resume goal";
						if (
							input.objective !== undefined &&
							input.objective.trim().length === 0
						)
							return yield* new SessionNotFoundError({ sessionId });
						yield* options.submitGoal(
							session,
							{
								...input,
								status: "active",
							},
							objective,
						);

						const now = Date.now();
						return new ThreadGoal({
							threadId: current?.threadId ?? sessionId,
							objective,
							status: "active",
							tokenBudget:
								input.tokenBudget === undefined
									? (current?.tokenBudget ?? null)
									: input.tokenBudget,
							tokensUsed: current?.tokensUsed ?? 0,
							timeUsedSeconds: current?.timeUsedSeconds ?? 0,
							createdAt: current?.createdAt ?? now,
							updatedAt: now,
						});
					}
					if (
						active &&
						current?.status !== "active" &&
						(input.objective !== undefined || input.status === "active")
					)
						return yield* new SessionStartError({
							providerId: session.providerId,
							reason:
								"Wait for the current turn to finish before starting a goal.",
						});
					return yield* options.provider
						.setGoal(
							sessionId,
							input,
							(goal, residency) =>
								options.publishCurrent(sessionId, residency, goal),
							(residency) => options.isCurrent(sessionId, residency),
						)
						.pipe(
							Effect.catchTag("AgentSessionNotFoundError", () =>
								Effect.fail(new SessionNotFoundError({ sessionId })),
							),
						);
				}),
			),
		clearGoal: (sessionId) =>
			admitted(
				sessionId,
				Effect.gen(function* () {
					yield* ensureSession(sessionId);
					yield* options.provider
						.clearGoal(
							sessionId,
							(_value, residency) =>
								options.publishCurrent(sessionId, residency, null),
							(residency) => options.isCurrent(sessionId, residency),
						)
						.pipe(
							Effect.catchTag("AgentSessionNotFoundError", () =>
								Effect.fail(new SessionNotFoundError({ sessionId })),
							),
						);
				}),
			),
		streamGoal: (sessionId) =>
			Stream.unwrap(
				ensureSession(sessionId).pipe(
					Effect.as(
						options.state.stream(
							sessionId,
							getGoal(sessionId).pipe(Effect.catch(() => Effect.succeed(null))),
						),
					),
				),
			),
	};
};
