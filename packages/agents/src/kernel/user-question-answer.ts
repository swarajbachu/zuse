import type { UserQuestion, UserQuestionAnswer } from "@zuse/contracts";

export const MAX_PENDING_USER_QUESTIONS = 32;

export type QuestionCallbackRegistration = "accepted" | "duplicate" | "full";

export type UserQuestionAnswerValidationIssue = {
	readonly code:
		| "question_count"
		| "answer_count"
		| "question_index"
		| "duplicate_question"
		| "selection_index"
		| "duplicate_selection"
		| "selection_count"
		| "other_text"
		| "empty_answer";
	readonly questionIndex?: number;
	readonly selectionIndex?: number;
};

/**
 * Validate renderer answer coordinates against the exact provider question.
 *
 * The wire schema can reject non-integer coordinates, but only the live
 * callback owns the question and option bounds. Keeping this pure validator
 * beside the shared callback registry gives every provider one trust boundary.
 */
export const validateUserQuestionAnswers = (
	questions: ReadonlyArray<UserQuestion>,
	answers: ReadonlyArray<UserQuestionAnswer>,
): UserQuestionAnswerValidationIssue | undefined => {
	if (questions.length === 0) return { code: "question_count" };
	if (answers.length !== questions.length) return { code: "answer_count" };

	const answeredQuestions = new Set<number>();
	for (const answer of answers) {
		if (
			!Number.isSafeInteger(answer.questionIndex) ||
			answer.questionIndex < 0 ||
			answer.questionIndex >= questions.length
		) {
			return { code: "question_index", questionIndex: answer.questionIndex };
		}
		if (answeredQuestions.has(answer.questionIndex)) {
			return {
				code: "duplicate_question",
				questionIndex: answer.questionIndex,
			};
		}
		answeredQuestions.add(answer.questionIndex);

		const question = questions[answer.questionIndex];
		if (question === undefined) {
			return { code: "question_index", questionIndex: answer.questionIndex };
		}
		const selected = new Set<number>();
		for (const selectionIndex of answer.selected) {
			if (
				!Number.isSafeInteger(selectionIndex) ||
				selectionIndex < 0 ||
				selectionIndex >= question.options.length
			) {
				return {
					code: "selection_index",
					questionIndex: answer.questionIndex,
					selectionIndex,
				};
			}
			if (selected.has(selectionIndex)) {
				return {
					code: "duplicate_selection",
					questionIndex: answer.questionIndex,
					selectionIndex,
				};
			}
			selected.add(selectionIndex);
		}
		const hasOther = answer.other !== undefined;
		if (hasOther && answer.other.trim().length === 0) {
			return { code: "other_text", questionIndex: answer.questionIndex };
		}
		if (
			question.multiSelect !== true &&
			answer.selected.length + (hasOther ? 1 : 0) > 1
		) {
			return {
				code: "selection_count",
				questionIndex: answer.questionIndex,
			};
		}
		if (answer.selected.length === 0 && !hasOther) {
			return { code: "empty_answer", questionIndex: answer.questionIndex };
		}
	}

	return undefined;
};

/** Bounded callback ownership shared by native, gateway, and ACP drivers. */
export const makeBoundedQuestionCallbackRegistry = <Value>(
	maxPending = MAX_PENDING_USER_QUESTIONS,
) => {
	const configuredMax =
		Number.isSafeInteger(maxPending) && maxPending > 0
			? maxPending
			: MAX_PENDING_USER_QUESTIONS;
	const entries = new Map<string, Value>();
	return {
		register: (itemId: string, value: Value): QuestionCallbackRegistration => {
			if (entries.has(itemId)) return "duplicate";
			if (entries.size >= configuredMax) return "full";
			entries.set(itemId, value);
			return "accepted";
		},
		get: (itemId: string): Value | undefined => entries.get(itemId),
		take: (itemId: string): Value => {
			const value = entries.get(itemId);
			if (value === undefined) {
				throw new Error(`No pending user question: ${itemId}`);
			}
			entries.delete(itemId);
			return value;
		},
		delete: (itemId: string): boolean => entries.delete(itemId),
		drain: (): ReadonlyArray<readonly [string, Value]> => {
			const drained = [...entries.entries()];
			entries.clear();
			return drained;
		},
	};
};

/** Canonical semantic identity for retrying one structured question answer. */
export const userQuestionAnswerKey = (
	answers: ReadonlyArray<UserQuestionAnswer>,
): string =>
	JSON.stringify(
		answers
			.map((answer) => [
				answer.questionIndex,
				[...answer.selected].sort((left, right) => left - right),
				answer.other?.trim() ?? null,
			])
			.sort((left, right) => Number(left[0]) - Number(right[0])),
	);
