import { describe, expect, test } from "vitest";
import chatLandingSource from "../../src/components/chat-landing.tsx?raw";
import projectsSidebarSource from "../../src/components/projects-sidebar.tsx?raw";
import cloudChatsSource from "../../src/store/cloud-chats.ts?raw";
import messagesSource from "../../src/store/messages.ts?raw";

describe("cloud chat activation", () => {
	test("viewing history does not activate a paused workspace", () => {
		expect(projectsSidebarSource).toContain(
			"openCloudChat(summary, projectId)",
		);
		expect(cloudChatsSource).toContain(
			"if (!activate && !alreadyLive) return;",
		);
	});

	test("an explicit message activates and attaches the workspace", () => {
		expect(chatLandingSource).toContain("{ activate: true }");
		expect(messagesSource).toContain(
			"openCloudChat(cloudSummary, projectId, { activate: true })",
		);
	});

	test("central history releases the ordinary composer without a runtime", () => {
		expect(cloudChatsSource).toContain(
			"markQueueHydrated(SessionId.make(summary.initialSessionId))",
		);
		expect(cloudChatsSource).toContain(
			'summary.state === "failed" ? "error" : "idle"',
		);
		expect(cloudChatsSource).toContain(
			"const liveSeed = seedFor(current, folder.id, history.firstMessage)",
		);
	});
});
