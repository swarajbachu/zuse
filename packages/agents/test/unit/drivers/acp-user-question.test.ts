import { AgentItemId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	type AcpUserQuestionReply,
	acpUserQuestionEvent,
	decodeAcpAskUserQuestionRequest,
	isAcpUserQuestionMethod,
	makeAcpUserQuestionRegistry,
	replyToAcpUserQuestion,
} from "../../../src/drivers/acp/user-question.ts";

const request = () =>
	decodeAcpAskUserQuestionRequest({
		sessionId: "session-1",
		toolCallId: "question-1",
		mode: "default",
		questions: [
			{
				question: "Keep the changes?",
				options: [
					{ label: "Yes", description: "Keep them." },
					{ label: "No", description: "Discard them." },
				],
				multiSelect: false,
			},
		],
	});

describe("ACP user-question protocol", () => {
	it("decodes the blocking request and emits one canonical question event", () => {
		const decoded = request();

		expect(acpUserQuestionEvent(decoded)).toEqual({
			_tag: "UserQuestion",
			itemId: "question-1",
			questions: [
				{
					question: "Keep the changes?",
					options: ["Yes", "No"],
					multiSelect: false,
				},
			],
		});
		expect(() =>
			decodeAcpAskUserQuestionRequest({
				sessionId: "session-1",
				toolCallId: "question-1",
				questions: [],
			}),
		).toThrow();
	});

	it("recognizes only user-question extension methods", () => {
		expect(isAcpUserQuestionMethod("_x.ai/ask_user_question")).toBe(true);
		expect(isAcpUserQuestionMethod("_google/user_question")).toBe(true);
		expect(isAcpUserQuestionMethod("_x.ai/exit_plan_mode")).toBe(false);
	});

	it("dispatches multi-select and free-text answers on the original RPC id", () => {
		const replies: AcpUserQuestionReply[] = [];
		const decoded = request();
		replyToAcpUserQuestion({
			send: (reply) => replies.push(reply),
			rpcId: 42,
			request: {
				...decoded,
				questions: decoded.questions.map((question) => ({
					...question,
					multiSelect: true,
				})),
			},
			answers: [
				{
					questionIndex: 0,
					selected: [0, 1],
					other: "Keep the generated test too",
				},
			],
		});

		expect(replies).toEqual([
			{
				jsonrpc: "2.0",
				id: 42,
				result: {
					outcome: "accepted",
					answers: { "Keep the changes?": ["Yes", "No", "Other"] },
					annotations: {
						"Keep the changes?": { notes: "Keep the generated test too" },
					},
				},
			},
		]);
	});

	it("dispatches cancellation when no answer was supplied", () => {
		const replies: AcpUserQuestionReply[] = [];
		replyToAcpUserQuestion({
			send: (reply) => replies.push(reply),
			rpcId: "question-rpc",
			request: request(),
			answers: [],
		});

		expect(replies).toEqual([
			{
				jsonrpc: "2.0",
				id: "question-rpc",
				result: { outcome: "cancelled" },
			},
		]);
	});

	it("bounds pending requests and preserves the first duplicate tool-call authority", () => {
		const firstItemId = AgentItemId.make("first");
		const missingItemId = AgentItemId.make("missing");
		const replies: Array<Record<string, unknown>> = [];
		const events: Array<ReturnType<typeof acpUserQuestionEvent>> = [];
		const releases: Array<readonly [AgentItemId, string]> = [];
		const registry = makeAcpUserQuestionRegistry({
			maxPending: 2,
			send: (reply) => replies.push(reply),
			emit: (event) => events.push(event),
			release: (itemId, reason) => releases.push([itemId, reason]),
		});
		const params = (toolCallId: string) => ({
			...request(),
			toolCallId,
		});

		expect(
			registry.handleRequest("_x.ai/ask_user_question", params("first"), 1),
		).toBe("accepted");
		expect(
			registry.handleRequest("_x.ai/ask_user_question", params("first"), 2),
		).toBe("rejected");
		expect(
			registry.handleRequest("_google/user_question", params("second"), 3),
		).toBe("accepted");
		expect(
			registry.handleRequest("_google/user_question", params("overflow"), 4),
		).toBe("rejected");
		expect(registry.handleRequest("fs/read_text_file", {}, 5)).toBe(
			"unhandled",
		);

		expect(events.map((event) => event.itemId)).toEqual(["first", "second"]);
		expect(replies).toEqual([
			{
				jsonrpc: "2.0",
				id: 2,
				error: {
					code: -32602,
					message: "Duplicate pending user question: first",
				},
			},
			{
				jsonrpc: "2.0",
				id: 4,
				error: {
					code: -32000,
					message: "Too many pending user questions (maximum 2)",
				},
			},
		]);

		expect(
			registry.answer(firstItemId, [{ questionIndex: 0, selected: [0] }]),
		).toBe("sent");
		expect(
			registry.answer(firstItemId, [{ questionIndex: 0, selected: [0] }]),
		).toBe("replayed");
		expect(() =>
			registry.answer(firstItemId, [{ questionIndex: 0, selected: [1] }]),
		).toThrow("Conflicting answer for ACP user question: first");
		expect(
			registry.handleRequest("_google/user_question", params("overflow"), 6),
		).toBe("rejected");
		expect(registry.acknowledge(firstItemId)).toBe(true);
		expect(registry.acknowledge(firstItemId)).toBe(false);
		expect(() => registry.answer(firstItemId, [])).toThrow(
			"No pending ACP user question: first",
		);
		expect(
			registry.handleRequest("_google/user_question", params("overflow"), 7),
		).toBe("accepted");
		expect(() => registry.answer(missingItemId, [])).toThrow(
			"No pending ACP user question: missing",
		);
		registry.cancelAll();

		expect(events.map((event) => event.itemId)).toEqual([
			"first",
			"second",
			"overflow",
		]);
		expect(replies).toContainEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				outcome: "accepted",
				answers: { "Keep the changes?": ["Yes"] },
			},
		});
		expect(replies).toContainEqual({
			jsonrpc: "2.0",
			id: 3,
			result: { outcome: "cancelled" },
		});
		expect(replies).toContainEqual({
			jsonrpc: "2.0",
			id: 7,
			result: { outcome: "cancelled" },
		});
		expect(replies.filter((reply) => reply.id === 1)).toHaveLength(1);
		expect(releases).toEqual([
			[AgentItemId.make("second"), "cancelled"],
			[AgentItemId.make("overflow"), "cancelled"],
		]);
	});

	it("cancels a rejected admission and immediately frees its waiter slot", () => {
		const replies: Array<Record<string, unknown>> = [];
		const registry = makeAcpUserQuestionRegistry({
			maxPending: 1,
			send: (reply) => replies.push(reply),
			emit: () => {},
		});
		const params = (toolCallId: string) => ({
			...request(),
			toolCallId,
		});

		expect(
			registry.handleRequest("_x.ai/ask_user_question", params("first"), 1),
		).toBe("accepted");
		registry.cancel(AgentItemId.make("first"));
		expect(
			registry.handleRequest("_x.ai/ask_user_question", params("second"), 2),
		).toBe("accepted");
		expect(replies).toContainEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { outcome: "cancelled" },
		});
	});
});
