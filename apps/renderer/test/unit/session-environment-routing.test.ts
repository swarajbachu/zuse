import { EnvironmentId, SessionId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	patchActive: vi.fn(),
}));

vi.mock("../../src/lib/environment-entities.ts", () => ({
	activeSessionById: () => null,
	activeSessionsByProject: () => ({}),
	overlayActiveEnvironmentShell: mocks.patchActive,
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
		mocks.patchActive.mockReset();
		mocks.dispatch.mockResolvedValue({ result: undefined });
		useSessionsStore.setState({ draftSession: null, error: null });
	});

	it("does not claim Full Access before a cloud mode change is applied", async () => {
		let reject!: (cause: Error) => void;
		mocks.dispatch.mockReturnValueOnce(
			new Promise((_, fail) => {
				reject = fail;
			}),
		);
		const changing = useSessionsStore
			.getState()
			.setRuntimeMode(
				SessionId.make("cloud-session"),
				"full-access",
				EnvironmentId.make("cloud-workspace"),
			);
		expect(mocks.patchActive).not.toHaveBeenCalled();
		reject(new Error("Runtime unavailable"));
		await changing;
		expect(mocks.patchActive).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().error).toBe("Runtime unavailable");
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

	it("keeps cloud tab removal in its explicit workspace", async () => {
		const sessionId = SessionId.make("removed-cloud-session");
		const environmentId = EnvironmentId.make("cloud-workspace");

		await useSessionsStore.getState().archive(sessionId, environmentId);

		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: { environmentId, sessionId },
				kind: "session.archive",
			}),
		);
	});

	it("treats an already-removed session as a successful archive", async () => {
		const sessionId = SessionId.make("already-removed-cloud-session");
		const environmentId = EnvironmentId.make("cloud-workspace");
		mocks.dispatch.mockRejectedValueOnce({
			_tag: "SessionNotFoundError",
			sessionId,
		});
		useSessionsStore.setState({ selectedSessionId: sessionId });

		await useSessionsStore.getState().archive(sessionId, environmentId);

		expect(useSessionsStore.getState()).toMatchObject({
			selectedSessionId: null,
			error: null,
		});
	});
});
