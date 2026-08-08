import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import type {
	Chat,
	ChatId,
	ChatSummaryChange,
	Folder,
	FolderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { ComposerInput } from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
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
		getRpcClient: async (environmentId?: unknown) =>
			rpcClientFactory(environmentId),
		reportRendererRpcStreamFailure,
		subscribeRendererRpcConnection,
	};
});

import { openNewChatLanding } from "../../src/lib/open-new-chat-landing.ts";
import { useArchivePreviewStore } from "../../src/store/archive-preview.ts";
import {
	archiveChatWithConfirm,
	stopChatChangeStream,
	useChatsStore,
} from "../../src/store/chats.ts";
import { useMessagesStore } from "../../src/store/messages.ts";
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
	titleProvenance: "manual",
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
	titleProvenance: "manual",
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

const nextChatId = "chat-2" as ChatId;
const nextSessionId = "session-2" as SessionId;
const nextChat: Chat = {
	...chat,
	id: nextChatId,
	title: "Next chat",
	activeSessionId: nextSessionId,
};
const nextSession: Session = {
	...session,
	id: nextSessionId,
	chatId: nextChatId,
	title: "Next session",
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

	it.each([
		"usage",
		"archives",
	] as const)("opens the new-chat landing from %s", (activeMainTab) => {
		useUiStore.setState({ activeMainTab });

		openNewChatLanding(projectId);

		expect(useUiStore.getState().activeMainTab).toBe("chat");
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

		expect(result).toEqual({
			chatId,
			initialSessionId: sessionId,
			worktreeId: null,
			startupQueueId: null,
		});
		expect(useChatsStore.getState().selectedChatId).toBe(chatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(sessionId);
		expect(
			useSessionsStore.getState().selectedSessionByProject[projectId],
		).toBe(sessionId);
	});

	it("creates on a remote environment without touching local stores", async () => {
		let environmentIdSeen: unknown;
		let payload: Record<string, unknown> | undefined;
		rpcClientFactory.mockImplementation((environmentId: unknown) => {
			environmentIdSeen = environmentId;
			return {
				"chat.create": (input: Record<string, unknown>) =>
					Effect.promise(async () => {
						payload = input;
						return { chat, initialSession: session, initialMessage: null };
					}),
			};
		});
		const startupInput = new ComposerInput({
			text: "run this over there",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});

		const result = await useChatsStore
			.getState()
			.create(projectId, session.providerId, session.model, {
				environmentId: "env-remote",
				startupInput,
			});

		expect(environmentIdSeen).toBe("env-remote");
		expect(result?.chatId).toBe(chatId);
		expect(result?.remoteSeed).toEqual({
			chat,
			initialSession: session,
			initialMessage: null,
		});
		// The prompt travels as server-side `initialPrompt`; the local startup
		// queue and workspace policy machinery must not be engaged.
		expect(payload?.initialPrompt).toBe("run this over there");
		expect(payload?.startupInput).toBeUndefined();
		expect(payload?.startupQueueId).toBeUndefined();
		expect(payload?.workspacePolicy).toBeUndefined();
		expect(payload?.worktreeId).toBeUndefined();
		// No local-store writes: the target environment's stores are seeded
		// during the follow-up switch instead.
		expect(useChatsStore.getState().chatsByProject[projectId]).toEqual([chat]);
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useChatsStore.getState().pendingCreationByChat).toEqual({});
		expect(useSessionsStore.getState().sessionsByProject[projectId]).toEqual([
			session,
		]);
		expect(useSessionsStore.getState().selectedSessionId).toBeNull();
	});

	it("inserts the booting shell and startup queue before creation acknowledges", async () => {
		const acknowledgement = deferred<void>();
		let payload:
			| {
					readonly chatId: ChatId;
					readonly initialSessionId: SessionId;
					readonly background?: boolean;
			  }
			| undefined;
		rpcClientFactory.mockReturnValue({
			"chat.create": (input: typeof payload) =>
				Effect.promise(async () => {
					payload = input;
					await acknowledgement.promise;
					if (input === undefined) throw new Error("missing create payload");
					const createdSession = {
						...session,
						id: input.initialSessionId,
						chatId: input.chatId,
						status: "booting" as const,
					};
					return {
						chat: {
							...chat,
							id: input.chatId,
							activeSessionId: input.initialSessionId,
						},
						initialSession: createdSession,
						initialMessage: null,
					};
				}),
		});
		useMessagesStore.setState({ queueBySession: {} });
		const startupInput = new ComposerInput({
			text: "start after boot",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});

		const pending = useChatsStore
			.getState()
			.create(projectId, session.providerId, session.model, { startupInput });
		const optimisticSessionId = useSessionsStore.getState().selectedSessionId;
		const optimisticChatId = useChatsStore.getState().selectedChatId;

		expect(optimisticChatId).not.toBeNull();
		expect(optimisticSessionId).not.toBeNull();
		expect(
			useSessionsStore.getState().sessionsByProject[projectId]?.[0]?.status,
		).toBe("booting");
		expect(
			useMessagesStore.getState().queueBySession[optimisticSessionId ?? ""]?.[0]
				?.input.text,
		).toBe("start after boot");
		expect(
			useMessagesStore.getState().messagesBySession[optimisticSessionId ?? ""],
		).toBeUndefined();
		expect(
			useChatsStore.getState().pendingCreationByChat[optimisticChatId ?? ""],
		).toMatchObject({
			chatId: optimisticChatId,
			sessionId: optimisticSessionId,
			phase: "creating-chat",
		});

		acknowledgement.resolve();
		await pending;
		expect(payload?.chatId).toBe(optimisticChatId);
		expect(payload?.initialSessionId).toBe(optimisticSessionId);
		expect(payload?.background).toBe(true);
		expect(
			useChatsStore.getState().pendingCreationByChat[optimisticChatId ?? ""],
		).toBeUndefined();
	});

	it("does not steal focus when creation acknowledges after the user navigates away", async () => {
		const acknowledgement = deferred<{
			readonly chat: Chat;
			readonly initialSession: Session;
			readonly initialMessage: null;
		}>();
		rpcClientFactory.mockReturnValue({
			"chat.create": () => Effect.promise(() => acknowledgement.promise),
		});
		useChatsStore.setState({
			chatsByProject: { [projectId]: [nextChat] },
			selectedChatId: nextChatId,
			selectedChatByProject: { [projectId]: nextChatId },
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [nextSession] },
			selectedSessionId: nextSessionId,
			selectedSessionByProject: { [projectId]: nextSessionId },
		});

		const pending = useChatsStore
			.getState()
			.create(projectId, session.providerId, session.model);
		const optimisticChatId = useChatsStore.getState().selectedChatId;
		const optimisticSessionId = useSessionsStore.getState().selectedSessionId;
		expect(optimisticChatId).not.toBe(nextChatId);
		expect(optimisticSessionId).not.toBe(nextSessionId);

		useChatsStore.getState().select(nextChatId);

		acknowledgement.resolve({
			chat: {
				...chat,
				id: optimisticChatId as ChatId,
				activeSessionId: optimisticSessionId,
			},
			initialSession: {
				...session,
				id: optimisticSessionId as SessionId,
				chatId: optimisticChatId as ChatId,
				status: "booting",
			},
			initialMessage: null,
		});
		await pending;

		expect(useChatsStore.getState().selectedChatId).toBe(nextChatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(nextSessionId);
	});

	it("keeps a failed provisional chat retryable with the same stable ids", async () => {
		const payloads: Array<{
			readonly operationId?: string;
			readonly chatId?: ChatId;
			readonly initialSessionId?: SessionId;
		}> = [];
		let attempt = 0;
		rpcClientFactory.mockReturnValue({
			"chat.create": (payload: {
				readonly operationId?: string;
				readonly chatId?: ChatId;
				readonly initialSessionId?: SessionId;
			}) => {
				payloads.push(payload);
				attempt += 1;
				return attempt === 1
					? Effect.fail(new Error("remote unavailable"))
					: Effect.succeed({
							chat: {
								...chat,
								id: payload.chatId ?? chatId,
								activeSessionId: payload.initialSessionId ?? sessionId,
							},
							initialSession: {
								...session,
								id: payload.initialSessionId ?? sessionId,
								chatId: payload.chatId ?? chatId,
							},
							initialMessage: null,
						});
			},
		});

		await expect(
			useChatsStore
				.getState()
				.create(projectId, session.providerId, session.model, {
					workspacePolicy: { _tag: "fresh" },
					workspaceRequested: true,
				}),
		).resolves.toBeNull();
		const failedChatId = useChatsStore.getState().selectedChatId;
		expect(failedChatId).not.toBeNull();
		expect(
			useChatsStore.getState().pendingCreationByChat[failedChatId ?? ""],
		).toMatchObject({ phase: "failed", error: "remote unavailable" });

		await expect(
			useChatsStore.getState().retryCreation(failedChatId as ChatId),
		).resolves.toBe(true);
		expect(payloads[1]).toMatchObject(payloads[0] ?? {});
		expect(
			useChatsStore.getState().pendingCreationByChat[failedChatId ?? ""],
		).toBeUndefined();
	});

	it("restores a durable failed creation without changing navigation", async () => {
		useChatsStore.setState({
			chatsByProject: { [projectId]: [nextChat] },
			selectedChatId: nextChatId,
			selectedChatByProject: { [projectId]: nextChatId },
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [nextSession] },
			selectedSessionId: nextSessionId,
			selectedSessionByProject: { [projectId]: nextSessionId },
		});
		rpcClientFactory.mockReturnValue({
			"chat.list": () => Effect.succeed([nextChat]),
			"chat.archiveJobs": () => Effect.succeed([]),
			"chat.creation.list": () =>
				Effect.succeed([
					{
						operationId: "create-restored",
						chatId,
						initialSessionId: sessionId,
						projectId,
						providerId: session.providerId,
						model: session.model,
						title: null,
						runtimeMode: session.runtimeMode,
						permissionMode: session.permissionMode,
						toolSearch: false,
						prompt: "keep working",
						startupInput: null,
						startupQueueId: null,
						workspacePolicy: { _tag: "fresh" as const },
						worktreeId: null,
						status: "failed" as const,
						error: "fetch failed",
						createdAt: now,
						updatedAt: now,
					},
				]),
		});

		await useChatsStore.getState().hydrate(projectId);

		expect(useChatsStore.getState().selectedChatId).toBe(nextChatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(nextSessionId);
		expect(
			useChatsStore.getState().pendingCreationByChat[chatId],
		).toMatchObject({
			phase: "failed",
			error: "fetch failed",
			prompt: "keep working",
		});

		rpcClientFactory.mockReturnValue({
			"chat.list": () => Effect.succeed([nextChat, chat]),
			"chat.archiveJobs": () => Effect.succeed([]),
			"chat.creation.list": () => Effect.succeed([]),
		});
		await useChatsStore.getState().hydrate(projectId);

		expect(
			useChatsStore.getState().pendingCreationByChat[chatId],
		).toBeUndefined();
		expect(useChatsStore.getState().selectedChatId).toBe(nextChatId);
	});

	it("resumes an interrupted durable creation with the same prompt and ids", async () => {
		const startupInput = new ComposerInput({
			text: "continue after restart",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});
		const createPayloads: Array<{
			readonly operationId?: string;
			readonly chatId?: ChatId;
			readonly initialSessionId?: SessionId;
			readonly startupQueueId?: string;
		}> = [];
		const persisted: Array<{
			readonly sessionId: SessionId;
			readonly queueId: string;
			readonly input: ComposerInput;
		}> = [];
		const originalPersistQueued = useMessagesStore.getState().persistQueued;
		useMessagesStore.setState({
			persistQueued: async (persistSessionId, queueId, input) => {
				persisted.push({ sessionId: persistSessionId, queueId, input });
			},
		});
		useChatsStore.setState({
			chatsByProject: { [projectId]: [nextChat] },
			selectedChatId: nextChatId,
			selectedChatByProject: { [projectId]: nextChatId },
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [nextSession] },
			selectedSessionId: nextSessionId,
			selectedSessionByProject: { [projectId]: nextSessionId },
		});
		rpcClientFactory.mockReturnValue({
			"chat.list": () => Effect.succeed([nextChat]),
			"chat.archiveJobs": () => Effect.succeed([]),
			"chat.creation.list": () =>
				Effect.succeed([
					{
						operationId: "create-interrupted",
						chatId,
						initialSessionId: sessionId,
						projectId,
						providerId: session.providerId,
						model: session.model,
						title: null,
						runtimeMode: session.runtimeMode,
						permissionMode: session.permissionMode,
						toolSearch: false,
						prompt: startupInput.text,
						startupInput,
						startupQueueId: "queue-stable",
						workspacePolicy: { _tag: "fresh" as const },
						worktreeId: null,
						status: "creating_workspace" as const,
						error: null,
						createdAt: now,
						updatedAt: now,
					},
				]),
			"chat.create": (payload: (typeof createPayloads)[number]) =>
				Effect.sync(() => {
					createPayloads.push(payload);
					return {
						chat,
						initialSession: session,
						initialMessage: null,
					};
				}),
		});

		try {
			await useChatsStore.getState().hydrate(projectId);
			await vi.waitFor(() => expect(createPayloads).toHaveLength(1));
			await vi.waitFor(() => expect(persisted).toHaveLength(1));
		} finally {
			useMessagesStore.setState({ persistQueued: originalPersistQueued });
		}

		expect(createPayloads[0]).toMatchObject({
			operationId: "create-interrupted",
			chatId,
			initialSessionId: sessionId,
			startupQueueId: "queue-stable",
		});
		expect(persisted[0]).toMatchObject({
			sessionId,
			queueId: "queue-stable",
			input: startupInput,
		});
		expect(useChatsStore.getState().selectedChatId).toBe(nextChatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(nextSessionId);
	});

	it("does not let a stale create receipt overwrite a live rename and idle status", async () => {
		const acknowledgement = deferred<{
			readonly chat: Chat;
			readonly initialSession: Session;
			readonly initialMessage: null;
		}>();
		rpcClientFactory.mockReturnValue({
			"chat.create": () => Effect.promise(() => acknowledgement.promise),
		});

		const pending = useChatsStore
			.getState()
			.create(projectId, session.providerId, session.model);
		const createdChat = useChatsStore.getState().chatsByProject[projectId]?.[0];
		const createdSession =
			useSessionsStore.getState().sessionsByProject[projectId]?.[0];
		expect(createdChat).toBeDefined();
		expect(createdSession).toBeDefined();
		if (createdChat === undefined || createdSession === undefined) return;

		const liveAt = new Date(createdChat.updatedAt.getTime() + 2_000);
		const liveChat: Chat = {
			...createdChat,
			title: "Simple Hello Check In",
			titleProvenance: "automatic",
			updatedAt: liveAt,
		};
		const liveSession: Session = {
			...createdSession,
			title: "Simple Hello Check In",
			titleProvenance: "automatic",
			status: "idle",
			updatedAt: liveAt,
		};
		useChatsStore.setState((state) => ({
			chatsByProject: {
				...state.chatsByProject,
				[projectId]: [
					liveChat,
					...(state.chatsByProject[projectId] ?? []).filter(
						(row) => row.id !== liveChat.id,
					),
				],
			},
		}));
		useSessionsStore.setState((state) => ({
			sessionsByProject: {
				...state.sessionsByProject,
				[projectId]: [
					liveSession,
					...(state.sessionsByProject[projectId] ?? []).filter(
						(row) => row.id !== liveSession.id,
					),
				],
			},
		}));

		acknowledgement.resolve({
			chat: {
				...createdChat,
				title: "New chat",
				titleProvenance: "pending",
			},
			initialSession: {
				...createdSession,
				title: "New chat",
				titleProvenance: "pending",
				status: "booting",
			},
			initialMessage: null,
		});
		await pending;

		expect(
			useChatsStore
				.getState()
				.chatsByProject[projectId]?.find((row) => row.id === liveChat.id),
		).toMatchObject({
			title: "Simple Hello Check In",
			titleProvenance: "automatic",
		});
		expect(
			useSessionsStore
				.getState()
				.sessionsByProject[projectId]?.find((row) => row.id === liveSession.id),
		).toMatchObject({
			title: "Simple Hello Check In",
			titleProvenance: "automatic",
			status: "idle",
		});
	});
});

