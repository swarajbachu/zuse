import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	FolderId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { cloudSessionPlaceholder } from "../../src/lib/cloud-workspaces.ts";

describe("cloudSessionPlaceholder", () => {
	it("preserves the launch runtime mode while the live timeline connects", () => {
		const summary = CloudChatSummary.make({
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
			statusCode: "agent-running",
			startupPhase: "running",
			revision: 1,
			summaryRevision: 0,
			sessionHeadVersion: 0,
			unread: false,
			lastMessageAt: 1,
			createdAt: 1,
			updatedAt: 1,
		});

		expect(
			cloudSessionPlaceholder(summary, FolderId.make("folder-1")).runtimeMode,
		).toBe("full-access");
	});
});
