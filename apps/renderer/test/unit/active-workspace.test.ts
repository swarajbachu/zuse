import { FolderId } from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";

const state = vi.hoisted(() => ({
	cloud: false,
	workspace: {
		loading: false,
		selectedFolderId: "project" as string | null,
		folders: [{ id: "project", path: "/main" }],
	},
	sessions: {
		selectedSessionId: "session" as string | null,
		selectedSessionByProject: { project: "session" },
	},
	chats: {
		selectedChatId: "chat" as string | null,
		selectedChatByProject: { project: "chat" },
		pendingCreationByChat: {},
	},
	entities: {
		sessionsByProject: {
			project: [
				{ id: "session", chatId: "chat", worktreeId: null as string | null },
			],
		},
		chatsByProject: {
			project: [
				{
					id: "chat",
					updatedAt: new Date(0),
					worktreeId: "worktree" as string | null,
				},
			],
		},
		creationOperationsByProject: {
			project: [] as Array<{
				chatId: string;
				initialSessionId: string;
				workspacePolicy: { _tag: string };
				worktreeId: string | null;
				phase: string;
				updatedAt: Date;
			}>,
		},
	},
	worktrees: {
		byProject: { project: [{ id: "worktree", path: "/worktree" }] },
		refresh: vi.fn(),
	},
}));
vi.mock("../../src/store/workspace.ts", () => ({
	useWorkspaceStore: <T>(select: (value: typeof state.workspace) => T) =>
		select(state.workspace),
}));
vi.mock("../../src/store/sessions.ts", () => ({
	useSessionsStore: <T>(select: (value: typeof state.sessions) => T) =>
		select(state.sessions),
}));
vi.mock("../../src/store/chats.ts", () => ({
	useChatsStore: <T>(select: (value: typeof state.chats) => T) =>
		select(state.chats),
}));
vi.mock("../../src/store/worktrees.ts", () => ({
	EMPTY_WORKTREES: [],
	useWorktreesStore: <T>(select: (value: typeof state.worktrees) => T) =>
		select(state.worktrees),
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: <T>(
		select: (value: { activeEnvironmentId: string }) => T,
	) => select({ activeEnvironmentId: "local" }),
}));
vi.mock("../../src/lib/cloud-workspaces.ts", () => ({
	useCloudChatSummaryForSelection: (selection: { chatId: string | null }) =>
		state.cloud && selection.chatId === "chat"
			? { workspaceId: "local" }
			: null,
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	useEnvironmentShellResource: (environmentId: string | null) => ({
		data:
			state.cloud && environmentId === "local"
				? { folders: [{ id: "cloud-folder", path: "/home/repos/zuse" }] }
				: null,
	}),
}));
vi.mock("../../src/lib/environment-entity-hooks.ts", async () => {
	const { rendererWorkspaceSnapshot } = await import(
		"../../src/lib/renderer-workspace.ts"
	);
	return {
		// The real hook scopes this desktop's projects; "project" is Personal.
		useActiveEnvironmentEntities: () => ({
			...state.entities,
			folders:
				rendererWorkspaceSnapshot().scope.kind === "personal"
					? [{ id: "project" }]
					: [],
		}),
	};
});
const { useActiveContext, useActiveWorkspaceRoot } = await import(
	"../../src/store/active-workspace.ts"
);
const readContext = () => {
	let result: ReturnType<typeof useActiveContext> | undefined;
	const Probe = () => {
		result = useActiveContext();
		return null;
	};
	renderToStaticMarkup(createElement(Probe));
	return result;
};
const readRoot = () => {
	let root: string | null = null;
	const Probe = () => {
		root = useActiveWorkspaceRoot(FolderId.make("project"));
		return null;
	};
	renderToStaticMarkup(createElement(Probe));
	return root;
};

beforeEach(() => {
	state.cloud = false;
	state.workspace.loading = false;
	observeRendererAccount("alice");
	selectRendererWorkspace({ kind: "personal" });
	state.workspace.selectedFolderId = "project";
	state.chats.selectedChatId = "chat";
	state.sessions.selectedSessionId = "session";
	state.sessions.selectedSessionByProject.project = "session";
	state.entities.sessionsByProject.project = [
		{ id: "session", chatId: "chat", worktreeId: null },
	];
	state.entities.chatsByProject.project = [
		{ id: "chat", updatedAt: new Date(0), worktreeId: "worktree" },
	];
	state.entities.creationOperationsByProject.project = [];
	state.worktrees.byProject.project = [{ id: "worktree", path: "/worktree" }];
});
describe("active workspace during attached chat startup", () => {
	it.each([
		false,
		true,
	])("resolves the connected cloud root without a local project selection (local loading: %s)", (loading) => {
		state.cloud = true;
		state.workspace.loading = loading;
		state.workspace.selectedFolderId = null;
		expect(readContext()).toMatchObject({
			status: "ready",
			folderId: "cloud-folder",
			rootPath: "/home/repos/zuse",
			sessionId: "session",
		});
	});
	it("does not expose a Personal execution root from a stale selection in an organization", () => {
		selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
		expect(readContext()).toEqual({ status: "empty" });
		selectRendererWorkspace({ kind: "personal" });
		expect(readContext()).toMatchObject({
			status: "ready",
			rootPath: "/worktree",
		});
	});
	it("follows the chat binding when the session summary has not caught up", () => {
		expect(readContext()).toMatchObject({
			status: "ready",
			rootPath: "/worktree",
		});
	});
	it("waits for the bound worktree row instead of exposing the main checkout", () => {
		state.worktrees.byProject.project = [];
		expect(readContext()).toMatchObject({ status: "worktree-pending" });
		expect(readRoot()).toBeNull();
	});
	it("preserves the durable fresh-workspace intent after optimistic state is cleared", () => {
		state.entities.chatsByProject.project = [
			{ id: "chat", updatedAt: new Date(0), worktreeId: null },
		];
		state.entities.creationOperationsByProject.project = [
			{
				chatId: "chat",
				initialSessionId: "session",
				workspacePolicy: { _tag: "fresh" },
				worktreeId: "worktree",
				phase: "creating_workspace",
				updatedAt: new Date(1),
			},
		];
		state.worktrees.byProject.project = [];
		expect(readContext()).toMatchObject({ status: "worktree-pending" });
		expect(readRoot()).toBeNull();
	});
	it("still resolves a main-checkout chat normally", () => {
		state.entities.chatsByProject.project = [
			{ id: "chat", updatedAt: new Date(0), worktreeId: null },
		];
		expect(readContext()).toMatchObject({ status: "ready", rootPath: "/main" });
		expect(readRoot()).toBe("/main");
	});
});

