import type { PresentedSessionInteraction } from "@zuse/client-runtime/session-presentation";
import {
	AgentItemId,
	EnvironmentId,
	FolderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../../src/components/chat-composer.tsx";
import {
	dismissExpiredQuestion,
	type QuestionAnswerController,
	selectAnswerableQuestion,
} from "../../src/components/composer/question-tray.tsx";
import { useSessionsStore } from "../../src/store/sessions.ts";

const sessionId = SessionId.make("question-session");
const itemId = AgentItemId.make("question-item");
let interactions: ReadonlyArray<PresentedSessionInteraction> = [];
let attached = false;

vi.mock("../../src/components/plugins/plugins-popover.tsx", () => ({
	PluginsPopover: () => null,
}));
vi.mock("../../src/components/model-picker.tsx", () => ({
	ModelPicker: () => null,
}));
vi.mock("../../src/lib/session-goal-client-bus.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-goal-client-bus.ts")
	>()),
	useSessionGoalResource: () => ({ data: null, pendingCommands: [] }),
}));
vi.mock(
	"../../src/lib/environment-question-attachments-client-bus.ts",
	async (original) => ({
		...(await original<
			typeof import("../../src/lib/environment-question-attachments-client-bus.ts")
		>()),
		useEnvironmentQuestionAttachments: () => ({
			data: {
				attachmentsByKey: attached
					? { [structuralTupleKey(sessionId, itemId)]: { sessionId, itemId } }
					: {},
			},
		}),
	}),
);
vi.mock("../../src/lib/session-timeline-hooks.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-hooks.ts")
	>()),
	useRendererSessionTimeline: (
		timelineSessionId: SessionId,
		_activation: unknown,
		environmentId: EnvironmentId,
	) => ({
		ref: { environmentId, sessionId: timelineSessionId },
		projection: { runtimeMode: "approval-required", queue: { items: [] } },
		view: { data: null, pendingCommands: [], failedCommands: [], sync: "live" },
		messages: [],
		runtime: "idle",
		presentation: {
			runtime: "idle",
			busy: false,
			turnActive: false,
			turnInFlight: false,
			attention: "question",
			interactions,
		},
	}),
}));

const questionInteraction = (
	expired: boolean,
): PresentedSessionInteraction => ({
	interaction: {
		_tag: "Question",
		id: itemId,
		...(expired ? { recoveryState: "expired" as const } : {}),
		questions: [{ question: "Charge upfront?", options: ["Yes", "No"] }],
		requestedAt: new Date(0),
	},
	submission: "pending",
	error: null,
});

const renderComposer = () => {
	const draft = useSessionsStore.getState().beginDraft({
		projectId: FolderId.make("project-question"),
		providerId: "claude",
		model: "claude-opus-5-5",
		runtimeMode: "approval-required",
	});
	return renderToStaticMarkup(
		<ChatComposer
			session={Session.make({ ...draft, id: sessionId })}
			environmentId={EnvironmentId.make("local-question-environment")}
		/>,
	);
};

const buttonLabelled = (html: string, label: string) =>
	html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];

describe("composer with a pending question", () => {
	beforeEach(() => {
		interactions = [];
		attached = false;
	});

	it("routes the send action to an answerable question", () => {
		interactions = [questionInteraction(false)];
		attached = true;
		const html = renderComposer();

		expect(html).toContain("Charge upfront?");
		expect(buttonLabelled(html, "Submit answer")).toBeDefined();
		expect(buttonLabelled(html, "Send")).toBeUndefined();
	});

	it("keeps ordinary sending available past an expired question", () => {
		interactions = [questionInteraction(true)];
		const html = renderComposer();

		expect(html).toContain("This question has expired.");
		expect(buttonLabelled(html, "Submit answer")).toBeUndefined();
		expect(buttonLabelled(html, "Send")).toBeDefined();
		expect(buttonLabelled(html, "Dismiss")).not.toContain("disabled");
	});
});

describe("composer question routing", () => {
	const controller = (expired: boolean) => {
		const dismiss = vi.fn();
		return {
			dismiss,
			answer: { expired, dismiss } as unknown as QuestionAnswerController,
		};
	};

	it("answers only questions that have not expired", () => {
		const active = controller(false);
		const expired = controller(true);

		expect(selectAnswerableQuestion(active.answer)).toBe(active.answer);
		expect(selectAnswerableQuestion(expired.answer)).toBeNull();
		expect(selectAnswerableQuestion(null)).toBeNull();
	});

	it("dismisses only an expired question when a message is sent", () => {
		const active = controller(false);
		const expired = controller(true);

		dismissExpiredQuestion(active.answer);
		dismissExpiredQuestion(expired.answer);
		dismissExpiredQuestion(null);

		expect(active.dismiss).not.toHaveBeenCalled();
		expect(expired.dismiss).toHaveBeenCalledOnce();
	});
});
