import { cloudSessionPlaceholder } from "@zuse/client-runtime/cloud-catalog";
import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import {
	Chat,
	ChatId,
	CloudChatSummary,
	CloudProject,
	CloudWorkspaceOpError,
	EnvironmentId,
	Folder,
	FolderId,
	QueueState,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	list: vi.fn(),
	watch: vi.fn(),
	resume: vi.fn(),
	connect: vi.fn(),
	checkpoint: vi.fn(),
	page: vi.fn(),
	activation: vi.fn(),
	releaseCheckpoint: vi.fn(),
	releasePage: vi.fn(),
	releaseActivation: vi.fn(),
	transcript: vi.fn(),
	decodeCheckpoint: vi.fn(),
}));
vi.mock("@zuse/client-runtime/cloud-transcript", async (original) => ({
	...(await original<typeof import("@zuse/client-runtime/cloud-transcript")>()),
	openCloudTranscriptCheckpoint: mocks.decodeCheckpoint,
}));
vi.mock("../../src/lib/rpc-client.ts", async (original) => ({
	...(await original<typeof import("../../src/lib/rpc-client.ts")>()),
	getControlPlaneRpcClient: async () => ({
		"cloud.chats.list": mocks.list,
		"cloud.chats.watch": mocks.watch,
		"cloud.workspaces.get": mocks.get,
		"cloud.workspaces.resume": mocks.resume,
		"cloud.workspaces.connect": mocks.connect,
		"cloud.transcript.get": mocks.transcript,
	}),
}));
vi.mock("../../src/lib/session-timeline-client-bus.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-client-bus.ts")
	>()),
	registerSessionTimelineCheckpointSynchronizer: mocks.checkpoint,
	registerSessionTimelineOlderPageSynchronizer: mocks.page,
	registerEnvironmentActivation: mocks.activation,
}));

import { useCloudChatCatalogStore } from "../../src/lib/cloud-workspace-catalog.ts";
import {
	ensureCloudWorkspaceAttached,
	openCloudChat,
	stageCloudChat,
	useCloudChatsStore,
	watchCloudChatCatalog,
} from "../../src/lib/cloud-workspaces.ts";
import { environmentShellResourceKey } from "../../src/lib/environment-shell-client-bus.ts";
import { seedHostedProjects } from "../../src/lib/hosted-workspace.ts";
import { useOrganizationWorkspaces } from "../../src/lib/organization-workspaces.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
import { getRendererClientBus } from "../../src/lib/session-timeline-client-bus.ts";
import { useChatsStore } from "../../src/store/chats.ts";
import { useSessionsStore } from "../../src/store/sessions.ts";
import { useWorkspaceStore } from "../../src/store/workspace.ts";

const summary = CloudChatSummary.make({
	workspaceId: "attachment-account",
	projectId: "project",
	repositoryIdentity: "github.com/example/repo",
	repositoryDisplayName: "repo",
	chatId: ChatId.make("chat"),
	initialSessionId: SessionId.make("session"),
	activeSessionId: null,
	title: "Cloud chat",
	branch: "cloud",
	providerId: "codex",
	agent: "codex",
	model: "test",
	state: "ready",
	desiredState: "ready",
	runtimeState: "online",
	statusCode: "agent-running",
	startupPhase: "running",
	revision: 1,
	summaryRevision: 1,
	sessionHeadVersion: 0,
	unread: false,
	lastMessageAt: 1,
	createdAt: 1,
	updatedAt: 1,
});

beforeEach(() => {
	observeRendererAccount(null);
	mocks.list.mockReset().mockReturnValue(Effect.succeed({ chats: [] }));
	mocks.watch.mockReset().mockReturnValue(Stream.never);
	mocks.get.mockReset();
	mocks.resume.mockReset();
	mocks.connect.mockReset();
	mocks.checkpoint.mockReset().mockReturnValue(mocks.releaseCheckpoint);
	mocks.page.mockReset().mockReturnValue(mocks.releasePage);
	mocks.activation.mockReset().mockReturnValue(mocks.releaseActivation);
	mocks.releaseCheckpoint.mockClear();
	mocks.releasePage.mockClear();
	mocks.releaseActivation.mockClear();
	mocks.transcript.mockReset();
	mocks.decodeCheckpoint.mockReset();
});

