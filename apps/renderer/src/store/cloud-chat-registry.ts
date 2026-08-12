import type { CloudChatSummary, FolderId, SessionId } from "@zuse/contracts";
import { createAtomStore as create } from "../state/atom-store.ts";

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
export type CloudAttachmentState =
	| "detached"
	| "attaching"
	| "ready"
	| "failed";
type CloudExecutionState = {
	readonly stateByWorkspace: Readonly<Record<string, CloudAttachmentState>>;
	readonly targetByWorkspace: Readonly<Record<string, CloudExecutionTarget>>;
};
export const useCloudExecutionStore = create<CloudExecutionState>(() => ({
	stateByWorkspace: {},
	targetByWorkspace: {},
}));

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
	useCloudExecutionStore.setState((state) => ({
		stateByWorkspace: state.stateByWorkspace,
		targetByWorkspace: { ...state.targetByWorkspace, [workspaceId]: target },
	}));
};

export const setCloudAttachmentState = (
	workspaceId: string,
	attachmentState: CloudAttachmentState,
): void => {
	if (attachmentState === "detached" || attachmentState === "failed")
		executionTargetByWorkspace.delete(workspaceId);
	useCloudExecutionStore.setState((state) => ({
		stateByWorkspace: {
			...state.stateByWorkspace,
			[workspaceId]: attachmentState,
		},
		targetByWorkspace:
			attachmentState === "ready" || attachmentState === "attaching"
				? state.targetByWorkspace
				: Object.fromEntries(
						Object.entries(state.targetByWorkspace).filter(
							([id]) => id !== workspaceId,
						),
					),
	}));
};

export const cloudExecutionTarget = (
	workspaceId: string,
): CloudExecutionTarget | null =>
	executionTargetByWorkspace.get(workspaceId) ?? null;
