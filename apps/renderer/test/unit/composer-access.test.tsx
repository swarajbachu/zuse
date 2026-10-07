import {
	AgentTurnId,
	EnvironmentId,
	FolderId,
	QueueState,
	Session,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../../src/components/chat-composer.tsx";
import { useSessionsStore } from "../../src/store/sessions.ts";

vi.mock("../../src/components/cloud-connection-notice.tsx", () => ({
	CloudConnectionNotice: () => null,
}));

const fixture = vi.hoisted(() => ({ slackTurn: false }));
beforeEach(() => {
	fixture.slackTurn = false;
});
vi.mock("../../src/lib/cloud-workspaces.ts", async (original) => ({
	...(await original<typeof import("../../src/lib/cloud-workspaces.ts")>()),
	useCloudChatSummaryForSelection: () =>
		fixture.slackTurn
			? {
					workspaceId: "cloud-1",
					state: "resuming",
					runtimeState: "connecting",
					startupPhase: "booting",
					statusCode: "resume-queued",
				}
			: null,
}));

// Provider/model inventory is independent of applied access and requires a live client.
vi.mock("../../src/components/model-picker.tsx", () => ({
	ModelPicker: ({ runtimeMode }: { runtimeMode: string }) => (
		<span data-runtime-mode={runtimeMode} />
	),
}));

vi.mock("../../src/lib/session-timeline-hooks.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-hooks.ts")
	>()),
	useRendererSessionTimeline: (
		sessionId: SessionId,
		_activation: unknown,
		environmentId: EnvironmentId,
	) => ({
		ref: { environmentId, sessionId },
		projection: { runtimeMode: "approval-required", queue: { items: [] } },
		view: {
			data: fixture.slackTurn
				? SessionTimelineProjection.make({
						messages: [],
						status: "booting",
						currentTurn: {
							turnId: AgentTurnId.make("slack-turn"),
							phase: "running",
						},
						queue: QueueState.make({ items: [], paused: false }),
						permissionMode: "default",
						runtimeMode: "approval-required",
					})
				: null,
			origin: "runtime",
			connection: "connected",
			pendingCommands: [],
			failedCommands: [],
			sync: "live",
		},
		messages: [],
		runtime: fixture.slackTurn ? "starting" : "idle",
		presentation: {
			runtime: "idle",
			busy: false,
			turnActive: false,
			turnInFlight: false,
			attention: "idle",
			interactions: [],
		},
	}),
}));

describe("composer applied access", () => {
	it("renders the runtime's applied access instead of a stale Full Access catalog row", () => {
		const draft = useSessionsStore.getState().beginDraft({
			projectId: FolderId.make("project-1"),
			providerId: "codex",
			model: "gpt-5.6-sol",
			runtimeMode: "full-access",
		});
		const session = Session.make({
			...draft,
			id: SessionId.make("cloud-session"),
		});
		const html = renderToStaticMarkup(
			<ChatComposer
				session={session}
				environmentId={EnvironmentId.make("cloud-1")}
			/>,
		);
		expect(html).toContain("Ask for approval");
		expect(html).not.toContain("Full access");
		expect(html).toContain('data-runtime-mode="approval-required"');
	});
});

it("shows Stop for a live Slack turn before the cloud summary catches up", () => {
	fixture.slackTurn = true;
	const draft = useSessionsStore.getState().beginDraft({
		projectId: FolderId.make("project-slack"),
		providerId: "grok",
		model: "grok-4.7",
		runtimeMode: "full-access",
	});
	const session = Session.make({
		...draft,
		id: SessionId.make("cloud-slack-session"),
	});
	const html = renderToStaticMarkup(
		<ChatComposer
			session={session}
			environmentId={EnvironmentId.make("cloud-1")}
		/>,
	);
	expect(html).toContain('aria-label="Stop current turn"');
});
