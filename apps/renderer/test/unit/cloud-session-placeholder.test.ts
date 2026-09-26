import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	EnvironmentId,
	FolderId,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	cloudConnectionRearmKey,
	cloudSessionPlaceholder,
	rearmReadyCloudConnection,
	useCloudChatsStore,
	watchCloudChatCatalog,
} from "../../src/lib/cloud-workspaces.ts";
import { seedHostedProjects } from "../../src/lib/hosted-workspace.ts";

const readySummary = (revision = 1) =>
	CloudChatSummary.make({
		workspaceId: "workspace-1",
		projectId: "cloud-project-1",
		repositoryIdentity: "github.com/acme/example",
		repositoryDisplayName: "example",
		chatId: ChatId.make("chat-1"),
		initialSessionId: AgentSessionId.make("session-1"),
		title: "Cloud chat",
		branch: "zuse/cloud-chat",
		providerId: "e2b",
		agent: "codex",
		model: "gpt-5.6",
		runtimeMode: "full-access",
		state: "ready",
		desiredState: "ready",
		runtimeState: "online",
		statusCode: "ready",
		startupPhase: "running",
		revision,
		summaryRevision: 0,
		sessionHeadVersion: 0,
		unread: false,
		lastMessageAt: 1,
		createdAt: 1,
		updatedAt: 1,
	});

describe("cloudSessionPlaceholder", () => {
	it("preserves the launch runtime mode while the live timeline connects", () => {
		const summary = readySummary();

		expect(
			cloudSessionPlaceholder(summary, FolderId.make("folder-1")).runtimeMode,
		).toBe("full-access");
	});

	it("re-arms a failed client when authoritative compute is ready", () => {
		const summary = readySummary(7);
		const failed = {
			environmentId: EnvironmentId.make("workspace-1"),
			phase: "failed" as const,
			generation: 3,
			error: "closed socket",
		};

		expect(cloudConnectionRearmKey(summary, failed)).toBe("workspace-1:7:3");
		expect(
			cloudConnectionRearmKey(summary, {
				...failed,
				phase: "reconnecting",
				error: null,
			}),
		).toBeNull();
		expect(
			cloudConnectionRearmKey(
				CloudChatSummary.make({
					...summary,
					state: "paused",
					runtimeState: "offline",
				}),
				failed,
			),
		).toBeNull();

		const attempts = new Map<string, string>();
		const retry = vi.fn();
		expect(rearmReadyCloudConnection(summary, failed, attempts, retry)).toBe(
			true,
		);
		expect(retry).toHaveBeenCalledWith(EnvironmentId.make("workspace-1"));
		expect(rearmReadyCloudConnection(summary, failed, attempts, retry)).toBe(
			false,
		);
		expect(retry).toHaveBeenCalledTimes(1);
	});
});

const hostedMode = vi.hoisted(() => ({
	enabled: false,
	summaries: [] as unknown[],
}));
vi.mock("../../src/lib/hosted-connect.ts", async (original) => ({
	...(await original<typeof import("../../src/lib/hosted-connect.ts")>()),
	isHostedProduct: () => hostedMode.enabled,
}));
vi.mock("../../src/lib/rpc-client.ts", async (original) => ({
	...(await original<typeof import("../../src/lib/rpc-client.ts")>()),
	getControlPlaneRpcClient: async () => ({
		"cloud.chats.list": () => Effect.succeed({ chats: [] }),
		"cloud.chats.watch": () =>
			Stream.make({
				chats: hostedMode.summaries,
				deletedWorkspaceIds: [],
				cursor: 1,
				reset: false,
			}),
	}),
}));

import { environmentShellSnapshot } from "../../src/lib/environment-shell-client-bus.ts";

it("stages a newly watched hosted chat before any local mapping exists", async () => {
	hostedMode.enabled = true;
	seedHostedProjects([]);
	const summary = CloudChatSummary.make({
		...readySummary(),
		workspaceId: "new-hosted-workspace",
		chatId: ChatId.make("new-hosted-chat"),
		projectId: "new-hosted-project",
	});
	hostedMode.summaries = [summary];
	const stop = watchCloudChatCatalog();
	try {
		await vi.waitFor(() => {
			expect(useCloudChatsStore.getState().error).toBeNull();
			const shell = environmentShellSnapshot({
				environmentId: EnvironmentId.make("local"),
			}).data;
			expect(
				shell?.chatsByProject["cloud-project:new-hosted-project"]?.some(
					(chat) => chat.id === summary.chatId,
				),
			).toBe(true);
		});
	} finally {
		stop();
		hostedMode.enabled = false;
	}
});
