import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	AgentTurnId,
	AttemptId,
	EnvironmentId,
	type Session,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionActivity } from "../../src/components/session-activity.tsx";

const environmentId = EnvironmentId.make("local");
const sessionId = SessionId.make("session");
const turnId = AgentTurnId.make("turn");
const attemptId = AttemptId.make("attempt");
const session = {
	id: sessionId,
	title: "Parent",
	providerId: "claude",
	status: "running",
	parentSessionId: null,
} as unknown as Session;
const child = {
	...session,
	id: SessionId.make("child"),
	title: "Child agent",
	parentSessionId: sessionId,
} as unknown as Session;
const view: ResourceView<SessionTimelineProjection> = {
	data: SessionTimelineProjection.make({
		messages: [],
		status: "running",
		turnCount: 1,
		queue: { items: [], paused: false },
		interactions: [],
		permissionMode: "default",
		runtimeMode: "full-access",
		activeTurn: null,
		executionSteps: [
			{
				id: "task",
				turnId,
				attemptId,
				itemId: "shell",
				parentItemId: null,
				kind: "background",
				label: "Watch build",
				status: "running",
				childSessionId: null,
				nativeChildId: "native-task",
				rootCompletedAt: 1,
				createdAt: 0,
				updatedAt: 1,
				checkpointCapability: "unsupported",
			},
		],
	}),
	origin: "runtime",
	connection: "connected",
	sync: "live",
	generation: 1,
	cursor: { epoch: "epoch", version: 1 },
	pendingCommands: [],
	failedCommands: [],
};
const props = {
	session,
	sessionRef: { environmentId, sessionId },
	view,
	chatRef: { environmentId, chatId: "chat" },
	sessions: [session, child],
	nativeAgents: [],
} as unknown as Parameters<typeof SessionActivity>[0];

describe("session activity", () => {
	it("keys the background and agents sections apart for the same session", () => {
		const sections = (
			SessionActivity(props) as ReactElement<{ children: ReactNode[] }>
		).props.children.filter(isValidElement);
		expect(sections).toHaveLength(2);
		expect(sections.every((section) => section.key !== null)).toBe(true);
		expect(new Set(sections.map((section) => section.key)).size).toBe(2);
	});
	it("renders one background section beside the agents", () => {
		const html = renderToStaticMarkup(<SessionActivity {...props} />);
		expect(html.split('aria-label="Background work"').length - 1).toBe(1);
		expect(html).toContain("1 running");
		expect(html).toContain("Child agent");
	});
	it("keeps an agent-history entry point when the recent window contains no agents", () => {
		const projection = view.data;
		if (projection === null) throw new Error("Fixture requires a projection");
		const html = renderToStaticMarkup(
			<SessionActivity
				{...props}
				sessions={[session]}
				nativeAgents={[]}
				view={{
					...view,
					data: SessionTimelineProjection.make({
						...projection,
						olderMessageSequence: 200,
					}),
				}}
			/>,
		);
		expect(html).toContain("Load older messages");
	});
});
