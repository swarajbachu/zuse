import type { SessionCommand } from "../core/commands.js";

type CreateSessionCommand = Extract<
	SessionCommand,
	{ readonly _tag: "CreateSession" }
>;

export const sessionCreation = {
	sessionId: "session-1",
	chatId: "chat-1",
	projectId: "project-1",
	title: "Session",
	providerId: "provider-1",
	model: "model-1",
	status: "idle",
	cursor: null,
	resumeStrategy: "none",
	runtimeMode: "approval-required",
	agentsJson: null,
	worktreeId: null,
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	queuePaused: false,
	createdAt: 1,
} as const satisfies Omit<CreateSessionCommand, "_tag">;

export const createSessionCommand: CreateSessionCommand = {
	_tag: "CreateSession",
	...sessionCreation,
};
