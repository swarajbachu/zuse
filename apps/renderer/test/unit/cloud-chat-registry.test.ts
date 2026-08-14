import {
	AgentSessionId,
	ChatId,
	CloudChatSummary,
	EnvironmentId,
	FolderId,
} from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { deriveCloudChatActivity } from "../../src/lib/cloud-chat-activity.ts";
import { cloudConnectionPresentation } from "../../src/lib/cloud-connection-presentation.ts";
import {
	cloudSummaryForChat,
	cloudSummaryForEnvironment,
	cloudSummaryForSession,
	compareCloudChatSummaryVersion,
	localProjectForCloudChat,
	optimisticallyArchiveCloudChat,
	optimisticallyUnarchiveCloudChat,
	reconcileCloudChatCatalog,
	registerCloudChat,
	useCloudChatCatalogStore,
} from "../../src/lib/cloud-workspace-catalog.ts";

const summary = (input: {
	workspaceId: string;
	chatId: string;
	sessionId: string;
	revision: number;
	summaryRevision?: number;
	sessionHeadVersion?: number;
	title?: string;
	updatedAt?: number;
}) =>
	CloudChatSummary.make({
		workspaceId: input.workspaceId,
		projectId: `relay-${input.workspaceId}`,
		repositoryIdentity: "github.com/zuse/repository",
		repositoryDisplayName: "repository",
		chatId: ChatId.make(input.chatId),
		initialSessionId: AgentSessionId.make(input.sessionId),
		title: input.title ?? input.workspaceId,
		branch: "zuse/realtime",
		providerId: "provider-cloud",
		agent: "codex",
		model: "gpt-5.6",
		state: "ready",
		desiredState: "ready",
		runtimeState: "online",
		statusCode: "ready",
		startupPhase: "running",
		revision: input.revision,
		summaryRevision: input.summaryRevision ?? 0,
		sessionHeadVersion: input.sessionHeadVersion ?? 0,
		unread: false,
		lastMessageAt: input.updatedAt ?? input.revision,
		createdAt: 1,
		updatedAt: input.updatedAt ?? input.revision,
	});

