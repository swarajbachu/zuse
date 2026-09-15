import {
	type AgentEvent,
	AgentItemId,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { Schema } from "effect";
import type { QuestionCallbackReleased } from "../../kernel/driver.ts";
import {
	MAX_PENDING_USER_QUESTIONS,
	makeBoundedQuestionCallbackRegistry,
	userQuestionAnswerKey,
} from "../../kernel/user-question-answer.ts";

const QuestionOption = Schema.Struct({
	label: Schema.String,
	description: Schema.String,
	preview: Schema.optional(Schema.String),
});

const NativeQuestion = Schema.Struct({
	question: Schema.String,
	options: Schema.Array(QuestionOption),
	multiSelect: Schema.optional(Schema.Boolean),
});

const AcpAskUserQuestionRequest = Schema.Struct({
	sessionId: Schema.String,
	toolCallId: Schema.String,
	questions: Schema.Array(NativeQuestion),
	mode: Schema.Literals(["default", "plan"]),
});

export type AcpAskUserQuestionRequest = typeof AcpAskUserQuestionRequest.Type;

export const decodeAcpAskUserQuestionRequest = Schema.decodeUnknownSync(
	AcpAskUserQuestionRequest,
);

export const isAcpUserQuestionMethod = (method: string): boolean => {
	const methodName = method.toLowerCase().split("/").at(-1);
	return methodName === "ask_user_question" || methodName === "user_question";
};

export const acpUserQuestionEvent = (
	request: AcpAskUserQuestionRequest,
): Extract<AgentEvent, { readonly _tag: "UserQuestion" }> => ({
	_tag: "UserQuestion",
	itemId: AgentItemId.make(request.toolCallId),
	questions: request.questions.map((question) => ({
		question: question.question,
		options: question.options.map(({ label }) => label),
		...(question.multiSelect === undefined
			? {}
			: { multiSelect: question.multiSelect }),
	})),
});

export type AcpUserQuestionReply = {
	readonly jsonrpc: "2.0";
	readonly id: string | number;
	readonly result:
		| { readonly outcome: "cancelled" }
		| {
				readonly outcome: "accepted";
				readonly answers: Readonly<Record<string, ReadonlyArray<string>>>;
				readonly annotations?: Readonly<
					Record<string, { readonly notes: string }>
				>;
		  };
};

export type AcpUserQuestionErrorReply = {
	readonly jsonrpc: "2.0";
	readonly id: string | number;
	readonly error: {
		readonly code: number;
		readonly message: string;
	};
};

export type AcpUserQuestionResponse =
	| AcpUserQuestionReply
	| AcpUserQuestionErrorReply;

export type AcpUserQuestionHandleResult = "unhandled" | "accepted" | "rejected";

/**
 * Translate canonical renderer answers back to the blocking ACP extension
 * response. Keeping this at the protocol boundary makes Grok and Gemini use
 * the same option-index and free-text semantics.
 */
export const replyToAcpUserQuestion = (options: {
	readonly send: (reply: AcpUserQuestionReply) => void;
	readonly rpcId: string | number;
	readonly request: AcpAskUserQuestionRequest;
	readonly answers: ReadonlyArray<UserQuestionAnswer>;
}): void => {
	const hasAnswer = options.answers.some(
		(answer) =>
			answer.selected.length > 0 ||
			(answer.other !== undefined && answer.other.trim().length > 0),
	);
	if (!hasAnswer) {
		options.send({
			jsonrpc: "2.0",
			id: options.rpcId,
			result: { outcome: "cancelled" },
		});
		return;
	}

	const answers: Record<string, ReadonlyArray<string>> = {};
	const annotations: Record<string, { readonly notes: string }> = {};
	for (const answer of options.answers) {
		const question = options.request.questions[answer.questionIndex];
		if (question === undefined) continue;
		const selected = answer.selected.flatMap((index) => {
			const option = question.options[index];
			return option === undefined ? [] : [option.label];
		});
		if (answer.other !== undefined && answer.other.trim().length > 0) {
			selected.push("Other");
			annotations[question.question] = { notes: answer.other.trim() };
		}
		answers[question.question] = selected;
	}
	options.send({
		jsonrpc: "2.0",
		id: options.rpcId,
		result: {
			outcome: "accepted",
			answers,
			...(Object.keys(annotations).length === 0 ? {} : { annotations }),
		},
	});
};

/**
 * Own the bounded lifecycle of blocking ACP user-question requests.
 *
 * A provider may issue several questions concurrently, but a duplicate tool
 * call id must never overwrite the callback authority of the first request.
 * Once the bound is reached, new requests receive a deterministic JSON-RPC
 * error instead of growing process memory without limit.
 */
export const makeAcpUserQuestionRegistry = (options: {
	readonly send: (response: AcpUserQuestionResponse) => void;
	readonly emit: (
		event: Extract<AgentEvent, { readonly _tag: "UserQuestion" }>,
	) => void;
	readonly release?: (
		itemId: AgentItemId,
		reason: QuestionCallbackReleased["reason"],
	) => void;
	readonly maxPending?: number;
}) => {
	const configuredMax = options.maxPending ?? MAX_PENDING_USER_QUESTIONS;
	const maxPending =
		Number.isSafeInteger(configuredMax) && configuredMax > 0
			? configuredMax
			: MAX_PENDING_USER_QUESTIONS;
	const pending = makeBoundedQuestionCallbackRegistry<{
		readonly rpcId: string | number;
		readonly request: AcpAskUserQuestionRequest;
		answerKey: string | null;
	}>(maxPending);

	const reject = (
		rpcId: string | number,
		code: number,
		message: string,
	): void => {
		options.send({
			jsonrpc: "2.0",
			id: rpcId,
			error: { code, message },
		});
	};

	return {
		handleRequest: (
			method: string,
			params: unknown,
			rpcId: string | number,
		): AcpUserQuestionHandleResult => {
			if (!isAcpUserQuestionMethod(method)) return "unhandled";
			let request: AcpAskUserQuestionRequest;
			try {
				request = decodeAcpAskUserQuestionRequest(params);
			} catch {
				reject(rpcId, -32602, "Invalid user question request");
				return "rejected";
			}
			const registration = pending.register(request.toolCallId, {
				rpcId,
				request,
				answerKey: null,
			});
			if (registration === "duplicate") {
				reject(
					rpcId,
					-32602,
					`Duplicate pending user question: ${request.toolCallId}`,
				);
				return "rejected";
			}
			if (registration === "full") {
				reject(
					rpcId,
					-32000,
					`Too many pending user questions (maximum ${maxPending})`,
				);
				return "rejected";
			}

			options.emit(acpUserQuestionEvent(request));
			return "accepted";
		},
		answer: (
			itemId: AgentItemId,
			answers: ReadonlyArray<UserQuestionAnswer>,
		): "sent" | "replayed" => {
			const current = pending.get(itemId);
			if (current === undefined) {
				throw new Error(`No pending ACP user question: ${itemId}`);
			}
			const nextAnswerKey = userQuestionAnswerKey(answers);
			if (current.answerKey !== null) {
				if (current.answerKey !== nextAnswerKey) {
					throw new Error(
						`Conflicting answer for ACP user question: ${itemId}`,
					);
				}
				return "replayed";
			}
			replyToAcpUserQuestion({
				send: options.send,
				rpcId: current.rpcId,
				request: current.request,
				answers,
			});
			current.answerKey = nextAnswerKey;
			return "sent";
		},
		acknowledge: (itemId: AgentItemId): boolean => {
			return pending.delete(itemId);
		},
		cancel: (itemId: AgentItemId): void => {
			const current = pending.take(itemId);
			if (current.answerKey !== null) return;
			replyToAcpUserQuestion({
				send: options.send,
				rpcId: current.rpcId,
				request: current.request,
				answers: [],
			});
		},
		cancelAll: (
			reason: QuestionCallbackReleased["reason"] = "cancelled",
		): ReadonlyArray<AgentItemId> => {
			const currentEntries = pending.drain();
			for (const [itemId] of currentEntries) {
				options.release?.(AgentItemId.make(itemId), reason);
			}
			for (const [, current] of currentEntries) {
				if (current.answerKey !== null) continue;
				replyToAcpUserQuestion({
					send: options.send,
					rpcId: current.rpcId,
					request: current.request,
					answers: [],
				});
			}
			return currentEntries.map(([itemId]) => AgentItemId.make(itemId));
		},
		discardAll: (
			reason: QuestionCallbackReleased["reason"] = "transport_lost",
		): ReadonlyArray<AgentItemId> => {
			const itemIds = pending
				.drain()
				.map(([itemId]) => AgentItemId.make(itemId));
			for (const itemId of itemIds) options.release?.(itemId, reason);
			return itemIds;
		},
	};
};