it("keeps a plain-text chat on its reserved worktree when completion arrives before entity summaries", () => {
	state.entities.chatsByProject.project = [
		{ id: "chat", updatedAt: new Date(0), worktreeId: null },
	];
	state.entities.creationOperationsByProject.project = [
		{
			chatId: "chat",
			initialSessionId: "session",
			workspacePolicy: { _tag: "fresh" },
			worktreeId: "worktree",
			phase: "running",
			updatedAt: new Date(1),
		},
	];
	expect(readContext()).toMatchObject({
		status: "ready",
		rootPath: "/worktree",
	});
});

it("does not resurrect a completed reservation after a newer explicit main-checkout binding", () => {
	state.entities.chatsByProject.project = [
		{ id: "chat", updatedAt: new Date(2), worktreeId: null },
	];
	state.entities.creationOperationsByProject.project = [
		{
			chatId: "chat",
			initialSessionId: "session",
			workspacePolicy: { _tag: "fresh" },
			worktreeId: "worktree",
			phase: "running",
			updatedAt: new Date(1),
		},
	];
	expect(readContext()).toMatchObject({ status: "ready", rootPath: "/main" });
});

it("keeps panels on the selected local chat when the per-project session slot is stale", () => {
	state.sessions.selectedSessionByProject.project = "previous-session";
	state.entities.sessionsByProject.project.push({
		id: "previous-session",
		chatId: "previous-chat",
		worktreeId: null,
	});
	state.entities.chatsByProject.project.push({
		id: "previous-chat",
		updatedAt: new Date(0),
		worktreeId: null,
	});
	expect(readContext()).toMatchObject({
		status: "ready",
		sessionId: "session",
		worktreeId: "worktree",
		rootPath: "/worktree",
	});
	expect(readRoot()).toBe("/worktree");
});
it("does not open main while the selected local chat and session summaries are missing", () => {
	state.entities.chatsByProject.project = [];
	state.entities.sessionsByProject.project = [];
	expect(readContext()).toMatchObject({ status: "worktree-pending" });
	expect(readRoot()).toBeNull();
});

it("waits for a selected chat's worktree even before its session is selected", () => {
	state.sessions.selectedSessionId = null;
	state.worktrees.byProject.project = [];
	expect(readContext()).toMatchObject({
		status: "worktree-pending",
		worktreeId: "worktree",
	});
	expect(readRoot()).toBeNull();
});

it("preserves fresh-workspace intent before a session has been selected", () => {
	state.sessions.selectedSessionId = null;
	state.entities.chatsByProject.project = [
		{ id: "chat", updatedAt: new Date(0), worktreeId: null },
	];
	state.entities.creationOperationsByProject.project = [
		{
			chatId: "chat",
			initialSessionId: "session",
			workspacePolicy: { _tag: "fresh" },
			worktreeId: null,
			phase: "creating_workspace",
			updatedAt: new Date(1),
		},
	];
	expect(readContext()).toMatchObject({ status: "worktree-pending" });
	expect(readRoot()).toBeNull();
});

it("still opens the repository when no chat or session is selected", () => {
	state.chats.selectedChatId = null;
	state.sessions.selectedSessionId = null;
	expect(readContext()).toMatchObject({
		status: "ready",
		rootPath: "/main",
		worktreeId: null,
	});
});
it("does not borrow the previous chat's worktree during a selection change", () => {
	state.entities.chatsByProject.project = [
		{ id: "chat", updatedAt: new Date(0), worktreeId: null },
	];
	state.entities.sessionsByProject.project = [
		{ id: "session", chatId: "previous-chat", worktreeId: "worktree" },
	];
	expect(readContext()).toMatchObject({
		status: "ready",
		rootPath: "/main",
		worktreeId: null,
	});
});
it("keeps per-project file mentions scoped to their own selection", () => {
	state.workspace.selectedFolderId = "other-project";
	state.sessions.selectedSessionId = "other-session";
	state.chats.selectedChatId = "other-chat";
	expect(readRoot()).toBe("/worktree");
});
