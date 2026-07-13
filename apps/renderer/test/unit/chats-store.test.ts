import type {
	Chat,
	ChatId,
	FolderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcClientFactory } = vi.hoisted(() => ({
	rpcClientFactory: vi.fn(),
}));

vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/lib/rpc-client.ts")>();
	return {
		...original,
		getRpcClient: async () => rpcClientFactory(),
	};
});

import {
	archiveChatWithConfirm,
	useChatsStore,
} from "../../src/store/chats.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useUiStore } from "../../src/store/ui.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

const projectId = "proj-1" as FolderId;
const chatId = "chat-1" as ChatId;
const sessionId = "session-1" as SessionId;
const now = new Date("2026-06-21T00:00:00.000Z");
const initialChatsState = useChatsStore.getInitialState();

const chat: Chat = {
	id: chatId,
	projectId,
	worktreeId: null,
	title: "Lag fix",
	activeSessionId: sessionId,
	originSessionId: null,
	archivedAt: null,
	lastMessageAt: null,
	lastReadAt: now,
	createdAt: now,
	updatedAt: now,
};

const session: Session = {
	id: sessionId,
	projectId,
	title: "Main",
	providerId: "codex",
	model: "gpt-5.4",
	status: "idle",
	archivedAt: null,
	cursor: null,
	resumeStrategy: "none",
	runtimeMode: "approval-required",
	worktreeId: null,
	chatId,
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	createdAt: now,
	updatedAt: now,
};

const deferred = <T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason?: unknown) => void;
} => {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

describe("chats store selection", () => {
	beforeEach(() => {
		useUiStore.setState({ activeMainTab: "chat" });
		useWorkspaceStore.setState({ selectedFolderId: projectId });
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [session] },
			selectedSessionId: null,
			selectedSessionByProject: {},
		});
		useChatsStore.setState({
			chatsByProject: { [projectId]: [chat] },
			selectedChatId: null,
			selectedChatByProject: {},
			archiveProgressByChat: {},
			error: null,
			archive: initialChatsState.archive,
			setArchiveProgress: initialChatsState.setArchiveProgress,
			clearArchiveProgress: initialChatsState.clearArchiveProgress,
		});
	});

	it("returns to the chat surface when selecting a chat from usage", () => {
		useUiStore.setState({ activeMainTab: "usage" });

		useChatsStore.getState().select(chatId);

		expect(useUiStore.getState().activeMainTab).toBe("chat");
		expect(useChatsStore.getState().selectedChatId).toBe(chatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(sessionId);
	});

	it("does not force the chat surface when clearing selection", () => {
		useUiStore.setState({ activeMainTab: "usage" });

		useChatsStore.getState().select(null);

		expect(useUiStore.getState().activeMainTab).toBe("usage");
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useSessionsStore.getState().selectedSessionId).toBeNull();
	});

	it("selects a newly created session even when hydration inserted it first", async () => {
		rpcClientFactory.mockReturnValue({
			"chat.create": () =>
				Effect.succeed({ chat, initialSession: session, initialMessage: null }),
		});

		const result = await useChatsStore
			.getState()
			.create(projectId, session.providerId, session.model);

		expect(result).toEqual({ chatId, initialSessionId: sessionId });
		expect(useChatsStore.getState().selectedChatId).toBe(chatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(sessionId);
		expect(
			useSessionsStore.getState().selectedSessionByProject[projectId],
		).toBe(sessionId);
	});
});

describe("archiveChatWithConfirm", () => {
	beforeEach(() => {
		useChatsStore.setState({
			chatsByProject: { [projectId]: [chat] },
			selectedChatId: chatId,
			selectedChatByProject: { [projectId]: chatId },
			archiveProgressByChat: {},
			error: null,
			archive: initialChatsState.archive,
			setArchiveProgress: initialChatsState.setArchiveProgress,
			clearArchiveProgress: initialChatsState.clearArchiveProgress,
		});
	});

	it("sets archive progress during the first archive attempt and clears it on success", async () => {
		const first = deferred<{ readonly ok: true }>();
		useChatsStore.setState({
			archive: async () => first.promise,
		});

		const run = archiveChatWithConfirm(chatId);

		expect(useChatsStore.getState().archiveProgressByChat[chatId]).toBe(
			"archiving",
		);
		first.resolve({ ok: true });
		await run;
		expect(
			useChatsStore.getState().archiveProgressByChat[chatId],
		).toBeUndefined();
	});

	it("clears progress and throws when archive fails", async () => {
		useChatsStore.setState({
			archive: async () => ({
				ok: false,
				reason: "git worktree remove failed",
			}),
		});

		await expect(archiveChatWithConfirm(chatId)).rejects.toThrow(
			"git worktree remove failed",
		);
		expect(
			useChatsStore.getState().archiveProgressByChat[chatId],
		).toBeUndefined();
	});
});
