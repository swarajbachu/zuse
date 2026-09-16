import type { PresentedSessionInteraction } from "@zuse/client-runtime/session-presentation";
import { AgentItemId, SessionId } from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { describe, expect, it } from "vitest";
import { applyQuestionAttachmentChange } from "../../src/lib/environment-question-attachments-client-bus.ts";
import {
	filterActionableQuestionInteractions,
	findPresentedPermissions,
	type PresentedQuestionInteraction,
	selectPresentedQuestion,
} from "../../src/lib/question-actionability.ts";

const sessionId = SessionId.make("session-1");
const itemId = AgentItemId.make("question-1");
const question: PresentedQuestionInteraction = {
	interaction: {
		_tag: "Question",
		id: itemId,
		questions: [{ question: "Keep the change?", options: ["Yes", "No"] }],
		requestedAt: new Date("2026-08-24T00:00:00.000Z"),
	},
	submission: "pending",
	error: null,
};

describe("question actionability", () => {
	it("keeps a recovered durable question quarantined until its callback attaches", () => {
		expect(selectPresentedQuestion(sessionId, [question], {})).toEqual({
			question,
			actionable: false,
		});
		expect(
			selectPresentedQuestion(sessionId, [question], {
				[structuralTupleKey(sessionId, itemId)]: { sessionId, itemId },
			}),
		).toEqual({ question, actionable: true });
	});

	it("retains the target-specific overlay for multiple same-kind interactions", () => {
		const secondItemId = AgentItemId.make("question-2");
		const failed: PresentedSessionInteraction = {
			...question,
			submission: "failed",
			error: "first answer failed",
		};
		const submitting: PresentedSessionInteraction = {
			...question,
			interaction: { ...question.interaction, id: secondItemId },
			submission: "submitting",
		};

		expect(
			selectPresentedQuestion(sessionId, [failed, submitting], {}),
		).toEqual({ question: failed, actionable: false });
		expect(selectPresentedQuestion(sessionId, [submitting], {})).toEqual({
			question: submitting,
			actionable: false,
		});
	});

	it("prefers one attached question over an earlier quarantined question", () => {
		const attachedItemId = AgentItemId.make("question-attached");
		const attached: PresentedSessionInteraction = {
			...question,
			interaction: {
				...question.interaction,
				id: attachedItemId,
				questions: [{ question: "Attached question?", options: ["Yes"] }],
			},
		};

		expect(
			selectPresentedQuestion(sessionId, [question, attached], {
				[structuralTupleKey(sessionId, attachedItemId)]: {
					sessionId,
					itemId: attachedItemId,
				},
			}),
		).toEqual({ question: attached, actionable: true });
		expect(
			selectPresentedQuestion(sessionId, [question, attached], {}),
		).toEqual({ question, actionable: false });
	});

	it("retains each permission overlay while filtering detached callbacks", () => {
		const first = {
			interaction: {
				_tag: "Permission" as const,
				id: "permission-1",
				request: {
					id: "permission-1",
					sessionId,
					kind: { _tag: "Bash" as const, command: "bun test" },
					requestedAt: new Date("2026-08-24T00:00:00.000Z"),
					forcePrompt: false,
				},
			},
			submission: "failed" as const,
			error: "decision failed",
		};
		const second = {
			...first,
			interaction: {
				...first.interaction,
				id: "permission-2",
				request: {
					...first.interaction.request,
					id: "permission-2",
					requestedAt: new Date("2026-08-24T00:00:01.000Z"),
				},
			},
			submission: "submitting" as const,
			error: null,
		};

		expect(
			findPresentedPermissions([second, first], {
				"permission-1": first.interaction.request,
				"permission-2": second.interaction.request,
			}),
		).toEqual([first, second]);
		expect(
			findPresentedPermissions([first, second], {
				"permission-2": second.interaction.request,
			}),
		).toEqual([second]);
		const expired = {
			...first.interaction.request,
			recoveryState: "expired" as const,
		};
		expect(
			findPresentedPermissions([first], { "permission-1": expired }),
		).toEqual([
			{
				...first,
				interaction: { ...first.interaction, request: expired },
			},
		]);
	});

	it("folds authoritative attachment snapshots and removals", () => {
		const attached = applyQuestionAttachmentChange(
			{},
			{
				_tag: "snapshot",
				attachments: [{ sessionId, itemId }],
			},
		);
		expect(Object.keys(attached)).toEqual([
			structuralTupleKey(sessionId, itemId),
		]);
		expect(
			applyQuestionAttachmentChange(attached, {
				_tag: "remove",
				sessionId,
				itemId,
			}),
		).toEqual({});
	});

	it("removes quarantined questions from attention and activity inputs", () => {
		expect(
			filterActionableQuestionInteractions(
				sessionId,
				[question.interaction],
				{},
			),
		).toEqual([]);
	});

	it("does not confuse delimiter-bearing session and item tuples", () => {
		const attachedSessionId = SessionId.make("session:alpha\u0000question");
		const attachedItemId = AgentItemId.make("omega");
		const candidateSessionId = SessionId.make("session");
		const candidateItemId = AgentItemId.make("alpha\u0000question:omega");
		const candidate: PresentedSessionInteraction = {
			...question,
			interaction: { ...question.interaction, id: candidateItemId },
		};

		expect(
			selectPresentedQuestion(candidateSessionId, [candidate], {
				[structuralTupleKey(attachedSessionId, attachedItemId)]: {
					sessionId: attachedSessionId,
					itemId: attachedItemId,
				},
			}),
		).toEqual({ question: candidate, actionable: false });
	});
});
