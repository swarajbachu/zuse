import { summaryFromLaunch } from "@zuse/client-runtime/cloud-catalog";
import { AgentSessionId, ChatId, CloudWorkspace } from "@zuse/contracts";

export const workspace = (
	overrides: Partial<CloudWorkspace> = {},
): CloudWorkspace =>
	CloudWorkspace.make({
		workspaceId: "workspace-1",
		projectId: "project-1",
		providerId: "e2b",
		branch: "cloud/mobile",
		baseRef: "origin/main",
		state: "paused",
		desiredState: "paused",
		statusCode: "paused",
		startupPhase: "running",
		startupTimings: {},
		runtimeState: "offline",
		revision: 1,
		chatId: ChatId.make("chat-1"),
		initialSessionId: AgentSessionId.make("session-1"),
		createdAt: 1,
		updatedAt: 1,
		lastActivityAt: 1,
		...overrides,
	});
export const summary = (row = workspace()) =>
	summaryFromLaunch({
		workspace: row,
		repositoryIdentity: "github.com/example/repo",
		repositoryDisplayName: "example/repo",
		title: "Cloud task",
		agent: "codex",
		model: "gpt-5.5",
		runtimeMode: "full-access",
	});
