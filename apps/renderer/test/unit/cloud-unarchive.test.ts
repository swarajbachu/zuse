import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	FolderId,
} from "@zuse/contracts";
import { expect, it, vi } from "vitest";

const { unarchive, stageCloudChat } = vi.hoisted(() => ({
	unarchive: vi.fn(),
	stageCloudChat: vi.fn(),
}));
vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runControlPlane: (run: (client: unknown) => unknown) =>
		run({ "cloud.workspaces.unarchive": unarchive }),
}));
vi.mock("../../src/lib/cloud-workspaces.ts", () => ({
	localProjectForCloudChat: () => FolderId.make("project-a"),
	stageCloudChat,
}));

import {
	cloudSummaryForChat,
	optimisticallyArchiveCloudChat,
	registerCloudChat,
	useCloudChatCatalogStore,
} from "../../src/lib/cloud-workspace-catalog.ts";
import { useChatsStore } from "../../src/store/chats.ts";

it("keeps a failed cloud restore archived while awaiting confirmation", async () => {
	const chatId = ChatId.make("chat-a");
	const archived = CloudChatSummary.make({
		workspaceId: "environment-a",
		projectId: "api-project-a",
		repositoryIdentity: "github.com/zuse/repository",
		repositoryDisplayName: "repository",
		chatId,
		initialSessionId: AgentSessionId.make("session-a"),
		title: "Archived",
		branch: "main",
		providerId: "provider-cloud",
		agent: "codex",
		model: "gpt-5.6",
		state: "archived",
		desiredState: "archived",
		runtimeState: "offline",
		statusCode: "archived",
		startupPhase: "running",
		revision: 2,
		summaryRevision: 0,
		sessionHeadVersion: 0,
		unread: false,
		lastMessageAt: null,
		createdAt: 1,
		updatedAt: 2,
		archivedAt: 2,
	});
	useCloudChatCatalogStore.setState({ summaries: [], archiveIntents: {} });
	registerCloudChat(archived);
	optimisticallyArchiveCloudChat(archived, 2, "archive-command");
	let rejectRequest: (error: Error) => void = () => {};
	unarchive.mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				rejectRequest = reject;
			}),
	);
	const result = useChatsStore.getState().unarchive(chatId);
	await vi.waitFor(() => expect(unarchive).toHaveBeenCalledOnce());
	const pendingSummary = cloudSummaryForChat(chatId);
	rejectRequest(new Error("Restore failed"));
	expect(await result).toEqual({ ok: false, reason: "Restore failed" });
	expect(pendingSummary?.archivedAt).toBe(2);
	expect(cloudSummaryForChat(chatId)?.archivedAt).toBe(2);
	expect(stageCloudChat).not.toHaveBeenCalled();
	expect(
		useCloudChatCatalogStore.getState().archiveIntents["environment-a"],
	).toEqual({ commandId: "archive-command", requestedAt: 2 });
});