it("removes cached catalog entries on an authoritative denial, but not a service outage", async () => {
	observeRendererAccount("catalog-reader");
	await useCloudChatsStore.getState().hydrate();
	useCloudChatCatalogStore.setState({ summaries: [summary] });
	mocks.list.mockReturnValueOnce(
		Effect.fail(new CloudWorkspaceOpError({ code: "provider-unavailable" })),
	);
	await useCloudChatsStore.getState().hydrate();
	expect(useCloudChatCatalogStore.getState().summaries).toHaveLength(1);
	mocks.list.mockReturnValueOnce(
		Effect.fail(new CloudWorkspaceOpError({ code: "not-allowed" })),
	);
	await useCloudChatsStore.getState().hydrate();
	expect(useCloudChatCatalogStore.getState().summaries).toEqual([]);
});

it("does not start catalog requests for a billing-only organization", async () => {
	observeRendererAccount("finance-reader");
	useOrganizationWorkspaces.setState({
		organizations: [{ id: "finance-org", name: "Finance", role: "billing" }],
	});
	selectRendererWorkspace({
		kind: "organization",
		organizationId: "finance-org",
	});
	await useCloudChatsStore.getState().hydrate();
	mocks.list.mockClear();
	const stop = watchCloudChatCatalog();
	try {
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.watch).not.toHaveBeenCalled();
	} finally {
		stop();
	}
});

it.each([
	"not-allowed",
	"access-denied",
] as const)("stops catalog retries and removes entries for %s", async (code) => {
	observeRendererAccount("catalog-revoked");
	await useCloudChatsStore.getState().hydrate();
	mocks.list.mockReturnValue(Effect.succeed({ chats: [summary] }));
	mocks.watch.mockReturnValue(Stream.fail(new CloudWorkspaceOpError({ code })));
	const stop = watchCloudChatCatalog();
	try {
		await vi.waitFor(() => expect(mocks.watch).toHaveBeenCalledOnce());
		await vi.waitFor(() =>
			expect(useCloudChatCatalogStore.getState().summaries).toEqual([]),
		);
		expect(useCloudChatsStore.getState().error).not.toBeNull();
	} finally {
		stop();
	}
});

it("does not let a late catalog denial clear a newly selected workspace", async () => {
	observeRendererAccount("catalog-switch");
	await useCloudChatsStore.getState().hydrate();
	const denial = Promise.withResolvers<void>();
	mocks.watch.mockReturnValue(
		Stream.fromEffect(
			Effect.promise(() => denial.promise).pipe(
				Effect.flatMap(() =>
					Effect.fail(new CloudWorkspaceOpError({ code: "not-allowed" })),
				),
			),
		),
	);
	const stop = watchCloudChatCatalog();
	try {
		await vi.waitFor(() => expect(mocks.watch).toHaveBeenCalledOnce());
		selectRendererWorkspace({
			kind: "organization",
			organizationId: "next-org",
		});
		await useCloudChatsStore.getState().hydrate();
		const next = {
			...summary,
			workspaceScope: {
				kind: "organization" as const,
				organizationId: "next-org",
			},
		};
		useCloudChatCatalogStore.setState({ summaries: [next] });
		denial.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(useCloudChatCatalogStore.getState().summaries).toEqual([next]);
	} finally {
		stop();
	}
});

