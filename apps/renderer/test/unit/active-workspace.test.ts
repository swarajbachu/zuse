import { FolderId } from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	workspace: {
		loading: false,
		selectedFolderId: "project",
		folders: [{ id: "project", path: "/main" }],
	},
	sessions: { selectedSessionByProject: { project: "session" } },
	chats: { selectedChatId: "chat", pendingCreationByChat: {} },
	entities: {
		sessionsByProject: {
			project: [{ id: "session", chatId: "chat", worktreeId: null }],
		},
		chatsByProject: {
			project: [{ id: "chat", worktreeId: "worktree" as string | null }],
		},
		creationOperationsByProject: {
			project: [] as Array<{
				chatId: string;
				initialSessionId: string;
				workspacePolicy: { _tag: string };
				worktreeId: string | null;
				phase: string;
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
	useCloudChatSummaryForSelection: () => null,
}));
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	useEnvironmentShellResource: () => ({ data: null }),
}));
vi.mock("../../src/lib/environment-entity-hooks.ts", () => ({
	useActiveEnvironmentEntities: () => state.entities,
}));
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
	state.entities.chatsByProject.project = [
		{ id: "chat", worktreeId: "worktree" },
	];
	state.entities.creationOperationsByProject.project = [];
	state.worktrees.byProject.project = [{ id: "worktree", path: "/worktree" }];
});
describe("active workspace during attached chat startup", () => {
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
		state.entities.chatsByProject.project = [{ id: "chat", worktreeId: null }];
		state.entities.creationOperationsByProject.project = [
			{
				chatId: "chat",
				initialSessionId: "session",
				workspacePolicy: { _tag: "fresh" },
				worktreeId: "worktree",
				phase: "creating_workspace",
			},
		];
		state.worktrees.byProject.project = [];
		expect(readContext()).toMatchObject({ status: "worktree-pending" });
		expect(readRoot()).toBeNull();
	});
	it("still resolves a main-checkout chat normally", () => {
		state.entities.chatsByProject.project = [{ id: "chat", worktreeId: null }];
		expect(readContext()).toMatchObject({ status: "ready", rootPath: "/main" });
		expect(readRoot()).toBe("/main");
	});
});
