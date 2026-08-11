import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	FolderId,
	Message,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import {
	mergeCloudChatMessages,
	mergeCloudChatSummaries,
	stageCloudChat,
} from "../../src/store/cloud-chats.ts";
import { useQueueHydrationStore } from "../../src/store/queue-hydration.ts";

const summary = (input: {
	revision: number;
	startupPhase: CloudChatSummary["startupPhase"];
	state?: CloudChatSummary["state"];
	desiredState?: CloudChatSummary["desiredState"];
	statusCode?: string;
}): CloudChatSummary =>
	CloudChatSummary.make({
		workspaceId: "workspace-cloud",
		projectId: "project-cloud",
		repositoryIdentity: "github.com/example/repository",
		repositoryDisplayName: "repository",
		chatId: ChatId.make("chat-cloud"),
		initialSessionId: AgentSessionId.make("session-cloud"),
		title: "Stable title",
		branch: "zuse/cloud",
		providerId: "provider-cloud",
		agent: "codex",
		model: "gpt-5.6",
		state: input.state ?? "ready",
		desiredState: input.desiredState ?? "ready",
		runtimeState: "online",
		statusCode: input.statusCode ?? "agent-running",
		startupPhase: input.startupPhase,
		revision: input.revision,
		unread: false,
		lastMessageAt: 100,
		createdAt: 1,
		updatedAt: input.revision,
	});

describe("cloud chat state reconciliation", () => {
	test("a stale summary cannot move a running chat back to starting", () => {
		const running = summary({ revision: 12, startupPhase: "running" });
		const stale = summary({
			revision: 11,
			startupPhase: "starting-agent",
			statusCode: "agent-starting",
		});

		expect(mergeCloudChatSummaries([running], [stale])).toEqual([running]);
	});

	test("archive intent stays visible until a newer terminal state arrives", () => {
		const archiving = summary({
			revision: 13,
			startupPhase: "running",
			desiredState: "archived",
			statusCode: "archive-queued",
		});
		const staleActive = summary({ revision: 12, startupPhase: "running" });

		expect(mergeCloudChatSummaries([archiving], [staleActive])).toEqual([
			archiving,
		]);
	});

	test("central refresh adds durable events without dropping optimistic messages", () => {
		const sessionId = SessionId.make("session-cloud");
		const optimistic = Message.make({
			id: MessageId.make("optimistic-message"),
			sessionId,
			role: "user",
			content: { _tag: "user", text: "second message" },
			createdAt: new Date(20),
		});
		const durableFirst = Message.make({
			id: MessageId.make("first-message"),
			sessionId,
			role: "user",
			content: { _tag: "user", text: "first message" },
			createdAt: new Date(10),
		});

		expect(
			mergeCloudChatMessages([optimistic], [durableFirst]).map(
				(message) => message.id,
			),
		).toEqual([durableFirst.id, optimistic.id]);
	});

	test("staging a durable cloud chat immediately releases its composer", () => {
		const cloud = summary({ revision: 20, startupPhase: "allocating" });
		stageCloudChat(cloud, FolderId.make("folder-cloud"), "hello");

		expect(
			useQueueHydrationStore.getState().hydratedBySession[
				cloud.initialSessionId
			],
		).toBe(true);
	});
});
