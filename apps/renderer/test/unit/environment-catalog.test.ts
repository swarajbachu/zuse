import { scopedCacheKey } from "@zuse/client-runtime/environment-scope";
import {
	AgentSessionId,
	Chat,
	type ChatCreationOperation,
	ChatId,
	CloudChatSummary,
	Folder,
	FolderId,
	ProviderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

// The coordinator now kicks off chat hydration (which wires the change
// stream) once the target connection reports connected; neither can reach a
// real connection here, so report "connected" immediately and fail the RPC.
vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/lib/rpc-client.ts")>();
	return {
		...original,
		getRpcClient: async () => {
			throw new Error("no rpc in tests");
		},
		subscribeRendererRpcConnection: (
			listener: (snapshot: { status: string }) => void,
		) => {
			listener({ status: "connected" });
			return () => {};
		},
		retryRendererRpcConnection: () => {},
	};
});

import {
	registerCloudChat,
	useCloudChatCatalogStore,
} from "../../src/lib/cloud-workspace-catalog.ts";
import { createInitializationGate } from "../../src/lib/initialization-gate.ts";
import { getRendererClientBus } from "../../src/lib/session-timeline-client-bus.ts";
import { terminalRuntimeKey } from "../../src/lib/terminal-registry.ts";
import {
	restorePendingCreation,
	useChatsStore,
} from "../../src/store/chats.ts";
import {
	cloudConnectionFailure,
	createConnectionAttemptCoordinator,
	type EnvironmentCatalogEntry,
	environmentCatalogViewState,
	loadOptionalEnvironmentSources,
	orderEnvironmentCatalog,
	projectEnvironmentShell,
	validateSshTarget,
} from "../../src/store/environment-catalog.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

const entry = (
	label: string,
	profileId: string | null,
	status: EnvironmentCatalogEntry["status"],
	connectionKind: EnvironmentCatalogEntry["connectionKind"] = profileId === null
		? "local"
		: "ssh",
): EnvironmentCatalogEntry => ({
	connectionKind,
	environmentId: `env-${label}`,
	profileId,
	label,
	target: null,
	descriptor: null,
	status,
	error: null,
});

