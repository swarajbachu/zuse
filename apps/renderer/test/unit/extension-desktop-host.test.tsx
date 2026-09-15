import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	environment: "local",
	selected: "s1",
	status: "idle",
	modeResult: true,
	setMode: vi.fn(async () => true),
	attach: vi.fn(async () => {}),
	select: vi.fn(),
	setActive: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getLocalEnvironmentId: () => "local",
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: Object.assign(
		(select: (s: unknown) => unknown) =>
			select({ activeEnvironmentId: mocks.environment }),
		{ getState: () => ({ activeEnvironmentId: mocks.environment }) },
	),
}));
vi.mock("../../src/store/sessions.ts", () => ({
	useSessionsStore: {
		getState: () => ({
			selectedSessionId: mocks.selected,
			setPermissionMode: mocks.setMode,
			error: "Mode rejected",
			select: mocks.select,
		}),
	},
}));
vi.mock("../../src/store/chats.ts", () => ({
	useChatsStore: {
		getState: () => ({
			select: mocks.select,
			setActiveSession: mocks.setActive,
		}),
	},
}));
vi.mock("../../src/store/worktrees.ts", () => ({
	useWorktreesStore: () => ({}),
}));
vi.mock("../../src/lib/extension-composer.ts", () => ({
	attachExtensionSnapshot: mocks.attach,
}));
vi.mock("../../src/lib/environment-entities.ts", () => ({
	environmentShellData: () => ({
		sessionsByProject: {
			project: [
				{
					id: "s1",
					projectId: "p1",
					chatId: "c1",
					status: mocks.status,
					archivedAt: null,
				},
			],
		},
	}),
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	useEnvironmentShellResource: () => ({
		data: {
			folders: [{ id: "p1", name: "Project" }],
			sessionsByProject: {
				p1: [
					{
						id: "s1",
						projectId: "p1",
						title: "Fix",
						providerId: "codex",
						model: "gpt",
						status: mocks.status,
						updatedAt: new Date("2026-09-14"),
						archivedAt: null,
					},
					{ id: "archived", archivedAt: new Date() },
				],
			},
		},
		sync: "stale",
		connection: "reconnecting",
	}),
}));
vi.mock("../../src/lib/git-workspace-client-bus.ts", () => ({
	useGitWorkspaceResource: () => ({}),
}));
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	useSessionTimelineResource: () => ({
		data: {
			messages: [
				{
					role: "assistant",
					content: { _tag: "assistant", isPlan: true, text: "OLD PLAN" },
				},
				{ role: "user", content: { _tag: "user", text: "New task" } },
				{ role: "assistant", content: { _tag: "assistant", text: "NEW PLAN" } },
			],
		},
		sync: "live",
		connection: "connected",
	}),
}));

import { createExtensionDesktopHost } from "../../src/lib/extension-desktop-host.ts";

beforeEach(() => {
	mocks.environment = "local";
	mocks.selected = "s1";
	mocks.status = "idle";
	mocks.setMode.mockReset().mockResolvedValue(true);
	mocks.attach.mockClear();
});
it("requires declared capabilities before exposing desktop actions", async () => {
	const host = createExtensionDesktopHost([]);
	await expect(host.preparePlan("s1", "Plan")).rejects.toThrow("planning");
	await expect(host.openSession("s1")).rejects.toThrow("sessions");
	expect(() => host.useSessions()).toThrow("sessions");
	expect(() => host.usePlanOutput("s1")).toThrow("planning");
});
it("prepares but never submits a plan, and does not attach after a rejected mode change", async () => {
	const host = createExtensionDesktopHost(["planning"]);
	await host.preparePlan("s1", "Draw the plan");
	expect(mocks.setMode).toHaveBeenCalledWith("s1", "plan", "local");
	expect(mocks.attach).toHaveBeenCalledWith(
		"s1",
		expect.objectContaining({ text: "Draw the plan" }),
	);
	mocks.attach.mockClear();
	mocks.setMode.mockResolvedValue(false);
	await expect(host.preparePlan("s1", "Plan")).rejects.toThrow("Mode rejected");
	expect(mocks.attach).not.toHaveBeenCalled();
});
it("rejects running, mismatched and remote sessions, including a switch during mode change", async () => {
	const host = createExtensionDesktopHost(["planning"]);
	mocks.status = "running";
	await expect(host.preparePlan("s1", "Plan")).rejects.toThrow("idle");
	mocks.status = "idle";
	mocks.environment = "remote";
	await expect(host.preparePlan("s1", "Plan")).rejects.toThrow("local");
	mocks.environment = "local";
	mocks.setMode.mockImplementation(async () => {
		mocks.selected = "s2";
		return true;
	});
	await expect(host.preparePlan("s1", "Plan")).rejects.toThrow(
		"Conversation changed",
	);
	expect(mocks.attach).not.toHaveBeenCalled();
});
it("keeps archived sessions off the board and exposes stale status honestly", () => {
	const host = createExtensionDesktopHost(["sessions", "planning"]);
	function Probe() {
		const snapshot = host.useSessions();
		const plan = host.usePlanOutput("s1");
		return <div>{JSON.stringify({ snapshot, plan })}</div>;
	}
	const html = renderToStaticMarkup(<Probe />);
	expect(html).toContain("NEW PLAN");
	expect(html).not.toContain("OLD PLAN");
	expect(html).not.toContain("archived");
	expect(html).toContain("stale&quot;:true");
});
