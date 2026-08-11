import type { CloudChatSummary, FolderId, SessionId } from "@zuse/contracts";

const summaryByChat = new Map<string, CloudChatSummary>();
const summaryBySession = new Map<string, CloudChatSummary>();
const localProjectByChat = new Map<string, FolderId>();
export type CloudExecutionTarget = {
	readonly workspaceId: string;
	readonly projectId: string;
	readonly folderId: FolderId;
	readonly rootPath: string;
};
const executionTargetByWorkspace = new Map<string, CloudExecutionTarget>();

export const registerCloudChat = (
	summary: CloudChatSummary,
	projectId?: FolderId,
): void => {
	const current = summaryByChat.get(summary.chatId);
	if (current !== undefined && current.revision > summary.revision) return;
	summaryByChat.set(summary.chatId, summary);
	summaryBySession.set(summary.initialSessionId, summary);
	if (projectId !== undefined)
		localProjectByChat.set(summary.chatId, projectId);
};

export const cloudSummaryForChat = (chatId: string): CloudChatSummary | null =>
	summaryByChat.get(chatId) ?? null;

export const cloudSummaryForSession = (
	sessionId: SessionId,
): CloudChatSummary | null => summaryBySession.get(sessionId) ?? null;

export const localProjectForCloudChat = (chatId: string): FolderId | null =>
	localProjectByChat.get(chatId) ?? null;

export const registerCloudExecutionTarget = (
	workspaceId: string,
	target: CloudExecutionTarget,
): void => {
	executionTargetByWorkspace.set(workspaceId, target);
};

export const cloudExecutionTarget = (
	workspaceId: string,
): CloudExecutionTarget | null =>
	executionTargetByWorkspace.get(workspaceId) ?? null;