describe("chats store live changes", () => {
	afterEach(async () => {
		await stopChatChangeStream(reconnectProjectId);
	});

	it("hydrates from chat.list without waiting for the live stream snapshot", async () => {
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return vi.fn();
		});
		rpcClientFactory.mockReturnValue({
			"chat.list": () => Effect.succeed([reconnectChat]),
			"chat.streamChanges": () => Stream.never,
		});
		useChatsStore.setState({
			chatsByProject: {},
			loadingByProject: {},
			error: null,
		});

		await useChatsStore.getState().hydrate(reconnectProjectId);

		await vi.waitFor(
			() =>
				expect(
					useChatsStore.getState().chatsByProject[reconnectProjectId],
				).toEqual([reconnectChat]),
			{ timeout: 1_500 },
		);
		expect(useChatsStore.getState().loadingByProject[reconnectProjectId]).toBe(
			false,
		);
	});

	it("does not let a stale fallback replace a newer stream snapshot", async () => {
		let publishSnapshot: ((chats: ReadonlyArray<Chat>) => void) | undefined;
		const fallback = deferred<ReadonlyArray<Chat>>();
		const listChats = vi.fn(() => Effect.promise(() => fallback.promise));
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return vi.fn();
		});
		rpcClientFactory.mockReturnValue({
			"chat.list": listChats,
			"chat.streamChanges": () =>
				Stream.callback<ChatSummaryChange>((queue) =>
					Effect.sync(() => {
						publishSnapshot = (chats) =>
							Queue.offerUnsafe(queue, { _tag: "snapshot", chats });
					}),
				),
		});
		useChatsStore.setState({
			chatsByProject: {},
			loadingByProject: {},
			error: null,
		});

		await useChatsStore.getState().hydrate(reconnectProjectId);
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(1), {
			timeout: 1_500,
		});
		publishSnapshot?.([reconnectChat]);
		await vi.waitFor(() =>
			expect(
				useChatsStore.getState().chatsByProject[reconnectProjectId],
			).toEqual([reconnectChat]),
		);

		fallback.resolve([]);
		await Promise.resolve();
		await Promise.resolve();

		expect(useChatsStore.getState().chatsByProject[reconnectProjectId]).toEqual(
			[reconnectChat],
		);
	});

	it("ignores a fallback error after a newer stream snapshot", async () => {
		let publishSnapshot: ((chats: ReadonlyArray<Chat>) => void) | undefined;
		const fallback = deferred<ReadonlyArray<Chat>>();
		const listChats = vi.fn(() => Effect.promise(() => fallback.promise));
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return vi.fn();
		});
		rpcClientFactory.mockReturnValue({
			"chat.list": listChats,
			"chat.streamChanges": () =>
				Stream.callback<ChatSummaryChange>((queue) =>
					Effect.sync(() => {
						publishSnapshot = (chats) =>
							Queue.offerUnsafe(queue, { _tag: "snapshot", chats });
					}),
				),
		});
		useChatsStore.setState({
			chatsByProject: {},
			loadingByProject: {},
			error: null,
		});

		await useChatsStore.getState().hydrate(reconnectProjectId);
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(1), {
			timeout: 1_500,
		});
		publishSnapshot?.([reconnectChat]);
		await vi.waitFor(() =>
			expect(
				useChatsStore.getState().chatsByProject[reconnectProjectId],
			).toEqual([reconnectChat]),
		);

		fallback.reject(new Error("stale fallback failed"));
		await Promise.resolve();
		await Promise.resolve();

		expect(useChatsStore.getState().error).toBeNull();
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
			"chat.streamChanges": () => {
				streamAttempts += 1;
				return streamAttempts === 1
					? Stream.fail(new Error("connection dropped"))
					: Stream.make({
							_tag: "snapshot" as const,
							chats: [reconnectChat],
						});
			},
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
		expect(listSessions).not.toHaveBeenCalled();
		await stopChatChangeStream(reconnectProjectId);
		expect(unsubscribeConnection).toHaveBeenCalledTimes(1);
		expect(observeConnection).toBeUndefined();
	});

	it("applies a chat created externally after the initial sidebar hydration", async () => {
		let publishChat: ((chat: Chat) => void) | undefined;
		const listChats = vi.fn(() => Effect.succeed([] as ReadonlyArray<Chat>));
		const listSessions = vi.fn(() => Effect.succeed([reconnectSession]));
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return vi.fn();
		});
		rpcClientFactory.mockReturnValue({
			"chat.streamChanges": () =>
				Stream.concat(
					Stream.make({
						_tag: "snapshot" as const,
						chats: [] as ReadonlyArray<Chat>,
					}),
					Stream.callback<ChatSummaryChange>((queue) =>
						Effect.sync(() => {
							publishChat = (chat) =>
								Queue.offerUnsafe(queue, { _tag: "change", chat });
						}),
					),
				),
			"session.list": listSessions,
		});
		useChatsStore.setState({
			chatsByProject: {},
			loadingByProject: {},
			error: null,
		});
		useSessionsStore.setState({ sessionsByProject: {} });

		await useChatsStore.getState().hydrate(reconnectProjectId);
		await vi.waitFor(() => expect(publishChat).toBeDefined());
		publishChat?.(reconnectChat);

		await vi.waitFor(() =>
			expect(
				useChatsStore.getState().chatsByProject[reconnectProjectId],
			).toEqual([reconnectChat]),
		);
		expect(listChats).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
		expect(
			useSessionsStore.getState().sessionsByProject[reconnectProjectId],
		).toEqual([reconnectSession]);
	});

	it("applies an automatic title change without reloading the sidebar", async () => {
		let publishChat: ((chat: Chat) => void) | undefined;
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return vi.fn();
		});
		rpcClientFactory.mockReturnValue({
			"chat.streamChanges": () =>
				Stream.concat(
					Stream.make({
						_tag: "snapshot" as const,
						chats: [reconnectChat],
					}),
					Stream.callback<ChatSummaryChange>((queue) =>
						Effect.sync(() => {
							publishChat = (chat) =>
								Queue.offerUnsafe(queue, { _tag: "change", chat });
						}),
					),
				),
		});
		useChatsStore.setState({
			chatsByProject: {},
			loadingByProject: {},
			error: null,
		});
		useSessionsStore.setState({ sessionsByProject: {} });

		await useChatsStore.getState().hydrate(reconnectProjectId);
		await vi.waitFor(() => expect(publishChat).toBeDefined());
		publishChat?.({
			...reconnectChat,
			title: "Reconnect Reliability",
			titleProvenance: "automatic",
		});

		await vi.waitFor(() =>
			expect(
				useChatsStore.getState().chatsByProject[reconnectProjectId]?.[0],
			).toMatchObject({
				title: "Reconnect Reliability",
				titleProvenance: "automatic",
			}),
		);
	});

	it("does not restore chat state or its stream when hydration settles after workspace removal", async () => {
		let publishSnapshot: (() => void) | undefined;
		const unsubscribe = vi.fn();
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return unsubscribe;
		});
		rpcClientFactory.mockReturnValue({
			"chat.streamChanges": () =>
				Stream.callback<ChatSummaryChange>((queue) =>
					Effect.sync(() => {
						publishSnapshot = () =>
							Queue.offerUnsafe(queue, {
								_tag: "snapshot",
								chats: [reconnectChat],
							});
					}),
				),
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

		await useChatsStore.getState().hydrate(reconnectProjectId);
		await vi.waitFor(() => expect(publishSnapshot).toBeDefined());
		await useWorkspaceStore.getState().remove(reconnectProjectId);
		publishSnapshot?.();

		expect(
			useChatsStore.getState().chatsByProject[reconnectProjectId],
		).toBeUndefined();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe("archiveChatWithConfirm", () => {
	beforeEach(() => {
		toastAdd.mockClear();
		useArchivePreviewStore.setState(useArchivePreviewStore.getInitialState());
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

	it("clears progress without leaking a rejected promise when archive fails", async () => {
		useChatsStore.setState({
			archive: async () => ({
				ok: false,
				reason: "git worktree remove failed",
			}),
		});

		await expect(archiveChatWithConfirm(chatId)).resolves.toBeUndefined();
		expect(
			useChatsStore.getState().archiveProgressByChat[chatId],
		).toBeUndefined();
	});

	it("keeps successful background cleanup silent", async () => {
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
					job: null,
				}),
			"chat.list": () => Effect.succeed([archivedChat]),
			"worktree.list": () => Effect.succeed([]),
		});

		const result = await useChatsStore.getState().archive(chatId);

		expect(result).toEqual({ ok: true });
		expect(toastAdd).not.toHaveBeenCalled();
	});

	it("removes the chat before archive acknowledgement", async () => {
		const acknowledgement = deferred<{
			readonly chat: Chat;
			readonly cleanup: null;
			readonly checkpoint: null;
			readonly job: null;
		}>();
		const archivedChat = { ...chat, archivedAt: now } as Chat;
		rpcClientFactory.mockReturnValue({
			"chat.archive": () => Effect.promise(() => acknowledgement.promise),
			"chat.list": () => Effect.succeed([]),
			"worktree.list": () => Effect.succeed([]),
		});

		const pending = useChatsStore.getState().archive(chatId);
		expect(useChatsStore.getState().chatsByProject[projectId]).toEqual([]);
		expect(useChatsStore.getState().selectedChatId).toBeNull();
		acknowledgement.resolve({
			chat: archivedChat,
			cleanup: null,
			checkpoint: null,
			job: null,
		});
		await expect(pending).resolves.toEqual({ ok: true });
	});

	it("rolls back only the failed chat when two archives overlap", async () => {
		const firstAcknowledgement = deferred<never>();
		const secondAcknowledgement = deferred<{
			readonly chat: Chat;
			readonly cleanup: null;
			readonly checkpoint: null;
			readonly job: null;
		}>();
		useChatsStore.setState({
			chatsByProject: { [projectId]: [chat, nextChat] },
			selectedChatId: chatId,
			selectedChatByProject: { [projectId]: chatId },
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [session, nextSession] },
			selectedSessionId: sessionId,
			selectedSessionByProject: { [projectId]: sessionId },
		});
		rpcClientFactory.mockReturnValue({
			"chat.archive": ({ chatId: requestedChatId }: { chatId: ChatId }) =>
				requestedChatId === chatId
					? Effect.promise(() => firstAcknowledgement.promise)
					: Effect.promise(() => secondAcknowledgement.promise),
			"chat.list": () => Effect.succeed([chat]),
			"worktree.list": () => Effect.succeed([]),
		});

		const first = useChatsStore.getState().archive(chatId);
		const second = useChatsStore.getState().archive(nextChatId);
		secondAcknowledgement.resolve({
			chat: { ...nextChat, archivedAt: now },
			cleanup: null,
			checkpoint: null,
			job: null,
		});
		await expect(second).resolves.toEqual({ ok: true });
		firstAcknowledgement.reject(new Error("durable acceptance failed"));
		await expect(first).resolves.toEqual({
			ok: false,
			reason: "durable acceptance failed",
		});

		expect(useChatsStore.getState().chatsByProject[projectId]).toEqual([chat]);
		expect(
			useSessionsStore
				.getState()
				.sessionsByProject[projectId]?.map((candidate) => candidate.chatId),
		).toEqual([chatId]);
		expect(useChatsStore.getState().selectedChatId).toBeNull();
	});

	it("moves the archived chat into its folder and selects the next live chat", async () => {
		const archivedChat = { ...chat, archivedAt: now } as Chat;
		useChatsStore.setState({
			chatsByProject: { [projectId]: [chat, nextChat] },
			selectedChatId: chatId,
			selectedChatByProject: { [projectId]: chatId },
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [session, nextSession] },
			selectedSessionId: sessionId,
			selectedSessionByProject: { [projectId]: sessionId },
		});
		rpcClientFactory.mockReturnValue({
			"chat.archive": () =>
				Effect.succeed({ chat: archivedChat, cleanup: null, checkpoint: null }),
			"chat.list": () => Effect.succeed([nextChat]),
			"chat.streamChanges": () => Stream.empty,
			"worktree.list": () => Effect.succeed([]),
		});

		await archiveChatWithConfirm(chatId);

		expect(useChatsStore.getState().selectedChatId).toBe(nextChatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(nextSessionId);
		expect(useArchivePreviewStore.getState().chatsByProject[projectId]).toEqual(
			[archivedChat],
		);
	});

	it("selects the previous live chat when there is no next sibling", async () => {
		const archivedChat = { ...chat, archivedAt: now } as Chat;
		useChatsStore.setState({
			chatsByProject: { [projectId]: [nextChat, chat] },
			selectedChatId: chatId,
			selectedChatByProject: { [projectId]: chatId },
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [nextSession, session] },
			selectedSessionId: sessionId,
			selectedSessionByProject: { [projectId]: sessionId },
		});
		rpcClientFactory.mockReturnValue({
			"chat.archive": () =>
				Effect.succeed({ chat: archivedChat, cleanup: null, checkpoint: null }),
			"chat.list": () => Effect.succeed([nextChat]),
			"chat.streamChanges": () => Stream.empty,
			"worktree.list": () => Effect.succeed([]),
		});

		await useChatsStore.getState().archive(chatId);

		expect(useChatsStore.getState().selectedChatId).toBe(nextChatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(nextSessionId);
	});

	it("returns to the new-chat landing when the project has no live sibling", async () => {
		const archivedChat = { ...chat, archivedAt: now } as Chat;
		useChatsStore.setState({
			chatsByProject: { [projectId]: [chat] },
			selectedChatId: chatId,
			selectedChatByProject: { [projectId]: chatId },
		});
		rpcClientFactory.mockReturnValue({
			"chat.archive": () =>
				Effect.succeed({ chat: archivedChat, cleanup: null, checkpoint: null }),
			"chat.list": () => Effect.succeed([]),
			"chat.streamChanges": () => Stream.empty,
			"worktree.list": () => Effect.succeed([]),
		});

		await useChatsStore.getState().archive(chatId);

		expect(useChatsStore.getState().selectedChatId).toBeNull();
		expect(useSessionsStore.getState().selectedSessionId).toBeNull();
	});
});