it.each([
	false,
	true,
])("hydrates cold context without waking compute and preserves a newer shell (live race: %s)", async (liveRace) => {
	observeRendererAccount("first");
	const cloud = {
		...summary,
		workspaceId: `cold-context-${liveRace}`,
		state: "paused" as const,
	};
	await openCloudChat(cloud);
	const synchronize = mocks.checkpoint.mock.calls[0]?.[1];
	const ref = {
		environmentId: EnvironmentId.make(cloud.workspaceId),
		sessionId: cloud.initialSessionId,
	};
	const folder = Folder.make({
		id: FolderId.make("runtime-folder"),
		name: "checkpoint",
		path: "/workspace/repo",
		addedAt: new Date(0),
	});
	const session = cloudSessionPlaceholder(cloud, folder.id);
	const chat = Chat.make({
		...session,
		id: cloud.chatId,
		activeSessionId: session.id,
		originSessionId: null,
		lastMessageAt: null,
		lastReadAt: null,
	});
	const projection = SessionTimelineProjection.make({
		messages: [],
		status: "idle",
		currentTurn: null,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: "default",
		runtimeMode: "approval-required",
	});
	let release = () => {};
	mocks.transcript.mockReturnValue(Effect.succeed({ checkpoint: {} }));
	mocks.decodeCheckpoint.mockImplementation(
		() =>
			new Promise((resolve) => {
				release = () =>
					resolve({
						context: { folder, chat, session },
						cursor: { epoch: "epoch", version: 1 },
						projection,
					});
			}),
	);
	const pending = synchronize(
		ref,
		emptyResourceView<SessionTimelineProjection>(),
	);
	await vi.waitFor(() => expect(mocks.decodeCheckpoint).toHaveBeenCalledOnce());
	const key = environmentShellResourceKey({ environmentId: ref.environmentId });
	if (liveRace)
		getRendererClientBus().overlay(key, {
			initialData: {
				folders: [{ ...folder, name: "live" }],
				originsByFolder: {},
				chatsByProject: {},
				sessionsByProject: {},
				creationOperationsByProject: {},
			},
			update: (data) => data,
		});
	release();
	await pending;
	expect(getRendererClientBus().snapshot(key).data?.folders[0]?.name).toBe(
		liveRace ? "live" : "checkpoint",
	);
	expect(mocks.get).not.toHaveBeenCalled();
	expect(mocks.resume).not.toHaveBeenCalled();
	expect(mocks.connect).not.toHaveBeenCalled();
});

it("selects an organization cloud chat without a local checkout or fabricated folder mapping", async () => {
	observeRendererAccount("first");
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	useWorkspaceStore.setState({
		selectedFolderId: FolderId.make("personal-checkout"),
		folders: [],
	});
	const cloud = {
		...summary,
		workspaceScope: { kind: "organization" as const, organizationId: "org_a" },
	};
	await openCloudChat(cloud);
	expect(useChatsStore.getState().selectedChatId).toBe(summary.chatId);
	expect(useWorkspaceStore.getState().selectedFolderId).toBeNull();
	expect(useWorkspaceStore.getState().folders).toEqual([]);
	expect(
		useCloudChatCatalogStore.getState().localProjectByEnvironment[
			summary.workspaceId
		],
	).toBeUndefined();
	expect(mocks.activation).toHaveBeenCalledOnce();
	expect(mocks.resume).not.toHaveBeenCalled();
});

it("releases account-owned resolver callbacks and registers fresh ones after switching", () => {
	observeRendererAccount("first");
	stageCloudChat(summary, FolderId.make("project"));
	expect(mocks.activation).toHaveBeenCalledOnce();
	observeRendererAccount("first");
	expect(mocks.releaseActivation).not.toHaveBeenCalled();
	observeRendererAccount("second");
	expect(mocks.releaseCheckpoint).toHaveBeenCalledOnce();
	expect(mocks.releasePage).toHaveBeenCalledOnce();
	expect(mocks.releaseActivation).toHaveBeenCalledOnce();
	stageCloudChat(summary, FolderId.make("project"));
	expect(mocks.activation).toHaveBeenCalledTimes(2);
});

it("discards delayed transcript results and rejects old activation callbacks", async () => {
	observeRendererAccount("first");
	stageCloudChat(summary, FolderId.make("project"));
	const checkpoint = mocks.checkpoint.mock.calls[0]?.[1];
	const activate = mocks.activation.mock.calls[0]?.[1];
	let resolve!: (value: unknown) => void;
	const result = new Promise<unknown>((done) => {
		resolve = done;
	});
	mocks.transcript.mockImplementation(() => Effect.promise(() => result));
	const pending = checkpoint(
		{ sessionId: summary.initialSessionId },
		{ origin: "cache", cursor: null },
	);
	await vi.waitFor(() => expect(mocks.transcript).toHaveBeenCalledOnce());
	observeRendererAccount("second");
	observeRendererAccount("first");
	resolve({ checkpoint: { stale: true } });
	expect(await pending).toBeNull();
	await expect(activate("wake")).rejects.toThrow("connection account changed");
	expect(mocks.get).not.toHaveBeenCalled();
});

it("does not select a queued cloud chat after the initiating account signs out", async () => {
	observeRendererAccount("first");
	const pending = openCloudChat(summary, FolderId.make("project"));
	const rejected = expect(pending).rejects.toThrow(
		"connection account changed",
	);
	observeRendererAccount(null);
	await rejected;
	expect(useCloudChatCatalogStore.getState().summaries).toEqual([]);
	expect(mocks.activation).not.toHaveBeenCalled();
});

