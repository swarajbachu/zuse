import { userQuestionAnswerKey } from "@zuse/agents/kernel/user-question-answer";
import {
	type AgentItemId,
	MessageId,
	type SessionId,
	UserQuestionAnswer,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { Schema } from "effect";

export type QuestionAnswerDeliveryPayload = {
	readonly answers: ReadonlyArray<typeof UserQuestionAnswer.Type>;
	readonly answersJson: string;
	readonly answerKey: string;
};

const decodeQuestionAnswers = Schema.decodeUnknownSync(
	Schema.Array(UserQuestionAnswer),
);

/** Preserve the first submitted payload while comparing retries semantically. */
export const makeQuestionAnswerDeliveryPayload = (
	answers: ReadonlyArray<typeof UserQuestionAnswer.Type>,
): QuestionAnswerDeliveryPayload => ({
	answers,
	answersJson: JSON.stringify(answers),
	answerKey: userQuestionAnswerKey(answers),
});

export const parseQuestionAnswerDeliveryPayload = (
	answersJson: string,
): QuestionAnswerDeliveryPayload | null => {
	try {
		const answers = decodeQuestionAnswers(JSON.parse(answersJson));
		return {
			answers,
			answersJson,
			answerKey: userQuestionAnswerKey(answers),
		};
	} catch {
		return null;
	}
};

/** Stable persistence receipt identity for one structurally-qualified question. */
export const questionAnswerMessageId = (
	sessionId: SessionId,
	itemId: AgentItemId,
): MessageId =>
	MessageId.make(`question-answer:${structuralTupleKey(sessionId, itemId)}`);

/** Stable domain-command receipt identity for cancelling one question. */
export const questionCancellationCommandId = (
	sessionId: SessionId,
	itemId: AgentItemId,
): string => `question-cancel:${structuralTupleKey(sessionId, itemId)}`;
