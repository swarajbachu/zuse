import {
	ChatId,
	CloudChatSummary,
	CommandId,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	cloudLifecycleLabel,
	cloudQueueStatus,
} from "../../src/lib/cloud-queue-status.ts";

const summary = (overrides: Partial<CloudChatSummary> = {}): CloudChatSummary =>
	CloudChatSummary.make({
		workspaceId: "workspace",
		projectId: "project",
		repositoryIdentity: "github.com/zuse/zuse",
		repositoryDisplayName: "zuse",
		chatId: ChatId.make("chat"),
		initialSessionId: SessionId.make("session"),
		title: "chat",
		branch: "cloud",
		providerId: "box",
		agent: "acp-test-agent",
		model: "test-model",
		state: "ready",
		desiredState: "ready",
		runtimeState: "online",
		statusCode: "agent-running",
		startupPhase: "running",
		revision: 1,
		summaryRevision: 1,
		sessionHeadVersion: 1,
		unread: false,
		lastMessageAt: 1,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	});

describe("cloud lifecycle label", () => {
	it("narrates a new workspace before and during its first boot", () => {
		expect(
			cloudLifecycleLabel({
				summary: null,
				activity: null,
				connection: "dormant",
			}),
		).toBe("Preparing cloud workspace…");
		for (const [startupPhase, runtimeState, label] of [
			["allocating", "offline", "Preparing cloud workspace…"],
			["booting", "offline", "Starting secure cloud runtime…"],
			[
				"authenticating-runtime",
				"connecting",
				"Starting secure cloud runtime…",
			],
			["syncing-repository", "online", "Preparing repository…"],
		] as const)
			expect(
				cloudLifecycleLabel({
					summary: summary({
						state: "provisioning",
						statusCode: "provider-provisioning",
						startupPhase,
						runtimeState,
					}),
					activity: "resuming",
					connection: "connecting",
				}),
			).toBe(label);
	});

	it("follows a resume from wake to connect instead of a fixed label", () => {
		const resume = (
			overrides: Partial<CloudChatSummary>,
			connection: "dormant" | "connecting" | "connected" = "dormant",
		) =>
			cloudLifecycleLabel({
				summary: summary(overrides),
				activity: "resuming",
				connection,
			});
		expect(
			resume({
				state: "resuming",
				runtimeState: "offline",
				statusCode: "resume-runtime-waking",
			}),
		).toBe("Resuming cloud workspace…");
		expect(
			resume({
				state: "resuming",
				runtimeState: "offline",
				statusCode: "resume-runtime-restarting",
			}),
		).toBe("Restarting cloud runtime…");
		expect(resume({ state: "resuming", runtimeState: "connecting" })).toBe(
			"Connecting to cloud runtime…",
		);
		expect(resume({}, "connecting")).toBe("Connecting to cloud workspace…");
	});

	it("resumes a paused workspace rather than waiting on the agent", () => {
		expect(
			cloudLifecycleLabel({
				summary: summary({
					state: "paused",
					runtimeState: "offline",
					statusCode: "paused",
				}),
				activity: "paused",
				connection: "dormant",
			}),
		).toBe("Resuming cloud workspace…");
	});

	it("waits for cloud once compute is up but the prompt is unclaimed", () => {
		expect(
			cloudLifecycleLabel({
				summary: summary(),
				activity: "idle",
				connection: "connected",
			}),
		).toBe("Waiting for cloud");
	});
});

describe("cloud queue status", () => {
	const send = {
		commandId: CommandId.make("message-send:prompt"),
		kind: "messages.send",
		targetId: null,
		submittedAt: 1,
	} as const;

	it("lets the lifecycle own a prompt that waits on compute", () => {
		expect(
			cloudQueueStatus({
				summary: summary({ state: "resuming", runtimeState: "connecting" }),
				activity: "resuming",
				connection: "connecting",
				pendingCommands: [{ ...send, deliveryPhase: "waiting-for-runtime" }],
			}),
		).toEqual({ label: "Connecting to cloud runtime…", busy: true });
	});

	it("keeps an actionable label for a prompt blocked on the user", () => {
		expect(
			cloudQueueStatus({
				summary: summary({ state: "resuming", runtimeState: "connecting" }),
				activity: "resuming",
				connection: "connecting",
				pendingCommands: [
					{
						...send,
						deliveryPhase: "blocked",
						category: "billing-blocked",
						blockedUntil: "billing-restored",
					},
				],
			}),
		).toEqual({ label: "Billing action required", busy: false });
	});
});