it("does not select a queued chat after switching workspaces, even when switching back", async () => {
	observeRendererAccount("first");
	const pending = openCloudChat(summary, FolderId.make("project"));
	const rejected = expect(pending).rejects.toThrow("workspace changed");
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	selectRendererWorkspace({ kind: "personal" });
	await rejected;
	expect(useCloudChatCatalogStore.getState().summaries).toEqual([]);
	expect(mocks.activation).not.toHaveBeenCalled();
});

it("rejects opening a chat belonging to another workspace", async () => {
	observeRendererAccount("first");
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	for (const workspaceScope of [
		undefined,
		{ kind: "organization" as const, organizationId: "org_b" },
	]) {
		await expect(
			openCloudChat({ ...summary, workspaceScope }, FolderId.make("project")),
		).rejects.toThrow("Select the chat's workspace");
	}
	expect(useCloudChatCatalogStore.getState().summaries).toEqual([]);
	expect(mocks.activation).not.toHaveBeenCalled();
});

it("does not stage a rejected cross-workspace catalog row into the chat UI", () => {
	observeRendererAccount("first");
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	stageCloudChat(summary, FolderId.make("project"));
	expect(useCloudChatCatalogStore.getState().summaries).toEqual([]);
	expect(mocks.activation).not.toHaveBeenCalled();
	expect(mocks.checkpoint).not.toHaveBeenCalled();
});

it("does not reuse an earlier account attachment or publish its delayed result", async () => {
	let resolve!: (value: unknown) => void;
	const pending = new Promise<unknown>((done) => {
		resolve = done;
	});
	mocks.get.mockImplementationOnce(() => Effect.promise(() => pending));
	observeRendererAccount("first");
	const first = ensureCloudWorkspaceAttached(summary, "connect");
	const rejected = expect(first).rejects.toThrow("connection account changed");
	await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
	observeRendererAccount("second");
	observeRendererAccount("first");
	mocks.get.mockImplementationOnce(() =>
		Effect.fail(new Error("new account lookup")),
	);
	await expect(
		ensureCloudWorkspaceAttached(summary, "connect"),
	).rejects.toThrow("new account lookup");
	resolve({ state: "paused" });
	await rejected;
	expect(mocks.get).toHaveBeenCalledTimes(2);
	expect(mocks.resume).not.toHaveBeenCalled();
	expect(mocks.connect).not.toHaveBeenCalled();
	expect(useCloudChatCatalogStore.getState().summaries).toEqual([]);
});

it("does not escalate an old passive attachment into a wake after sign-out", async () => {
	let resolve!: (value: unknown) => void;
	const pending = new Promise<unknown>((done) => {
		resolve = done;
	});
	mocks.get.mockImplementation(() => Effect.promise(() => pending));
	observeRendererAccount("first");
	const passive = ensureCloudWorkspaceAttached(summary, "connect");
	const passiveRejected = expect(passive).rejects.toThrow(
		"connection account changed",
	);
	await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
	const wake = ensureCloudWorkspaceAttached(summary, "wake");
	const wakeRejected = expect(wake).rejects.toThrow(
		"connection account changed",
	);
	observeRendererAccount(null);
	resolve({ state: "paused" });
	await passiveRejected;
	await wakeRejected;
	expect(mocks.get).toHaveBeenCalledOnce();
	expect(mocks.resume).not.toHaveBeenCalled();
});

it("keeps an unbound workspace link selected while hosted projects load", async () => {
	observeRendererAccount("linked-chat-owner");
	useWorkspaceStore.setState({ selectedFolderId: null });
	const linked = { ...summary, activeSessionId: summary.initialSessionId };
	await openCloudChat(linked);
	seedHostedProjects([
		CloudProject.make({
			projectId: "unrelated-project",
			repositoryIdentity: "github.com/example/other",
			repositoryUrl: "https://github.com/example/other",
			displayName: "other",
			defaultBranch: "main",
			visibility: "private",
			state: "ready",
			activeBuilds: {},
			latestBuilds: {},
			createdAt: 1,
			updatedAt: 1,
		}),
	]);
	expect(useChatsStore.getState().selectedChatId).toBe(summary.chatId);
	expect(useSessionsStore.getState().selectedSessionId).toBe(
		summary.initialSessionId,
	);
	expect(useWorkspaceStore.getState().selectedFolderId).toBeNull();
});
