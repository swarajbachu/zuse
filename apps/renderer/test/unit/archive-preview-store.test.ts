import type {
	Chat,
	ChatId,
	FolderId,
	Message,
	MessageId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcClientFactory } = vi.hoisted(() => ({
	rpcClientFactory: vi.fn(),
}));

vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/lib/rpc-client.ts")>();
	return { ...original, getRpcClient: async () => rpcClientFactory() };
});

import {
	setArchiveCommandForTest,
	useArchivePreviewStore,
} from "../../src/store/archive-preview.ts";
import { useUiStore } from "../../src/store/ui.ts";

const projectId = "project-archive" as FolderId;
const environmentId = EnvironmentId.make("local");
const chatId = "chat-archive" as ChatId;
const firstSessionId = "session-first" as SessionId;
const secondSessionId = "session-second" as SessionId;
const now = new Date("2026-07-15T00:00:00.000Z");

const archivedChat: Chat = {
	id: chatId,
	projectId,
	worktreeId: null,
	title: "Original title",
	titleProvenance: "manual",
	activeSessionId: secondSessionId,
	originSessionId: null,
	archivedAt: now,
	lastMessageAt: now,
	lastReadAt: now,
	createdAt: now,
	updatedAt: now,
};

const liveChat: Chat = {
	...archivedChat,
	id: "live" as ChatId,
	archivedAt: null,
};

const makeSession = (id: SessionId, title: string): Session => ({
	id,
	projectId,
	title,
	titleProvenance: "manual",
	providerId: "codex",
	model: "gpt-5.4",
	status: "closed",
	archivedAt: now,
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
});

const firstSession = makeSession(firstSessionId, "First");
const secondSession = makeSession(secondSessionId, "Second");
const message: Message = {
	id: "message-1" as MessageId,
	sessionId: secondSessionId,
	role: "assistant",
	content: { _tag: "assistant", text: "Persisted transcript" },
	createdAt: now,
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("archive preview store", () => {
	beforeEach(() => {
		rpcClientFactory.mockReset();
		setArchiveCommandForTest(async ({ kind, payload }) => {
			const client = rpcClientFactory();
			return Effect.runPromise(client[kind](payload));
		});
		useArchivePreviewStore.setState(useArchivePreviewStore.getInitialState());
		useUiStore.setState({ activeMainTab: "chat" });
	});

	it("loads only archived chats for a project", async () => {
		rpcClientFactory.mockReturnValue({
			"chat.list": () => Effect.succeed([liveChat, archivedChat]),
		});

		await useArchivePreviewStore
			.getState()
			.loadProject(environmentId, projectId);

		expect(useArchivePreviewStore.getState().chatsByProject[projectId]).toEqual(
			[archivedChat],
		);
		expect(useArchivePreviewStore.getState().loadedByProject[projectId]).toBe(
			true,
		);
	});

	it("opens the original active session without owning transcript state", async () => {
		const listMessages = vi.fn(() => Effect.succeed([message]));
		const listChats = vi.fn(() => Effect.succeed([archivedChat]));
		rpcClientFactory.mockReturnValue({
			"chat.archivePreview": () =>
				Effect.succeed({
					chat: archivedChat,
					sessions: [firstSession, secondSession],
				}),
			"messages.list": listMessages,
			"chat.list": listChats,
		});

		await useArchivePreviewStore
			.getState()
			.openChat(environmentId, archivedChat);

		const state = useArchivePreviewStore.getState();
		expect(useUiStore.getState().activeMainTab).toBe("archives");
		expect(state.selectedChatByProject[projectId]).toBe(chatId);
		expect(state.selectedSessionByChat[chatId]).toBe(secondSessionId);
		expect(listMessages).not.toHaveBeenCalled();

		await useArchivePreviewStore.getState().showList(environmentId, projectId);
		expect(
			useArchivePreviewStore.getState().selectedChatByProject[projectId],
		).toBeNull();
		expect(useArchivePreviewStore.getState().previewsByChat[chatId]).toEqual({
			chat: archivedChat,
			sessions: [firstSession, secondSession],
		});
		expect(listChats).toHaveBeenCalledWith({
			projectId,
			includeArchived: true,
		});
	});

	it("reconciles a project load that races an archive mutation", async () => {
		const first = deferred<ReadonlyArray<Chat>>();
		const second = deferred<ReadonlyArray<Chat>>();
		const listChats = vi
			.fn()
			.mockReturnValueOnce(Effect.promise(() => first.promise))
			.mockReturnValueOnce(Effect.promise(() => second.promise));
		rpcClientFactory.mockReturnValue({ "chat.list": listChats });

		const loading = useArchivePreviewStore
			.getState()
			.loadProject(environmentId, projectId);
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(1));
		useArchivePreviewStore.getState().upsertChat(archivedChat);
		first.resolve([]);
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(2));
		second.resolve([archivedChat]);
		await loading;

		expect(useArchivePreviewStore.getState().chatsByProject[projectId]).toEqual(
			[archivedChat],
		);
	});

	it("refreshes the catalog when returning to the archived chats page", async () => {
		const recentChat = {
			...archivedChat,
			id: "chat-recent" as ChatId,
			title: "Recently archived",
		};
		const listChats = vi.fn(() => Effect.succeed([recentChat, archivedChat]));
		rpcClientFactory.mockReturnValue({ "chat.list": listChats });
		useArchivePreviewStore.setState({
			chatsByProject: { [projectId]: [archivedChat] },
			loadedByProject: { [projectId]: true },
			selectedChatByProject: { [projectId]: chatId },
		});

		await useArchivePreviewStore.getState().showList(environmentId, projectId);

		expect(listChats).toHaveBeenCalledTimes(1);
		expect(useArchivePreviewStore.getState().chatsByProject[projectId]).toEqual(
			[recentChat, archivedChat],
		);
		expect(
			useArchivePreviewStore.getState().selectedChatByProject[projectId],
		).toBeNull();
	});

	it("does not resurrect preview data when restore wins an in-flight load", async () => {
		const preview = deferred<{
			readonly chat: Chat;
			readonly sessions: ReadonlyArray<Session>;
		}>();
		rpcClientFactory.mockReturnValue({
			"chat.archivePreview": () => Effect.promise(() => preview.promise),
		});
		useArchivePreviewStore.getState().upsertChat(archivedChat);

		const opening = useArchivePreviewStore
			.getState()
			.openChat(environmentId, archivedChat);
		await vi.waitFor(() =>
			expect(
				useArchivePreviewStore.getState().previewLoadingByChat[chatId],
			).toBe(true),
		);
		useArchivePreviewStore.getState().removeChat(chatId, projectId);
		preview.resolve({
			chat: archivedChat,
			sessions: [firstSession, secondSession],
		});
		await opening;

		expect(useArchivePreviewStore.getState().previewsByChat[chatId]).toBe(
			undefined,
		);
		expect(useArchivePreviewStore.getState().chatsByProject[projectId]).toEqual(
			[],
		);
	});
});
