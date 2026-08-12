import {
	AgentSessionId,
	ChatId,
	CloudChatHistory,
	CloudChatSummary,
	FolderId,
	Message,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { cloudConnectionPresentation } from "../../src/lib/cloud-connection-presentation.ts";
import {
	setCloudAttachmentState,
	useCloudExecutionStore,
} from "../../src/store/cloud-chat-registry.ts";
import {
	cloudWorkspaceNeedsResume,
	mergeCloudChatMessages,
	mergeCloudChatSummaries,
	shouldAttachCloudChatOnOpen,
	shouldAttachCloudChatWithPendingCommands,
	shouldRetryCloudWorkspaceAttachment,
	shouldUseLocalMessageQueue,
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

	test("equal revisions preserve monotonic unread and message ordering fields", () => {
		const current = CloudChatSummary.make({
			...summary({ revision: 12, startupPhase: "running" }),
			unread: true,
			lastMessageAt: 200,
		});
		const staleProjection = CloudChatSummary.make({
			...current,
			unread: false,
			lastMessageAt: 100,
		});
		expect(mergeCloudChatSummaries([current], [staleProjection])).toEqual([
			current,
		]);
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

	test("opening attaches only an already-running cloud chat", () => {
		expect(
			shouldAttachCloudChatOnOpen(
				summary({ revision: 21, startupPhase: "running" }),
			),
		).toBe(true);
		expect(
			shouldAttachCloudChatOnOpen(
				CloudChatSummary.make({
					...summary({ revision: 22, startupPhase: "running" }),
					state: "paused",
					desiredState: "paused",
					runtimeState: "offline",
				}),
			),
		).toBe(false);
	});

	test("connection presentation follows compute before RPC attachment", () => {
		const paused = CloudChatSummary.make({
			...summary({ revision: 23, startupPhase: "running" }),
			state: "paused",
			desiredState: "paused",
			runtimeState: "offline",
		});
		expect(cloudConnectionPresentation(paused, "detached")).toBe("paused");
		expect(cloudConnectionPresentation(paused, "attaching")).toBe("resuming");
		expect(
			cloudConnectionPresentation(
				summary({ revision: 24, startupPhase: "running" }),
				"attaching",
			),
		).toBe("reconnecting");
		expect(
			cloudConnectionPresentation(
				summary({ revision: 25, startupPhase: "running" }),
				"ready",
			),
		).toBe("hidden");
	});

	test("a paused status refresh cannot cancel an attachment already in progress", () => {
		const paused = CloudChatSummary.make({
			...summary({ revision: 26, startupPhase: "running" }),
			workspaceId: "workspace-resuming",
			chatId: ChatId.make("chat-resuming"),
			initialSessionId: AgentSessionId.make("session-resuming"),
			state: "paused",
			desiredState: "ready",
			runtimeState: "offline",
		});
		setCloudAttachmentState(paused.workspaceId, "attaching");

		stageCloudChat(paused, FolderId.make("folder-resuming"));

		expect(
			useCloudExecutionStore.getState().stateByWorkspace[paused.workspaceId],
		).toBe("attaching");
	});

	test("authoritative paused, failed, and interrupted resuming states require resume", () => {
		expect(cloudWorkspaceNeedsResume({ state: "paused" })).toBe(true);
		expect(cloudWorkspaceNeedsResume({ state: "failed" })).toBe(true);
		expect(cloudWorkspaceNeedsResume({ state: "resuming" })).toBe(true);
		expect(cloudWorkspaceNeedsResume({ state: "ready" })).toBe(false);
	});

	test("cloud messages use the durable command queue while a turn is active", () => {
		expect(
			shouldUseLocalMessageQueue({
				queueRequested: true,
				isCloudSession: true,
			}),
		).toBe(false);
		expect(
			shouldUseLocalMessageQueue({
				queueRequested: true,
				isCloudSession: false,
			}),
		).toBe(true);
	});

	test("an attachment retries one failed resume without user intervention", () => {
		expect(
			shouldRetryCloudWorkspaceAttachment({
				state: "failed",
				desiredState: "ready",
				resumeAttempts: 1,
			}),
		).toBe(true);
		expect(
			shouldRetryCloudWorkspaceAttachment({
				state: "failed",
				desiredState: "ready",
				resumeAttempts: 2,
			}),
		).toBe(false);
	});

	test("reopening continues durable queued cloud work without waking an idle chat", () => {
		const history = (state: "queued" | "acknowledged") =>
			CloudChatHistory.make({
				workspaceId: "workspace-cloud",
				chatId: ChatId.make("chat-cloud"),
				initialSessionId: AgentSessionId.make("session-cloud"),
				commandState: "acknowledged",
				events: [],
				queuedMessages: [
					{
						clientMessageId: MessageId.make("message-cloud"),
						input: {
							text: "work",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
							annotations: [],
						},
						state,
						asGoal: false,
						createdAt: Date.now(),
					},
				],
				cursor: 0,
			});

		expect(shouldAttachCloudChatWithPendingCommands(history("queued"))).toBe(
			true,
		);
		expect(
			shouldAttachCloudChatWithPendingCommands(history("acknowledged")),
		).toBe(false);
	});
});
