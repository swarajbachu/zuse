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
import { describe, expect, test, vi } from "vitest";
import { deriveCloudChatActivity } from "../../src/lib/cloud-chat-activity.ts";
import { cloudChatRowPresentation } from "../../src/lib/cloud-chat-row-presentation.ts";
import { cloudConnectionPresentation } from "../../src/lib/cloud-connection-presentation.ts";
import { canReuseCloudWorkspaceTicket } from "../../src/lib/rpc-client.ts";
import {
	setCloudAttachmentState,
	useCloudExecutionStore,
} from "../../src/store/cloud-chat-registry.ts";
import {
	attachCloudTranscriptLive,
	canReuseCloudWorkspaceAttachment,
	cloudWorkspaceNeedsResume,
	commandStateFromCloudHistory,
	mergeCloudChatMessages,
	mergeCloudChatSummaries,
	mergeCloudCommandProjection,
	selectLatestCloudCommand,
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
	test("a stale command response cannot regress a newer message", () => {
		const newer = {
			clientMessageId: "message-2",
			state: "queued" as const,
			createdAt: 20,
		};
		expect(
			mergeCloudCommandProjection(newer, {
				clientMessageId: "message-1",
				state: "acknowledged",
				createdAt: 10,
			}),
		).toEqual(newer);
		expect(
			mergeCloudCommandProjection(newer, {
				...newer,
				state: "acknowledged",
			}),
		).toMatchObject({ state: "acknowledged" });
	});

	test("durable command sequence orders same-millisecond messages", () => {
		const newer = {
			clientMessageId: "message-newer",
			state: "queued" as const,
			createdAt: 20,
			sequence: 12,
		};
		expect(
			mergeCloudCommandProjection(newer, {
				clientMessageId: "message-older",
				state: "acknowledged",
				createdAt: 20,
				sequence: 11,
			}),
		).toEqual(newer);
		expect(
			mergeCloudCommandProjection(
				{ ...newer, state: "acknowledged" },
				{ ...newer, state: "failed" },
			),
		).toMatchObject({ state: "acknowledged" });
	});

	test("an unresolved concurrent send stays visible across reversed responses", () => {
		const first = {
			clientMessageId: "message-a",
			state: "queued" as const,
			createdAt: 1,
		};
		const second = {
			clientMessageId: "message-b",
			state: "queued" as const,
			createdAt: 2,
		};
		expect(
			selectLatestCloudCommand([{ ...first, sequence: 2 }, second]),
		).toEqual(second);
		expect(
			selectLatestCloudCommand([
				{ ...first, sequence: 2 },
				{ ...second, sequence: 1 },
			]),
		).toMatchObject({ clientMessageId: "message-a", sequence: 2 });
	});

	test("an unaccepted failure cannot replace a later durable command", () => {
		expect(
			selectLatestCloudCommand([
				{
					clientMessageId: "message-failed",
					state: "failed",
					createdAt: 1,
				},
				{
					clientMessageId: "message-durable",
					state: "queued",
					createdAt: 2,
					sequence: 1,
				},
			]),
		).toMatchObject({ clientMessageId: "message-durable", sequence: 1 });
	});

	test("a paused follow-up progresses from resume to attach without claiming Codex started", () => {
		const paused = CloudChatSummary.make({
			...summary({ revision: 12, startupPhase: "running" }),
			state: "paused",
			runtimeState: "offline",
		});
		expect(
			deriveCloudChatActivity({
				summary: paused,
				attachment: "attaching",
				runtime: "idle",
				command: "queued",
			}),
		).toBe("resuming");

		const online = summary({ revision: 13, startupPhase: "running" });
		expect(
			deriveCloudChatActivity({
				summary: online,
				attachment: "attaching",
				runtime: "idle",
				command: "queued",
			}),
		).toBe("attaching");
		expect(
			deriveCloudChatActivity({
				summary: online,
				attachment: "ready",
				runtime: "running",
				command: "acknowledged",
			}),
		).toBe("running");
	});

	test("paused compute with a pending command outranks a stale running timeline", () => {
		const paused = CloudChatSummary.make({
			...summary({ revision: 12, startupPhase: "running" }),
			state: "paused",
			runtimeState: "offline",
		});
		expect(
			deriveCloudChatActivity({
				summary: paused,
				attachment: "attaching",
				runtime: "running",
				command: "queued",
			}),
		).toBe("resuming");
	});

	test("paused compute is static even when the cached timeline was running", () => {
		const paused = CloudChatSummary.make({
			...summary({ revision: 12, startupPhase: "running" }),
			state: "paused",
			runtimeState: "offline",
		});
		for (const command of [null, "acknowledged"] as const) {
			expect(
				deriveCloudChatActivity({
					summary: paused,
					attachment: "detached",
					runtime: "running",
					command,
				}),
			).toBe("paused");
		}
	});

	test("paused compute overrides a stale failed timeline", () => {
		const paused = CloudChatSummary.make({
			...summary({ revision: 12, startupPhase: "running" }),
			state: "paused",
			runtimeState: "offline",
		});
		for (const command of [null, "acknowledged"] as const) {
			expect(
				deriveCloudChatActivity({
					summary: paused,
					attachment: "detached",
					runtime: "failed",
					command,
				}),
			).toBe("paused");
		}
	});

	test("a newer online revision immediately clears stale resume presentation", () => {
		expect(
			deriveCloudChatActivity({
				summary: summary({ revision: 14, startupPhase: "running" }),
				attachment: "ready",
				runtime: "idle",
				command: "acknowledged",
			}),
		).toBe("idle");
	});

	test("an acknowledged initial command cannot leave a stale startup loader", () => {
		expect(
			deriveCloudChatActivity({
				summary: summary({ revision: 14, startupPhase: "starting-agent" }),
				attachment: "ready",
				runtime: "idle",
				command: "acknowledged",
			}),
		).toBe("idle");
	});

	test("follow-up session startup is working, not initial Codex startup", () => {
		expect(
			deriveCloudChatActivity({
				summary: summary({ revision: 15, startupPhase: "running" }),
				attachment: "ready",
				runtime: "starting",
				command: "acknowledged",
			}),
		).toBe("running");
	});

	test("sidebar reflects the current turn instead of only the sandbox lifecycle", () => {
		const active = summary({ revision: 12, startupPhase: "running" });
		expect(cloudChatRowPresentation(active, "starting-agent")).toEqual({
			label: "Working",
			busy: true,
		});
		expect(cloudChatRowPresentation(active, "running")).toEqual({
			label: "Working",
			busy: true,
		});
		expect(cloudChatRowPresentation(active, "idle")).toEqual({
			label: "Active",
			busy: false,
		});
	});

	test("a queued turn on paused compute is presented as resuming", () => {
		const paused = CloudChatSummary.make({
			...summary({ revision: 12, startupPhase: "running" }),
			state: "paused",
			runtimeState: "offline",
		});
		expect(cloudChatRowPresentation(paused, "resuming")).toEqual({
			label: "Resuming",
			busy: true,
		});
	});

	test("an attached online workspace is reused across follow-up messages", () => {
		const active = summary({ revision: 12, startupPhase: "running" });
		expect(
			canReuseCloudWorkspaceAttachment({
				summary: active,
				attachmentState: "ready",
				hasExecutionTarget: true,
			}),
		).toBe(true);
		expect(
			canReuseCloudWorkspaceAttachment({
				summary: active,
				attachmentState: "ready",
				hasExecutionTarget: false,
			}),
		).toBe(false);
	});

	test("a workspace ticket is reused until its final minute", () => {
		const now = 1_000_000;
		const connection = {
			workspaceId: "workspace-cloud",
			wsUrl: "wss://relay.example.test/workspace-cloud",
			protocol: "zuse-workspace-v1",
			credential: "opaque-in-test-only",
			expiresAt: now + 5 * 60_000,
		};
		expect(canReuseCloudWorkspaceTicket(connection, now)).toBe(true);
		expect(
			canReuseCloudWorkspaceTicket(connection, connection.expiresAt - 59_000),
		).toBe(false);
	});

	test("live cloud transcript hydration targets the workspace connection", async () => {
		const hydrate = vi.fn(async () => undefined);
		await attachCloudTranscriptLive(
			{
				initialSessionId: AgentSessionId.make("session-cloud"),
				workspaceId: "workspace-cloud",
			},
			hydrate,
		);
		expect(hydrate).toHaveBeenCalledWith(SessionId.make("session-cloud"), {
			live: true,
			environmentId: "workspace-cloud",
		});
	});

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
		expect(cloudConnectionPresentation(paused, "paused")).toBe("paused");
		expect(cloudConnectionPresentation(paused, "resuming")).toBe("resuming");
		expect(
			cloudConnectionPresentation(
				summary({ revision: 24, startupPhase: "running" }),
				"attaching",
			),
		).toBe("reconnecting");
		expect(
			cloudConnectionPresentation(
				summary({ revision: 25, startupPhase: "running" }),
				"idle",
			),
		).toBe("hidden");
		expect(
			cloudConnectionPresentation(
				summary({ revision: 25, startupPhase: "running" }),
				"queued",
			),
		).toBe("queued");
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
		expect(commandStateFromCloudHistory(history("queued"))).toBe("queued");
		expect(commandStateFromCloudHistory(history("acknowledged"))).toBe(
			"acknowledged",
		);
	});
});
