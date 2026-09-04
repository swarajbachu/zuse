import { EnvironmentId, SessionId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
}));

vi.mock("../../src/lib/environment-entities.ts", () => ({
	activeSessionById: () => null,
	activeSessionsByProject: () => ({}),
	overlayActiveEnvironmentShell: () => false,
	overlayEnvironmentShell: () => false,
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getActiveEnvironment: () => "local",
}));

vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	dispatchSessionCommand: mocks.dispatch,
	getRendererClientBus: () => ({
		snapshot: () => ({ failedCommands: [] }),
	}),
	sessionTimelineResourceKey: vi.fn(),
}));

vi.mock("../../src/store/workspace.ts", () => ({
	useWorkspaceStore: {
		getState: () => ({ selectedFolderId: null, select: vi.fn() }),
		subscribe: () => () => undefined,
	},
}));

const { useSessionsStore } = await import("../../src/store/sessions.ts");

describe("session command environment routing", () => {
	beforeEach(() => {
		mocks.dispatch.mockReset();
		mocks.dispatch.mockResolvedValue({ result: undefined });
		useSessionsStore.setState({ draftSession: null, error: null });
	});

	it("keeps a new cloud tab's provider mutation in its explicit workspace", async () => {
		const sessionId = SessionId.make("secondary-cloud-session");
		const environmentId = EnvironmentId.make("cloud-workspace");

		await useSessionsStore
			.getState()
			.setProvider(sessionId, "codex", "gpt-5.6-sol", environmentId);

		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: { environmentId, sessionId },
				kind: "session.setProvider",
			}),
		);
	});
});
