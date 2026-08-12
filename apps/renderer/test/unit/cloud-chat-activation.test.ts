import {
	AgentSessionId,
	ChatId,
	CloudChatHistory,
	CloudChatSummary,
	FolderId,
} from "@zuse/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { cloudFailureMessage } from "../../src/components/worktree-setup-card.tsx";
import { registerCloudChat } from "../../src/store/cloud-chat-registry.ts";
import {
	messagesFromHistory,
	runCloudHistoryPump,
} from "../../src/store/cloud-chats.ts";
import { useTerminalsStore } from "../../src/store/terminals.ts";

const initialTerminalsState = useTerminalsStore.getInitialState();

afterEach(() => useTerminalsStore.setState(initialTerminalsState, true));

describe("cloud chat activation", () => {
	test("projects the durable first message before runtime events exist", () => {
		const history = CloudChatHistory.make({
			workspaceId: "workspace-starting",
			chatId: ChatId.make("chat-starting"),
			initialSessionId: AgentSessionId.make("session-starting"),
			firstMessage: "Please inspect the repository",
			commandState: "queued",
			events: [],
			queuedMessages: [],
			cursor: 0,
		});

		expect(messagesFromHistory(history)).toMatchObject([
			{
				role: "user",
				content: { _tag: "user", text: "Please inspect the repository" },
			},
		]);
	});

	test("projects the latest revision of a streaming cloud message", () => {
		const persisted = (sequence: number, text: string) => ({
			sequence,
			eventId: `event-${sequence}`,
			streamId: "session-streaming",
			streamVersion: sequence,
			type: "MessagePersisted" as const,
			payloadJson: JSON.stringify({
				_tag: "MessagePersisted",
				messageId: "assistant-streaming",
				role: "assistant",
				contentJson: JSON.stringify({ _tag: "assistant", text }),
				createdAt: 100,
			}),
			createdAt: 100 + sequence,
		});
		const history = CloudChatHistory.make({
			workspaceId: "workspace-streaming",
			chatId: ChatId.make("chat-streaming"),
			initialSessionId: AgentSessionId.make("session-streaming"),
			commandState: "acknowledged",
			events: [persisted(1, "partial"), persisted(2, "complete response")],
			queuedMessages: [],
			cursor: 2,
		});

		expect(messagesFromHistory(history)).toMatchObject([
			{ content: { _tag: "assistant", text: "complete response" } },
		]);
	});

	test("continuously applies central cloud events without reopening the chat", async () => {
		const cursors: number[] = [];
		const applied: number[] = [];
		let active = true;
		await runCloudHistoryPump({
			initialCursor: 4,
			isActive: () => active,
			fetchAfter: async (after) => {
				cursors.push(after);
				return CloudChatHistory.make({
					workspaceId: "workspace-live",
					chatId: ChatId.make("chat-live"),
					initialSessionId: AgentSessionId.make("session-live"),
					commandState: "acknowledged",
					events: [],
					queuedMessages: [],
					cursor: 7,
				});
			},
			apply: (history) => {
				applied.push(history.cursor);
				active = false;
			},
			wait: async () => {},
		});

		expect(cursors).toEqual([4]);
		expect(applied).toEqual([7]);
	});

	test("describes actionable cloud failures", () => {
		expect(cloudFailureMessage("runtime-connection-timeout")).toBe(
			"The sandbox started, but its secure runtime did not connect in time.",
		);
		expect(cloudFailureMessage("provider-sandbox-missing")).toContain(
			"restore this workspace in a new sandbox",
		);
	});

	test("pins cloud terminals to the sandbox checkout", () => {
		const summary = CloudChatSummary.make({
			workspaceId: "workspace-cloud",
			projectId: "project-cloud",
			repositoryIdentity: "github.com/example/repository",
			repositoryDisplayName: "repository",
			chatId: ChatId.make("chat-cloud"),
			initialSessionId: AgentSessionId.make("session-cloud"),
			title: "Cloud chat",
			branch: "zuse/cloud",
			providerId: "provider-cloud",
			agent: "codex",
			model: "gpt-5.6",
			state: "paused",
			desiredState: "paused",
			runtimeState: "offline",
			statusCode: "paused",
			startupPhase: "running",
			revision: 1,
			unread: false,
			lastMessageAt: 1,
			createdAt: 1,
			updatedAt: 1,
		});
		registerCloudChat(summary, FolderId.make("folder-local"));
		const terminal = useTerminalsStore
			.getState()
			.ensureSlot(summary.chatId, 0, "/Users/local/repository");
		expect(terminal.environmentId).toBe(summary.workspaceId);
		expect(terminal.cwd).toBe("/home/zuse/workspace");
	});
});
