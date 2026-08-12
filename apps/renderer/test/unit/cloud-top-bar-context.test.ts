import { AgentSessionId, ChatId, CloudChatSummary } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { cloudTopBarContext } from "../../src/lib/cloud-top-bar-context.ts";

describe("cloud top-bar context", () => {
	test("projects the cached repository name, owner, and branch", () => {
		const summary = CloudChatSummary.make({
			workspaceId: "workspace-cloud",
			projectId: "project-cloud",
			repositoryIdentity: "github.com/example/repository",
			repositoryDisplayName: "repository",
			chatId: ChatId.make("chat-cloud"),
			initialSessionId: AgentSessionId.make("session-cloud"),
			title: "Cloud chat",
			branch: "zuse/task-branch",
			providerId: "provider-cloud",
			agent: "codex",
			model: "gpt-5.6",
			state: "paused",
			desiredState: "paused",
			runtimeState: "offline",
			statusCode: "paused",
			startupPhase: "running",
			revision: 7,
			unread: false,
			lastMessageAt: 100,
			createdAt: 1,
			updatedAt: 100,
		});

		expect(cloudTopBarContext(summary)).toEqual({
			repositoryLabel: "repository",
			owner: "example",
			branch: "zuse/task-branch",
		});
	});
});
