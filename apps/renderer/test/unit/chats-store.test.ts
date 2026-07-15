import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import type {
	Chat,
	ChatId,
	Folder,
	FolderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	reportRendererRpcStreamFailure,
	rpcClientFactory,
	subscribeRendererRpcConnection,
	toastAdd,
} = vi.hoisted(() => ({
	reportRendererRpcStreamFailure: vi.fn(),
	rpcClientFactory: vi.fn(),
	subscribeRendererRpcConnection: vi.fn(),
	toastAdd: vi.fn(),
}));

vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: { add: toastAdd },
}));

vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/lib/rpc-client.ts")>();
	return {
		...original,
		getRpcClient: async () => rpcClientFactory(),
		reportRendererRpcStreamFailure,
		subscribeRendererRpcConnection,
	};
});

import {
	archiveChatWithConfirm,
	stopChatChangeStream,
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

const reconnectProjectId = "proj-reconnect" as FolderId;
const reconnectChatId = "chat-reconnect" as ChatId;
const reconnectSessionId = "session-reconnect" as SessionId;
const reconnectFolder = {
	id: reconnectProjectId,
	path: "/tmp/proj-reconnect",
	name: "Reconnect",
	addedAt: now,
} as Folder;

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

const reconnectChat: Chat = {
	...chat,
	id: reconnectChatId,
	projectId: reconnectProjectId,
	activeSessionId: reconnectSessionId,
};

const reconnectSession: Session = {
	...session,
	id: reconnectSessionId,
	projectId: reconnectProjectId,
	chatId: reconnectChatId,
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

describe("chats store live changes", () => {
	afterEach(async () => {
		await stopChatChangeStream(reconnectProjectId);
	});

	it("reconnects a completed change stream and reconciles its snapshot", async () => {
		let streamAttempts = 0;
		let observeConnection: ((snapshot: ConnectionSnapshot) => void) | undefined;
		const unsubscribeConnection = vi.fn(() => {
			observeConnection = undefined;
		});
		const listSessions = vi.fn(() => Effect.succeed([reconnectSession]));
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			observeConnection = listener;
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return unsubscribeConnection;
		});
		rpcClientFactory.mockReturnValue({
			"chat.list": () => Effect.fail(new Error("initial list failed")),
			"chat.streamChanges": () => {
				streamAttempts += 1;
				return streamAttempts === 1
					? Stream.fail(new Error("connection dropped"))
					: Stream.make(reconnectChat);
			},
			"session.list": listSessions,
		});
		useChatsStore.setState({
			chatsByProject: {},
			loadingByProject: {},
			error: null,
		});
		useSessionsStore.setState({ sessionsByProject: {} });

		await useChatsStore.getState().hydrate(reconnectProjectId);
		await vi.waitFor(() =>
			expect(reportRendererRpcStreamFailure).toHaveBeenCalledWith(
				1,
				expect.any(Error),
			),
		);
		expect(observeConnection).toBeDefined();
		observeConnection?.({
			key: "renderer",
			status: "connected",
			generation: 2,
			attempt: 0,
			error: null,
		});
		await vi.waitFor(() =>
			expect(
				useChatsStore.getState().chatsByProject[reconnectProjectId],
			).toEqual([reconnectChat]),
		);

		expect(streamAttempts).toBe(2);
		expect(
			useSessionsStore.getState().sessionsByProject[reconnectProjectId],
		).toEqual([reconnectSession]);
		expect(listSessions).toHaveBeenCalledTimes(1);
		await stopChatChangeStream(reconnectProjectId);
		expect(unsubscribeConnection).toHaveBeenCalledTimes(1);
		expect(observeConnection).toBeUndefined();
	});

	it("does not restore chat state or its stream when hydration settles after workspace removal", async () => {
		const listResult = deferred<ReadonlyArray<Chat>>();
		const listChats = vi.fn(() => Effect.promise(() => listResult.promise));
		subscribeRendererRpcConnection.mockClear();
		rpcClientFactory.mockReturnValue({
			"chat.list": listChats,
			"chat.streamChanges": () => Stream.make(reconnectChat),
			"workspace.remove": () => Effect.void,
			"workspace.setSelected": () => Effect.void,
		});
		useChatsStore.setState({
			chatsByProject: {},
			loadingByProject: {},
			error: null,
		});
		useWorkspaceStore.setState({
			folders: [reconnectFolder],
			selectedFolderId: reconnectProjectId,
			error: null,
		});

		const hydration = useChatsStore.getState().hydrate(reconnectProjectId);
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(1));
		await useWorkspaceStore.getState().remove(reconnectProjectId);
		listResult.resolve([reconnectChat]);
		await hydration;

		expect(
			useChatsStore.getState().chatsByProject[reconnectProjectId],
		).toBeUndefined();
		expect(subscribeRendererRpcConnection).not.toHaveBeenCalled();
	});
});

describe("archiveChatWithConfirm", () => {
	beforeEach(() => {
		toastAdd.mockClear();
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

	it("shows a concise toast after a successful archive", async () => {
		const archivedChat = { ...chat, archivedAt: now } as Chat;
		rpcClientFactory.mockReturnValue({
			"chat.archive": () =>
				Effect.succeed({
					chat: archivedChat,
					cleanup: null,
					checkpoint: {
						archiveCommit: "checkpoint-sha",
						checkpointCreated: true,
						archiveRef: null,
						branch: "feature",
					},
				}),
			"chat.list": () => Effect.succeed([archivedChat]),
			"worktree.list": () => Effect.succeed([]),
		});

		const result = await useChatsStore.getState().archive(chatId);

		expect(result).toEqual({ ok: true });
		expect(toastAdd).toHaveBeenCalledTimes(1);
		expect(toastAdd).toHaveBeenCalledWith({
			type: "success",
			title: "Archived",
		});
	});
});
