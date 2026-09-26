import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Chat,
	ChatId,
	EnvironmentId,
	Folder,
	FolderId,
	Session,
	SessionId,
	Worktree,
	WorktreeId,
} from "@zuse/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { environmentShellResourceKey } from "../../src/lib/environment-shell-client-bus.ts";
import { getRendererClientBus } from "../../src/lib/session-timeline-client-bus.ts";
import { useActiveContext } from "../../src/store/active-workspace.ts";
import { useChatsStore } from "../../src/store/chats.ts";
import { useEnvironmentCatalogStore } from "../../src/store/environment-catalog.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useTerminalsStore } from "../../src/store/terminals.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";
import { useWorktreesStore } from "../../src/store/worktrees.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("selects an unhydrated local tab without sending files, Git or a new terminal to the previous checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-workspace-selection-"));
	roots.push(root);
	const repo = join(root, "repo");
	const worktreePath = join(root, "worktree");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: "pipe",
		}).trim();
	execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	writeFileSync(join(repo, "location.txt"), "main checkout");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "initial");
	git(repo, "worktree", "add", "-b", "new-workspace", worktreePath);
	writeFileSync(join(worktreePath, "location.txt"), "new worktree");

	const environmentId = EnvironmentId.make("local");
	const projectId = FolderId.make("project-selection-test");
	const previousChatId = ChatId.make("previous-chat");
	const chatId = ChatId.make("new-chat");
	const previousSessionId = SessionId.make("previous-session");
	const sessionId = SessionId.make("new-session");
	const worktreeId = WorktreeId.make("new-worktree");
	const now = new Date();
	const folder = Folder.make({
		id: projectId,
		name: "Repository",
		path: repo,
		addedAt: now,
	});
	const chat = Chat.make({
		id: chatId,
		projectId,
		worktreeId,
		title: "New",
		titleProvenance: "manual",
		activeSessionId: sessionId,
		originSessionId: null,
		archivedAt: null,
		lastMessageAt: null,
		lastReadAt: null,
		createdAt: now,
		updatedAt: now,
	});
	const previous = Chat.make({
		...chat,
		id: previousChatId,
		worktreeId: null,
		activeSessionId: previousSessionId,
	});
	const previousSession = Session.make({
		id: previousSessionId,
		projectId,
		chatId: previousChatId,
		worktreeId: null,
		title: "Previous",
		titleProvenance: "manual",
		providerId: "codex",
		model: "gpt-5",
		status: "idle",
		archivedAt: null,
		cursor: null,
		resumeStrategy: "none",
		runtimeMode: "approval-required",
		forkedFromSessionId: null,
		forkedFromMessageId: null,
		permissionMode: "default",
		toolSearch: false,
		createdAt: now,
		updatedAt: now,
	});
	useEnvironmentCatalogStore.setState({ activeEnvironmentId: environmentId });
	const shell = {
		folders: [folder],
		originsByFolder: {},
		chatsByProject: { [projectId]: [chat, previous] },
		sessionsByProject: { [projectId]: [previousSession] },
		creationOperationsByProject: {},
	};
	getRendererClientBus().snapshot(
		environmentShellResourceKey({ environmentId }),
	);
	getRendererClientBus().overlay(
		environmentShellResourceKey({ environmentId }),
		{ initialData: shell, update: () => shell },
	);
	useWorkspaceStore.setState({
		folders: [folder],
		selectedFolderId: projectId,
		loading: false,
	});
	useChatsStore.setState({
		selectedChatId: chatId,
		selectedChatByProject: { [projectId]: chatId },
		pendingCreationByChat: {},
	});
	useSessionsStore.setState({
		selectedSessionId: previousSessionId,
		selectedSessionByProject: { [projectId]: previousSessionId },
	});
	useWorktreesStore.setState({
		byProject: {
			[projectId]: [
				Worktree.make({
					id: worktreeId,
					projectId,
					path: worktreePath,
					name: "new-workspace",
					branch: "new-workspace",
					baseBranch: "main",
					createdAt: now,
					setupStatus: "succeeded",
					setupOutput: "",
					setupStartedAt: null,
					setupFinishedAt: null,
					pokemon: null,
				}),
			],
		},
	});
	useTerminalsStore.setState({ byKey: {}, ownerCatalogsByKey: {} });

	// This is the real selection action, before the session summary arrives.
	// It updates the transcript's selection but cannot discover the project slot.
	useSessionsStore.getState().select(sessionId);
	expect(useSessionsStore.getState().selectedSessionByProject[projectId]).toBe(
		previousSessionId,
	);
	let context: ReturnType<typeof useActiveContext> = { status: "loading" };
	function Probe() {
		context = useActiveContext();
		return null;
	}
	renderToStaticMarkup(createElement(Probe));
	expect(context).toMatchObject({
		status: "ready",
		environmentId,
		sessionId,
		worktreeId,
		rootPath: worktreePath,
	});
	// Capture the resolved context outside React for the same consumers as the UI.
	const resolved = ((): ReturnType<typeof useActiveContext> => context)();
	if (resolved.status !== "ready") throw new Error("Workspace not ready");
	expect(readFileSync(join(resolved.rootPath, "location.txt"), "utf8")).toBe(
		"new worktree",
	);
	expect(git(resolved.rootPath, "branch", "--show-current")).toBe(
		"new-workspace",
	);
	const terminal = useTerminalsStore
		.getState()
		.ensureSlot({ environmentId, chatId }, 0, resolved.rootPath);
	expect(terminal.cwd).toBe(worktreePath);
	expect(git(terminal.cwd, "branch", "--show-current")).toBe("new-workspace");
	expect(readFileSync(join(repo, "location.txt"), "utf8")).toBe(
		"main checkout",
	);
});
