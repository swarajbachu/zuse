import {
	userQuestionAnswerKey,
	validateUserQuestionAnswers,
} from "@zuse/agents/kernel/user-question-answer";
import {
	type AgentItemId,
	type AgentSessionId,
	AgentSessionNotFoundError,
	type QuestionAttachment,
	type UserQuestion,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { Deferred, type Duration, Effect, Exit } from "effect";

type DeliveryState<DeliveryError> =
	| { readonly _tag: "pending" }
	| {
			readonly _tag: "delivering";
			readonly deliveryKey: string;
			readonly completion: Deferred.Deferred<
				void,
				AgentSessionNotFoundError | DeliveryError
			>;
	  }
	| { readonly _tag: "delivered"; readonly deliveryKey: string };

type AttachmentEntry<DeliveryError> = {
	readonly attachment: QuestionAttachment;
	readonly questions: ReadonlyArray<UserQuestion>;
	readonly questionKey: string;
	state: DeliveryState<DeliveryError>;
};

type QuestionAttachmentAuthorityOptions = {
	readonly maxEntries?: number;
	readonly deliveryTimeout?: Duration.Input;
};

const DEFAULT_MAX_QUESTION_ATTACHMENTS = 2_048;
const DEFAULT_QUESTION_DELIVERY_TIMEOUT = "30 seconds";

export type QuestionAttachmentAdmission =
	| "attached"
	| "duplicate"
	| "conflict"
	| "full";

/**
 * Process-local authority for provider-owned question callbacks.
 *
 * The delivered answer key deliberately lives only in memory: it makes a
 * post-provider/pre-database retry idempotent in the same process. Across a
 * restart, delivery resumes only after the provider reissues the callback;
 * an existing durable receipt is then replayed automatically.
 */
export const makeQuestionAttachmentAuthority = <DeliveryError = never>(
	options: QuestionAttachmentAuthorityOptions = {},
) => {
	const configuredMax = options.maxEntries ?? DEFAULT_MAX_QUESTION_ATTACHMENTS;
	const maxEntries =
		Number.isSafeInteger(configuredMax) && configuredMax > 0
			? configuredMax
			: DEFAULT_MAX_QUESTION_ATTACHMENTS;
	const deliveryTimeout =
		options.deliveryTimeout ?? DEFAULT_QUESTION_DELIVERY_TIMEOUT;
	const entries = new Map<string, AttachmentEntry<DeliveryError>>();
	const keyOf = (sessionId: AgentSessionId, itemId: AgentItemId): string =>
		structuralTupleKey(sessionId, itemId);
	const answerDeliveryKey = (
		answers: ReadonlyArray<UserQuestionAnswer>,
	): string => structuralTupleKey("answer", userQuestionAnswerKey(answers));
	const cancellationDeliveryKey = structuralTupleKey("cancel");
	const questionKey = (questions: ReadonlyArray<UserQuestion>): string =>
		JSON.stringify(
			questions.map((question) => [
				question.question,
				question.options,
				question.multiSelect === true,
			]),
		);
	const missingAttachment = (sessionId: AgentSessionId) =>
		new AgentSessionNotFoundError({ sessionId });
	const isValidAnswer = (
		entry: AttachmentEntry<DeliveryError>,
		answers: ReadonlyArray<UserQuestionAnswer>,
	): boolean =>
		validateUserQuestionAnswers(entry.questions, answers) === undefined;
	const deliverWithKey = <R>(
		sessionId: AgentSessionId,
		itemId: AgentItemId,
		deliveryKey: string,
		invokeProvider: Effect.Effect<void, DeliveryError, R>,
		validateEntry: (entry: AttachmentEntry<DeliveryError>) => boolean,
	): Effect.Effect<void, AgentSessionNotFoundError | DeliveryError, R> =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const key = keyOf(sessionId, itemId);
				const entry = entries.get(key);
				if (entry === undefined || !validateEntry(entry)) {
					return yield* missingAttachment(sessionId);
				}
				if (entry.state._tag === "delivered") {
					if (entry.state.deliveryKey !== deliveryKey) {
						return yield* missingAttachment(sessionId);
					}
					return;
				}
				if (entry.state._tag === "delivering") {
					if (entry.state.deliveryKey !== deliveryKey) {
						return yield* missingAttachment(sessionId);
					}
					return yield* restore(Deferred.await(entry.state.completion));
				}

				const completion = yield* Deferred.make<
					void,
					AgentSessionNotFoundError | DeliveryError
				>();
				entry.state = { _tag: "delivering", deliveryKey, completion };
				const boundedProviderDelivery = invokeProvider.pipe(
					Effect.timeoutOrElse({
						duration: deliveryTimeout,
						orElse: () => Effect.fail(missingAttachment(sessionId)),
					}),
				);
				const completeDelivery = Effect.exit(boundedProviderDelivery).pipe(
					Effect.flatMap((exit) =>
						Effect.sync(() => {
							// Detach/reattach creates a new authority entry. Never let an old
							// callback completion mutate the replacement callback's state.
							if (entries.get(key) !== entry) return;
							entry.state = Exit.isSuccess(exit)
								? { _tag: "delivered", deliveryKey }
								: { _tag: "pending" };
						}).pipe(Effect.andThen(Deferred.done(completion, exit))),
					),
				);
				// Provider invocation is owned by this authority rather than the RPC
				// caller. An interrupted/lost caller can retry and join the same result
				// without opening a second callback invocation window.
				yield* Effect.forkDetach(completeDelivery);
				return yield* restore(Deferred.await(completion));
			}),
		);

	return {
		attach: (
			attachment: QuestionAttachment,
			questions: ReadonlyArray<UserQuestion>,
		): QuestionAttachmentAdmission => {
			const key = keyOf(attachment.sessionId, attachment.itemId);
			const nextQuestionKey = questionKey(questions);
			const existing = entries.get(key);
			if (existing !== undefined) {
				return existing.questionKey === nextQuestionKey
					? "duplicate"
					: "conflict";
			}
			if (entries.size >= maxEntries) return "full";
			entries.set(key, {
				attachment,
				questions,
				questionKey: nextQuestionKey,
				state: { _tag: "pending" },
			});
			return "attached";
		},
		detach: (sessionId: AgentSessionId, itemId: AgentItemId): boolean =>
			entries.delete(keyOf(sessionId, itemId)),
		detachSession: (
			sessionId: AgentSessionId,
		): ReadonlyArray<QuestionAttachment> => {
			const detached: QuestionAttachment[] = [];
			for (const [key, entry] of entries) {
				if (entry.attachment.sessionId !== sessionId) continue;
				entries.delete(key);
				detached.push(entry.attachment);
			}
			return detached;
		},
		has: (sessionId: AgentSessionId, itemId: AgentItemId): boolean =>
			entries.has(keyOf(sessionId, itemId)),
		snapshot: (): ReadonlyArray<QuestionAttachment> =>
			[...entries.values()].map(({ attachment }) => attachment),
		validateAnswer: (
			sessionId: AgentSessionId,
			itemId: AgentItemId,
			answers: ReadonlyArray<UserQuestionAnswer>,
		): Effect.Effect<void, AgentSessionNotFoundError> =>
			Effect.suspend(() => {
				const entry = entries.get(keyOf(sessionId, itemId));
				return entry !== undefined && isValidAnswer(entry, answers)
					? Effect.void
					: Effect.fail(missingAttachment(sessionId));
			}),
		deliverAnswer: <R>(
			sessionId: AgentSessionId,
			itemId: AgentItemId,
			answers: ReadonlyArray<UserQuestionAnswer>,
			invokeProvider: Effect.Effect<void, DeliveryError, R>,
		): Effect.Effect<void, AgentSessionNotFoundError | DeliveryError, R> =>
			deliverWithKey(
				sessionId,
				itemId,
				answerDeliveryKey(answers),
				invokeProvider,
				(entry) => isValidAnswer(entry, answers),
			),
		deliverCancellation: <R>(
			sessionId: AgentSessionId,
			itemId: AgentItemId,
			invokeProvider: Effect.Effect<void, DeliveryError, R>,
		): Effect.Effect<void, AgentSessionNotFoundError | DeliveryError, R> =>
			deliverWithKey(
				sessionId,
				itemId,
				cancellationDeliveryKey,
				invokeProvider,
				() => true,
			),
	};
};
