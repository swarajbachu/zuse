import { ChatId, Folder, FolderId, SessionId } from "@zuse/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { selectHostedCloudHome } from "../../src/lib/hosted-workspace.ts";
import { useChatsStore } from "../../src/store/chats.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useUiStore } from "../../src/store/ui.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

const shell = vi.hoisted(() => ({ folders: [] as unknown[] }));
vi.mock(
	"../../src/lib/session-timeline-client-bus.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/session-timeline-client-bus.ts")
		>()),
		getRendererClientBus: () => ({ snapshot: () => ({ data: shell }) }),
	}),
);
vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/rpc-client.ts")>()),
	setActiveEnvironment: vi.fn(),
	getActiveEnvironment: () => "local",
}));
vi.mock(
	"../../src/lib/cloud-workspace-session-cache.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/cloud-workspace-session-cache.ts")
		>()),
		loadCloudProjects: vi.fn(),
	}),
);
vi.mock(
	"../../src/lib/environment-shell-client-bus.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/environment-shell-client-bus.ts")
		>()),
		environmentShellResourceKey: vi.fn(),
	}),
);
const project = FolderId.make("cloud-project:repo");
const chat = ChatId.make("previous-chat");
const session = SessionId.make("previous-session");
beforeEach(() => {
	shell.folders = [
		Folder.make({
			id: project,
			name: "repo",
			path: "https://github.com/test/repo",
			addedAt: new Date(),
		}),
	];
	useWorkspaceStore.setState({ selectedFolderId: project });
	useChatsStore.setState({
		selectedChatId: chat,
		selectedChatByProject: { [project]: chat },
	});
	useSessionsStore.setState({
		selectedSessionId: session,
		selectedSessionByProject: { [project]: session },
	});
});
it("clears remembered selections and opens a fresh cloud landing", () => {
	const revision = useChatsStore.getState().landingRevision;
	selectHostedCloudHome();
	expect(useWorkspaceStore.getState().selectedFolderId).toBe(project);
	expect(useChatsStore.getState().selectedChatId).toBeNull();
	expect(useChatsStore.getState().selectedChatByProject[project]).toBeNull();
	expect(useSessionsStore.getState().selectedSessionId).toBeNull();
	expect(
		useSessionsStore.getState().selectedSessionByProject[project],
	).toBeNull();
	expect(useChatsStore.getState().landingRevision).toBeGreaterThan(revision);
	expect(useUiStore.getState().activeMainTab).toBe("chat");
});
it("routes an account without projects to cloud setup", () => {
	shell.folders = [];
	selectHostedCloudHome();
	expect(useUiStore.getState().view).toBe("settings");
	expect(useUiStore.getState().settingsSection).toEqual({ kind: "machines" });
});