describe("chat unarchive", () => {
	beforeEach(() => {
		useArchivePreviewStore.setState(useArchivePreviewStore.getInitialState());
		useArchivePreviewStore.getState().upsertChat({ ...chat, archivedAt: now });
		useChatsStore.setState({
			chatsByProject: { [projectId]: [] },
			selectedChatId: null,
			selectedChatByProject: { [projectId]: null },
			error: null,
		});
		useSessionsStore.setState({
			sessionsByProject: { [projectId]: [] },
			selectedSessionId: null,
			selectedSessionByProject: { [projectId]: null },
		});
	});

	it("deduplicates restore clicks and returns the exact restored chat", async () => {
		const restore = deferred<{
			chat: Chat;
			sessions: ReadonlyArray<Session>;
			worktree: null;
		}>();
		const unarchive = vi.fn(() => Effect.tryPromise(() => restore.promise));
		rpcClientFactory.mockReturnValue({ "chat.unarchive": unarchive });

		const first = useChatsStore.getState().unarchive(chatId);
		const second = useChatsStore.getState().unarchive(chatId);

		await vi.waitFor(() => expect(unarchive).toHaveBeenCalledTimes(1));
		expect(useArchivePreviewStore.getState().restoringByChat[chatId]).toBe(
			true,
		);
		restore.resolve({ chat, sessions: [session], worktree: null });

		await expect(first).resolves.toMatchObject({ ok: true, chat });
		await expect(second).resolves.toMatchObject({ ok: true, chat });
		expect(useChatsStore.getState().selectedChatId).toBe(chatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(sessionId);
		expect(useArchivePreviewStore.getState().chatsByProject[projectId]).toEqual(
			[],
		);
		expect(useUiStore.getState().activeMainTab).toBe("chat");
	});

	it("keeps the archived chat available when restore fails", async () => {
		rpcClientFactory.mockReturnValue({
			"chat.unarchive": () => Effect.fail(new Error("Path already exists")),
		});

		const result = await useChatsStore.getState().unarchive(chatId);

		expect(result).toEqual({ ok: false, reason: "Path already exists" });
		expect(
			useArchivePreviewStore.getState().chatsByProject[projectId],
		).toHaveLength(1);
		expect(useArchivePreviewStore.getState().restoreErrorByChat[chatId]).toBe(
			"Path already exists",
		);
	});
});
