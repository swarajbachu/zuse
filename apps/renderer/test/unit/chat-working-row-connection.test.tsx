import { CommandId, SessionId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const timelineRetain = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/session-timeline-hooks.ts", () => ({
	useRendererSessionTimeline: timelineRetain,
}));

vi.mock("../../src/lib/environment-entity-hooks.ts", () => ({
	useActiveSessionById: () => null,
}));

vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	cloudSummaryForSession: () => ({ startupPhase: "ready" }),
}));

import { ChatWorkingRow } from "../../src/components/chat-working-row.tsx";

describe("ChatWorkingRow cloud delivery", () => {
	it("does not acquire a live timeline connection for an accepted waiting command", () => {
		const commandId = CommandId.make("accepted-while-cloud-sleeps");
		const markup = renderToStaticMarkup(
			<ChatWorkingRow
				messages={[]}
				pendingCommands={[
					{
						commandId,
						kind: "messages.send",
						submittedAt: 1,
						deliveryPhase: "waiting-for-runtime",
						cancellable: true,
					},
				]}
				runtimeState="starting"
				sessionId={SessionId.make("sleeping-cloud-session")}
			/>,
		);

		expect(markup).toContain("Waiting for agent");
		expect(timelineRetain).not.toHaveBeenCalled();
	});
});
