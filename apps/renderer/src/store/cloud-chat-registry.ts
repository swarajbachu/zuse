import type { CloudChatSummary, FolderId, SessionId } from "@zuse/contracts";

const summaryByChat = new Map<string, CloudChatSummary>();
const summaryBySession = new Map<string, CloudChatSummary>();
const localProjectByChat = new Map<string, FolderId>();

export const registerCloudChat = (
	summary: CloudChatSummary,
	projectId?: FolderId,
): void => {
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