describe("cloud chat catalog", () => {
	beforeEach(() => {
		useCloudChatCatalogStore.setState({
			summaries: [],
			localProjectByEnvironment: {},
			archiveIntents: {},
		});
	});

	it("keeps one monotonic summary per qualified environment", () => {
		const current = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 2,
		});
		const stale = summary({
			workspaceId: "environment-a",
			chatId: "stale-chat-a",
			sessionId: "stale-session-a",
			revision: 1,
		});
		const other = summary({
			workspaceId: "environment-b",
			chatId: "chat-b",
			sessionId: "session-b",
			revision: 1,
		});
		registerCloudChat(current, FolderId.make("local-project-a"));
		registerCloudChat(stale);
		registerCloudChat(other, FolderId.make("local-project-b"));

		expect(useCloudChatCatalogStore.getState().summaries).toHaveLength(2);
		expect(
			cloudSummaryForEnvironment(EnvironmentId.make("environment-a")),
		).toBe(current);
		expect(cloudSummaryForChat("chat-a")).toBe(current);
		expect(cloudSummaryForChat("stale-chat-a")).toBeNull();
		expect(cloudSummaryForSession(current.initialSessionId)).toBe(current);
		expect(localProjectForCloudChat("chat-a")).toBe("local-project-a");
		expect(localProjectForCloudChat("chat-b")).toBe("local-project-b");
	});

	it("derives attachment activity from the shared connection supervisor", () => {
		const row = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 1,
		});

		expect(
			deriveCloudChatActivity({
				summary: row,
				connection: "waking",
				runtime: "idle",
			}),
		).toBe("attaching");
		expect(
			deriveCloudChatActivity({
				summary: row,
				connection: "failed",
				runtime: "idle",
			}),
		).toBe("failed");
		expect(
			deriveCloudChatActivity({
				summary: row,
				connection: "connected",
				runtime: "running",
			}),
		).toBe("running");
		expect(cloudConnectionPresentation(row, "attaching")).toBe("hidden");
	});

	it("accepts newer runtime metadata within one lifecycle revision", () => {
		const old = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 5,
			summaryRevision: 3,
			sessionHeadVersion: 7,
			title: "Old title",
		});
		const current = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 5,
			summaryRevision: 4,
			sessionHeadVersion: 8,
			title: "Runtime title",
		});
		const staleRuntime = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 5,
			summaryRevision: 3,
			sessionHeadVersion: 99,
			title: "Regressing title",
			updatedAt: 999,
		});

		registerCloudChat(old);
		registerCloudChat(current);
		registerCloudChat(staleRuntime);

		expect(compareCloudChatSummaryVersion(current, old)).toBeGreaterThan(0);
		expect(cloudSummaryForEnvironment("environment-a")).toMatchObject({
			title: "Runtime title",
			summaryRevision: 4,
			sessionHeadVersion: 8,
		});
	});

	it("removes deleted workspaces during authoritative reconciliation", () => {
		const retained = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 2,
		});
		const deleted = summary({
			workspaceId: "environment-b",
			chatId: "chat-b",
			sessionId: "session-b",
			revision: 1,
		});
		registerCloudChat(retained, FolderId.make("local-project-a"));
		registerCloudChat(deleted, FolderId.make("local-project-b"));

		const removed = reconcileCloudChatCatalog([
			summary({
				workspaceId: "environment-a",
				chatId: "chat-a",
				sessionId: "session-a",
				revision: 1,
			}),
		]);

		expect(removed).toEqual([deleted]);
		expect(cloudSummaryForEnvironment("environment-a")).toBe(retained);
		expect(cloudSummaryForEnvironment("environment-b")).toBeNull();
		expect(localProjectForCloudChat("chat-b")).toBeNull();
	});

	it("keeps a failed archive intent hidden for durable retry", () => {
		const current = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 2,
		});
		registerCloudChat(current);
		optimisticallyArchiveCloudChat(current, 123, "archive-command");

		expect(cloudSummaryForChat("chat-a")).toMatchObject({
			desiredState: "archived",
			archivedAt: 123,
		});
		expect(useCloudChatCatalogStore.getState().archiveIntents).toEqual({
			"environment-a": {
				commandId: "archive-command",
				requestedAt: 123,
			},
		});
	});

	it("keeps archive intent fenced until the authoritative archived state", () => {
		const current = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 2,
		});
		registerCloudChat(current);
		optimisticallyArchiveCloudChat(current, 123, "archive-command");

		reconcileCloudChatCatalog([{ ...current, revision: 3 }]);
		expect(cloudSummaryForChat("chat-a")).toMatchObject({
			desiredState: "archived",
			archivedAt: 123,
		});
		expect(useCloudChatCatalogStore.getState().archiveIntents).toHaveProperty(
			"environment-a",
		);
		reconcileCloudChatCatalog([
			{
				...current,
				state: "archived",
				desiredState: "archived",
				archivedAt: 100,
				revision: 1,
			},
		]);
		expect(useCloudChatCatalogStore.getState().archiveIntents).toHaveProperty(
			"environment-a",
		);

		reconcileCloudChatCatalog([
			{
				...current,
				state: "archived",
				desiredState: "archived",
				archivedAt: 123,
				revision: 4,
			},
		]);
		expect(useCloudChatCatalogStore.getState().archiveIntents).toEqual({});
		expect(cloudSummaryForChat("chat-a")?.state).toBe("archived");
	});

	it("moves an archived chat back immediately without waking compute", () => {
		const archived = {
			...summary({
				workspaceId: "environment-a",
				chatId: "chat-a",
				sessionId: "session-a",
				revision: 2,
			}),
			state: "archived" as const,
			desiredState: "archived" as const,
			archivedAt: 123,
		};
		registerCloudChat(archived);

		expect(optimisticallyUnarchiveCloudChat(archived)).toMatchObject({
			state: "paused",
			desiredState: "paused",
			runtimeState: "offline",
			archivedAt: undefined,
		});
		expect(cloudSummaryForChat("chat-a")).toMatchObject({
			state: "paused",
			desiredState: "paused",
		});
	});
});