describe("environment catalog", () => {
	it("never falls back to the chat landing while an optimistic creation is awaiting its first server projection", () => {
		const folderId = FolderId.make("project-optimistic-gap");
		const chatId = ChatId.make("chat-optimistic-gap");
		const sessionId = SessionId.make("session-optimistic-gap");
		const now = new Date("2026-08-21T13:30:00.000Z");
		const pending = restorePendingCreation({
			operationId: "create-optimistic-gap",
			chatId,
			initialSessionId: sessionId,
			projectId: folderId,
			providerId: ProviderId.make("codex"),
			model: "gpt-5.6-sol",
			title: null,
			runtimeMode: "approval-required",
			permissionMode: "default",
			toolSearch: false,
			prompt: "keep me selected",
			startupInput: null,
			startupQueueId: null,
			startupReady: true,
			workspacePolicy: { _tag: "fresh" },
			worktreeId: null,
			phase: "persisted",
			failureStage: null,
			retryable: true,
			attempts: { workspace: 0, setup: 0, provider: 0 },
			setupBypassed: false,
			leaseEpoch: 0,
			fingerprintVersion: 1,
			phaseStartedAt: now,
			error: null,
			createdAt: now,
			updatedAt: now,
		});
		useWorkspaceStore.setState({
			folders: [
				Folder.make({
					id: folderId,
					name: "Project",
					path: "/project",
					addedAt: now,
				}),
			],
			selectedFolderId: folderId,
		});
		useChatsStore.setState({
			selectedChatId: chatId,
			selectedChatByProject: { [folderId]: chatId },
			pendingCreationByChat: { [chatId]: pending.creation },
		});
		useSessionsStore.setState({
			selectedSessionId: sessionId,
			selectedSessionByProject: { [folderId]: sessionId },
		});

		projectEnvironmentShell({
			folders: useWorkspaceStore.getState().folders,
			originsByFolder: {},
			// The chat, session, and creation streams can each publish an empty
			// snapshot before the create command's durable rows become visible.
			chatsByProject: { [folderId]: [] },
			sessionsByProject: { [folderId]: [] },
			creationOperationsByProject: { [folderId]: [] },
		});

		expect(useChatsStore.getState().selectedChatId).toBe(chatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(sessionId);
	});

	it("keeps optimistic creation state when the durable chat arrives before its lifecycle projection", () => {
		const folderId = FolderId.make("project-creation-race");
		const chatId = ChatId.make("chat-creation-race");
		const sessionId = SessionId.make("session-creation-race");
		const now = new Date("2026-08-21T12:07:00.000Z");
		const operation: ChatCreationOperation = {
			operationId: "create-race",
			chatId,
			initialSessionId: sessionId,
			projectId: folderId,
			providerId: ProviderId.make("codex"),
			model: "gpt-5.6-sol",
			title: null,
			runtimeMode: "approval-required",
			permissionMode: "default",
			toolSearch: false,
			prompt: "yo",
			startupInput: null,
			startupQueueId: null,
			startupReady: true,
			workspacePolicy: { _tag: "fresh" },
			worktreeId: null,
			phase: "creating_workspace",
			failureStage: null,
			retryable: true,
			attempts: { workspace: 1, setup: 0, provider: 0 },
			setupBypassed: false,
			leaseEpoch: 0,
			fingerprintVersion: 1,
			phaseStartedAt: now,
			error: null,
			createdAt: now,
			updatedAt: now,
		};
		const pending = restorePendingCreation(operation);
		useChatsStore.setState({
			selectedChatId: chatId,
			selectedChatByProject: { [folderId]: chatId },
			pendingCreationByChat: { [chatId]: pending.creation },
		});
		useSessionsStore.setState({
			selectedSessionId: sessionId,
			selectedSessionByProject: { [folderId]: sessionId },
		});

		projectEnvironmentShell(
			{
				folders: [
					Folder.make({
						id: folderId,
						name: "Project",
						path: "/project",
						addedAt: now,
					}),
				],
				originsByFolder: {},
				chatsByProject: { [folderId]: [pending.chat] },
				sessionsByProject: { [folderId]: [pending.session] },
				// The creation stream is allowed to lag one shell emission behind
				// the chat stream. That must not remount the entire chat surface.
				creationOperationsByProject: { [folderId]: [] },
			},
			{ folderId, chatId },
		);

		expect(useChatsStore.getState().pendingCreationByChat[chatId]?.phase).toBe(
			"creating_workspace",
		);
	});

	it("projects shell data without recursively writing to the ClientBus cell", () => {
		const overlay = vi.spyOn(getRendererClientBus(), "overlay");
		projectEnvironmentShell({
			folders: [],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		});

		expect(overlay).not.toHaveBeenCalled();
		expect(useWorkspaceStore.getState().folders).toEqual([]);
		overlay.mockRestore();
	});

	it("does not clear the landing composer draft on a shell update", () => {
		const sessions = useSessionsStore.getState();
		sessions.beginDraft({
			projectId: FolderId.make("draft-project"),
			providerId: ProviderId.make("codex"),
			model: "gpt-5",
			runtimeMode: "approval-required",
		});

		projectEnvironmentShell({
			folders: [],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		});

		expect(useSessionsStore.getState().draftSession).not.toBeNull();
		useSessionsStore.getState().clearDraft();
	});

	it("preserves a valid optimistic tab selection during shell synchronization", () => {
		const folderId = FolderId.make("project-selection");
		const chatId = ChatId.make("chat-selection");
		const previousSessionId = SessionId.make("session-previous");
		const optimisticSessionId = SessionId.make("session-optimistic");
		const now = new Date("2026-08-14T00:00:00.000Z");
		const makeSession = (id: typeof previousSessionId) =>
			Session.make({
				id,
				projectId: folderId,
				title: id === optimisticSessionId ? "New chat" : "Previous",
				titleProvenance: id === optimisticSessionId ? "pending" : "manual",
				providerId: "codex",
				model: "gpt-5",
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
			});
		useSessionsStore.setState({
			selectedSessionId: optimisticSessionId,
			selectedSessionByProject: { [folderId]: optimisticSessionId },
		});

		projectEnvironmentShell(
			{
				folders: [
					Folder.make({
						id: folderId,
						name: "Project",
						path: "/project",
						addedAt: now,
					}),
				],
				originsByFolder: {},
				chatsByProject: {
					[folderId]: [
						Chat.make({
							id: chatId,
							projectId: folderId,
							title: "Chat",
							titleProvenance: "manual",
							worktreeId: null,
							activeSessionId: previousSessionId,
							originSessionId: null,
							archivedAt: null,
							lastMessageAt: null,
							lastReadAt: now,
							createdAt: now,
							updatedAt: now,
						}),
					],
				},
				sessionsByProject: {
					[folderId]: [
						makeSession(previousSessionId),
						makeSession(optimisticSessionId),
					],
				},
				creationOperationsByProject: {},
			},
			{ folderId, chatId },
		);

		expect(useSessionsStore.getState().selectedSessionId).toBe(
			optimisticSessionId,
		);
	});

	it("keeps a selected cloud chat open while its runtime shell is resuming", () => {
		const folderId = FolderId.make("cloud-project-selection");
		const chatId = ChatId.make("cloud-chat-selection");
		const initialSessionId = AgentSessionId.make("cloud-session-removed");
		const activeSessionId = AgentSessionId.make("cloud-session-selection");
		const now = new Date("2026-08-14T00:00:00.000Z");
		registerCloudChat(
			CloudChatSummary.make({
				workspaceId: "workspace-resuming",
				projectId: "api-project",
				repositoryIdentity: "github.com/zuse/repository",
				repositoryDisplayName: "repository",
				chatId,
				initialSessionId,
				activeSessionId,
				title: "Cloud chat",
				branch: "zuse/cloud",
				providerId: "e2b",
				agent: "codex",
				model: "gpt-5.6",
				state: "resuming",
				desiredState: "ready",
				runtimeState: "connecting",
				statusCode: "resume-runtime-waking",
				startupPhase: "running",
				revision: 2,
				summaryRevision: 1,
				sessionHeadVersion: 4,
				unread: false,
				lastMessageAt: now.getTime(),
				createdAt: now.getTime(),
				updatedAt: now.getTime(),
			}),
			folderId,
		);
		useWorkspaceStore.setState({
			folders: [
				Folder.make({
					id: folderId,
					name: "Cloud project",
					path: "/project",
					addedAt: now,
				}),
			],
			selectedFolderId: folderId,
		});
		useChatsStore.setState({
			selectedChatId: chatId,
			selectedChatByProject: { [folderId]: chatId },
		});
		useSessionsStore.setState({
			selectedSessionId: activeSessionId,
			selectedSessionByProject: { [folderId]: activeSessionId },
		});

		projectEnvironmentShell({
			folders: useWorkspaceStore.getState().folders,
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		});

		expect(useChatsStore.getState().selectedChatId).toBe(chatId);
		expect(useSessionsStore.getState().selectedSessionId).toBe(activeSessionId);
		useCloudChatCatalogStore.setState({
			summaries: [],
			localProjectByEnvironment: {},
		});
	});

	it("shares initialization and retries only after a failed attempt", async () => {
		const gate = createInitializationGate();
		let release: (() => void) | undefined;
		const initialize = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const first = gate(false, initialize);
		const second = gate(false, initialize);
		expect(second).toBe(first);
		expect(initialize).toHaveBeenCalledOnce();
		release?.();
		await first;

		const failure = new Error("failed");
		await expect(gate(false, async () => Promise.reject(failure))).rejects.toBe(
			failure,
		);
		const retry = vi.fn(async () => undefined);
		await gate(false, retry);
		expect(retry).toHaveBeenCalledOnce();
	});

	it("orders local, connected, then offline saved computers", () => {
		expect(
			orderEnvironmentCatalog([
				entry("Offline", "offline", "offline"),
				entry("Local", null, "connected"),
				entry("API", null, "connected", "api"),
				entry("Remote", "remote", "connected"),
			]).map(({ label }) => label),
		).toEqual(["Local", "API", "Remote", "Offline"]);
	});

	it("isolates optional computer discovery failures", async () => {
		const sources = await loadOptionalEnvironmentSources({
			sshProfiles: Promise.reject(new Error("corrupt SSH profiles")),
			tailnetProfiles: Promise.resolve([]),
			apiEnvironments: Promise.reject(new Error("account unavailable")),
		});

		expect(sources).toEqual({
			profiles: [],
			tailnetProfiles: [],
			apiEnvironments: [],
			apiError: "account unavailable",
		});
	});

	it("never presents initialization failures as an empty project catalog", () => {
		expect(
			environmentCatalogViewState({
				initialized: false,
				initializing: false,
				initializationError: "Local connection failed",
				projectCount: 0,
				projectsLoading: false,
			}),
		).toBe("unavailable");
		expect(
			environmentCatalogViewState({
				initialized: false,
				initializing: true,
				initializationError: null,
				projectCount: 0,
				projectsLoading: false,
			}),
		).toBe("loading");
		expect(
			environmentCatalogViewState({
				initialized: true,
				initializing: false,
				initializationError: null,
				projectCount: 0,
				projectsLoading: false,
			}),
		).toBe("empty");
	});

	it("replaces an in-flight connection attempt that never became ready", async () => {
		const coordinator = createConnectionAttemptCoordinator();
		let releaseFirst: (() => void) | undefined;
		let firstStillCurrent = true;
		const first = coordinator.run("api:cloud", (isCurrent) =>
			new Promise<void>((resolve) => {
				releaseFirst = resolve;
			}).then(() => {
				firstStillCurrent = isCurrent();
			}),
		);
		const replacement = coordinator.run(
			"api:cloud",
			async (isCurrent) => {
				expect(isCurrent()).toBe(true);
			},
			true,
		);
		expect(replacement).not.toBe(first);
		await replacement;
		releaseFirst?.();
		await first;
		expect(firstStillCurrent).toBe(false);
	});

	it("reports the failed secure-connection phase", () => {
		expect(cloudConnectionFailure(new Error("open timed out")).message).toMatch(
			/^Endpoint reachability failed:/u,
		);
		expect(
			cloudConnectionFailure(new Error("unexpected response")).message,
		).toMatch(/^WebSocket upgrade failed:/u);
		expect(
			cloudConnectionFailure(new Error("wire version mismatch")).message,
		).toMatch(/^Protocol handshake failed:/u);
	});

	it("validates manual hosts and ports", () => {
		expect(
			validateSshTarget({
				alias: "",
				hostname: "",
				username: null,
				port: null,
			}),
		).toMatch(/host name/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 70_000,
			}),
		).toMatch(/65535/u);
		expect(
			validateSshTarget({
				alias: "host",
				hostname: "host",
				username: null,
				port: 22,
			}),
		).toBeNull();
	});

	it("keeps colliding server IDs distinct across environments", () => {
		expect(scopedCacheKey("env-a", "chat", "same-id")).not.toBe(
			scopedCacheKey("env-b", "chat", "same-id"),
		);
	});

	it("keeps colliding terminal runtime IDs distinct across environments", () => {
		expect(terminalRuntimeKey("env-a", "terminal-1")).not.toBe(
			terminalRuntimeKey("env-b", "terminal-1"),
		);
	});
});
