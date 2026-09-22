import {
	AgentSessionId,
	AgentTurnId,
	ChatId,
	CloudChatSummary,
	CommandId,
	EnvironmentId,
	FolderId,
	QueueState,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
	cloudChatShowsWorking,
	deriveCloudChatActivity,
} from "../../src/lib/cloud-chat-activity.ts";
import { cloudConnectionPresentation } from "../../src/lib/cloud-connection-presentation.ts";
import {
	cloudSummaryForChat,
	cloudSummaryForEnvironment,
	cloudSummaryForSelection,
	cloudSummaryForSession,
	compareCloudChatSummaryVersion,
	confirmCloudChatUnarchive,
	localProjectForCloudChat,
	optimisticallyArchiveCloudChat,
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
		projectId: `api-${input.workspaceId}`,
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

	it("keeps secondary sessions qualified by their owning cloud chat", () => {
		const current = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "initial-session-a",
			revision: 1,
		});
		registerCloudChat(current, FolderId.make("local-project-a"));

		expect(
			cloudSummaryForSelection({
				chatId: ChatId.make("chat-a"),
				sessionId: AgentSessionId.make("secondary-session-a"),
			}),
		).toBe(current);
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
		expect(cloudConnectionPresentation(row, "failed", "failed")).toBe(
			"detached",
		);
		const failedWorkspace = CloudChatSummary.make({
			...row,
			state: "failed",
			runtimeState: "offline",
		});
		expect(
			cloudConnectionPresentation(failedWorkspace, "failed", "failed"),
		).toBe("failed");
		expect(
			deriveCloudChatActivity({
				summary: row,
				connection: "connected",
				runtime: "running",
			}),
		).toBe("running");
		expect(cloudConnectionPresentation(row, "attaching", "waking")).toBe(
			"hidden",
		);
		expect(cloudConnectionPresentation(row, "failed", "update-required")).toBe(
			"update-required",
		);
	});

	it("keeps paused and waking compute separate from retained socket failures", () => {
		const row = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 1,
		});
		for (const runtime of ["idle", "running", "failed"] as const) {
			for (const connection of ["failed", "reconnecting", "offline"] as const) {
				for (const state of ["paused", "resuming"] as const) {
					const workspace = CloudChatSummary.make({
						...row,
						state,
						desiredState: state === "paused" ? "paused" : "ready",
						runtimeState: "offline",
						statusCode:
							state === "paused" ? "runtime-update-pending" : "resume-queued",
					});
					const activity = deriveCloudChatActivity({
						summary: workspace,
						connection,
						runtime,
					});
					expect(activity).toBe(state);
					expect(
						cloudConnectionPresentation(workspace, activity, connection),
					).toBe(state);
					expect(cloudChatShowsWorking(activity)).toBe(false);
				}
			}
		}
	});

	it("still surfaces authentication and lifecycle failures during resume", () => {
		const row = CloudChatSummary.make({
			...summary({
				workspaceId: "environment-a",
				chatId: "chat-a",
				sessionId: "session-a",
				revision: 1,
			}),
			state: "resuming",
			runtimeState: "offline",
			statusCode: "resume-queued",
		});
		for (const connection of [
			"blocked-auth",
			"revoked",
			"update-required",
		] as const) {
			expect(
				deriveCloudChatActivity({ summary: row, connection, runtime: "idle" }),
			).toBe("failed");
		}
		expect(
			deriveCloudChatActivity({
				summary: { ...row, state: "failed" },
				connection: "failed",
				runtime: "idle",
			}),
		).toBe("failed");
	});

	it("retains an observed live turn through reconnect and history synchronization", () => {
		const row = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 1,
		});
		const projection = SessionTimelineProjection.make({
			messages: [],
			status: "running",
			currentTurn: { turnId: AgentTurnId.make("turn-a"), phase: "running" },
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		});
		for (const connection of ["connected", "reconnecting", "failed"] as const) {
			const timeline = {
				data: projection,
				origin: "runtime" as const,
				connection,
				sync: "synchronizing" as const,
				generation: 1,
				cursor: null,
				pendingCommands: [],
				failedCommands: [],
			};
			const input = {
				summary: row,
				connection,
				runtime: "idle" as const,
				timeline,
			};
			expect(deriveCloudChatActivity(input)).toBe("running");
			expect(
				deriveCloudChatActivity({
					...input,
					timeline: {
						...timeline,
						pendingCommands: [
							{
								commandId: CommandId.make("stop-a"),
								kind: "messages.interrupt",
								targetId: null,
								submittedAt: 1,
							},
						],
					},
				}),
			).toBe("stopping");
			expect(
				deriveCloudChatActivity({ ...input, connection: "blocked-auth" }),
			).toBe("failed");
			if (connection === "failed")
				expect(cloudConnectionPresentation(row, "running", connection)).toBe(
					"detached",
				);
			expect(cloudChatShowsWorking(deriveCloudChatActivity(input))).toBe(true);
			for (const origin of ["cache", "checkpoint"] as const) {
				expect(
					deriveCloudChatActivity({
						...input,
						timeline: { ...timeline, origin },
					}),
				).not.toBe("running");
			}
			expect(
				deriveCloudChatActivity({
					...input,
					summary: { ...row, state: "paused", runtimeState: "offline" },
				}),
			).toBe("paused");
			expect(
				deriveCloudChatActivity({
					...input,
					timeline: {
						...timeline,
						data: { ...projection, currentTurn: null, status: "idle" },
					},
				}),
			).not.toBe("running");
		}
	});

	it("does not show cached work while disconnected or recovering", () => {
		const row = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 1,
		});
		for (const runtime of ["running", "stopping", "starting"] as const) {
			expect(
				deriveCloudChatActivity({
					summary: row,
					connection: "reconnecting",
					runtime,
				}),
			).toBe("attaching");
			expect(
				deriveCloudChatActivity({
					summary: CloudChatSummary.make({
						...row,
						state: "setup",
						statusCode: "agent-starting",
						startupPhase: "starting-agent",
					}),
					connection: "connected",
					runtime: "running",
				}),
			).toBe("resuming");
		}
	});

	it("does not present a provider failure as a cloud connection failure", () => {
		const row = summary({
			workspaceId: "environment-a",
			chatId: "chat-a",
			sessionId: "session-a",
			revision: 1,
		});
		const activity = deriveCloudChatActivity({
			summary: row,
			connection: "connected",
			runtime: "failed",
		});

		expect(activity).toBe("failed");
		expect(cloudConnectionPresentation(row, activity, "connected")).toBe(
			"hidden",
		);
	});

	it("does not keep a settled turn working from stale bootstrap metadata", () => {
		const row = CloudChatSummary.make({
			...summary({
				workspaceId: "environment-a",
				chatId: "chat-a",
				sessionId: "session-a",
				revision: 1,
			}),
			startupPhase: "starting-agent",
		});

		expect(
			deriveCloudChatActivity({
				summary: row,
				connection: "connected",
				runtime: "idle",
			}),
		).toBe("idle");
		expect(
			deriveCloudChatActivity({
				summary: row,
				connection: "connected",
				runtime: "starting",
			}),
		).toBe("starting-agent");
	});

	it("bridges durable agent startup into the regular working row", () => {
		const row = CloudChatSummary.make({
			...summary({
				workspaceId: "environment-a",
				chatId: "chat-a",
				sessionId: "session-a",
				revision: 1,
			}),
			startupPhase: "starting-agent",
			statusCode: "agent-starting",
		});

		expect(
			deriveCloudChatActivity({
				summary: row,
				connection: "connected",
				runtime: "idle",
			}),
		).toBe("starting-agent");
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

	it("publishes a confirmed restore and clears the previous archive intent", () => {
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

		optimisticallyArchiveCloudChat(archived, 123, "archive-command");
		confirmCloudChatUnarchive({
			...archived,
			state: "paused",
			desiredState: "paused",
			runtimeState: "offline",
			archivedAt: undefined,
			revision: 3,
		});
		expect(useCloudChatCatalogStore.getState().archiveIntents).toEqual({});

		expect(cloudSummaryForChat("chat-a")).toMatchObject({
			state: "paused",
			desiredState: "paused",
		});
	});
});
