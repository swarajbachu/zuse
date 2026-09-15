import type { SessionInteractionSubmission } from "@zuse/client-runtime/session-presentation";
import {
	AgentItemId,
	EnvironmentId,
	PermissionRequest,
	SessionId,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanApprovalSubmissionStatus } from "../../src/components/composer/plan-approval-tray.tsx";
import { PermissionCard } from "../../src/components/permission-card.tsx";
import { QuestionCard } from "../../src/components/question-card.tsx";
import { selectPresentedQuestion } from "../../src/lib/question-actionability.ts";

const sessionId = SessionId.make("overlay-session");
const environmentId = EnvironmentId.make("overlay-environment");

const renderQuestion = (
	submission: SessionInteractionSubmission,
	error: string | null,
) =>
	renderToStaticMarkup(
		<QuestionCard
			environmentId={environmentId}
			sessionId={sessionId}
			itemId={AgentItemId.make("question-overlay")}
			questions={[{ question: "Continue?", options: ["Yes", "No"] }]}
			submission={submission}
			submissionError={error}
		/>,
	);

describe("interaction submission cards", () => {
	it("renders an authoritative failed question overlay and permits retry", () => {
		const markup = renderQuestion("failed", "answer transport failed");

		expect(markup).toContain("Couldn’t submit answer");
		expect(markup).toContain("answer transport failed");
		expect(markup).not.toContain('aria-busy="true"');
	});

	it("renders an authoritative replayed question submission as busy", () => {
		const markup = renderQuestion("submitting", null);

		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain("Submitting answer…");
		expect(markup).toContain("disabled");
	});

	it("keeps a durable-only question quarantined in the card", () => {
		const markup = renderToStaticMarkup(
			<QuestionCard
				environmentId={environmentId}
				sessionId={sessionId}
				itemId={AgentItemId.make("question-detached")}
				questions={[{ question: "Continue?", options: ["Yes", "No"] }]}
				disabled
			/>,
		);

		expect(markup).toContain("Reconnecting to this question…");
		expect(markup).toContain('aria-disabled="true"');
	});

	it("renders the attached question enabled when an earlier durable question is quarantined", () => {
		const detachedId = AgentItemId.make("question-detached-first");
		const attachedId = AgentItemId.make("question-attached-second");
		const makeQuestion = (itemId: typeof attachedId, text: string) => ({
			interaction: {
				_tag: "Question" as const,
				id: itemId,
				questions: [{ question: text, options: ["Yes", "No"] }],
				requestedAt: new Date("2026-08-24T00:00:00.000Z"),
			},
			submission: "pending" as const,
			error: null,
		});
		const selected = selectPresentedQuestion(
			sessionId,
			[
				makeQuestion(detachedId, "Detached question?"),
				makeQuestion(attachedId, "Attached question?"),
			],
			{
				[structuralTupleKey(sessionId, attachedId)]: {
					sessionId,
					itemId: attachedId,
				},
			},
		);
		expect(selected).not.toBeNull();
		if (selected === null) return;
		const markup = renderToStaticMarkup(
			<QuestionCard
				environmentId={environmentId}
				sessionId={sessionId}
				itemId={selected.question.interaction.id}
				questions={selected.question.interaction.questions}
				disabled={!selected.actionable}
			/>,
		);

		expect(markup).toContain("Attached question?");
		expect(markup).not.toContain("Detached question?");
		expect(markup).not.toContain("Reconnecting to this question…");
	});

	it("renders the matching permission failure instead of local-only state", () => {
		const request = PermissionRequest.make({
			id: "permission-overlay",
			sessionId,
			kind: { _tag: "Bash", command: "bun test" },
			requestedAt: new Date("2026-08-24T00:00:00.000Z"),
			forcePrompt: false,
		});
		const markup = renderToStaticMarkup(
			<PermissionCard
				head={request}
				queueSize={1}
				environmentId={environmentId}
				submission="failed"
				submissionError="decision transport failed"
			/>,
		);

		expect(markup).toContain("Couldn’t submit decision");
		expect(markup).toContain("decision transport failed");
	});

	it("announces a failed plan decision with the readable danger token", () => {
		const markup = renderToStaticMarkup(
			<PlanApprovalSubmissionStatus
				submitting={false}
				error="plan decision transport failed"
			/>,
		);

		expect(markup).toContain('role="alert"');
		expect(markup).toContain("text-danger-text");
		expect(markup).toContain("Couldn’t submit plan decision");
		expect(markup).toContain("plan decision transport failed");
	});
});
