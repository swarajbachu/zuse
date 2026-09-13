import {
	Chat,
	type CloudChatSummary,
	type CloudWorkspace,
	type FolderId,
	type ProviderId,
	Session,
	type SessionId,
} from "@zuse/contracts";

export const compareCloudChatSummaryVersion = (
	left: CloudChatSummary,
	right: CloudChatSummary,
): number =>
	left.revision !== right.revision
		? left.revision - right.revision
		: left.summaryRevision !== right.summaryRevision
			? left.summaryRevision - right.summaryRevision
			: left.sessionHeadVersion !== right.sessionHeadVersion
				? left.sessionHeadVersion - right.sessionHeadVersion
				: left.updatedAt - right.updatedAt;

export const summaryFromLaunch = (input: {
	readonly workspace: CloudWorkspace;
	readonly repositoryIdentity: string;
	readonly repositoryDisplayName: string;
	readonly title: string;
	readonly agent: ProviderId;
	readonly model: string;
	readonly runtimeMode: CloudChatSummary["runtimeMode"];
}): CloudChatSummary => ({
	workspaceId: input.workspace.workspaceId,
	projectId: input.workspace.projectId,
	repositoryIdentity: input.repositoryIdentity,
	repositoryDisplayName: input.repositoryDisplayName,
	chatId: input.workspace.chatId,
	initialSessionId: input.workspace.initialSessionId,
	title: input.title,
	branch: input.workspace.branch,
	providerId: input.workspace.providerId,
	codexAuthMode: input.workspace.codexAuthMode,
	providerAuthMode: input.workspace.providerAuthMode,
	agent: input.agent,
	model: input.model,
	runtimeMode: input.runtimeMode,
	state: input.workspace.state,
	runtimeState: input.workspace.runtimeState,
	statusCode: input.workspace.statusCode,
	failureDiagnostic: input.workspace.failureDiagnostic,
	startupPhase: input.workspace.startupPhase,
	desiredState: input.workspace.desiredState,
	revision: input.workspace.revision,
	summaryRevision: 0,
	sessionHeadVersion: 0,
	unread: false,
	lastMessageAt: input.workspace.createdAt,
	createdAt: input.workspace.createdAt,
	updatedAt: input.workspace.updatedAt,
});

const sessionStatus = (summary: CloudChatSummary): Session["status"] =>
	summary.state === "failed" ? "error" : "idle";

/** Metadata fallback for rendering a cached transcript without a live shell. */
export const cloudSessionPlaceholder = (
	summary: CloudChatSummary,
	projectId: FolderId,
	sessionId: SessionId = summary.initialSessionId,
): Session => {
	const now = new Date(summary.createdAt);
	return Session.make({
		id: sessionId,
		projectId,
		title: summary.title,
		titleProvenance: "manual",
		providerId: summary.agent,
		model: summary.model,
		status: sessionStatus(summary),
		archivedAt: null,
		cursor: null,
		resumeStrategy: "none",
		runtimeMode: summary.runtimeMode,
		worktreeId: null,
		chatId: summary.chatId,
		forkedFromSessionId: null,
		forkedFromMessageId: null,
		permissionMode: "default",
		toolSearch: false,
		createdAt: now,
		updatedAt: new Date(summary.updatedAt),
	});
};

export const cloudChatPlaceholder = (
	summary: CloudChatSummary,
	projectId: FolderId,
): Chat =>
	Chat.make({
		id: summary.chatId,
		projectId,
		worktreeId: null,
		title: summary.title,
		titleProvenance: "manual",
		activeSessionId:
			summary.activeSessionId === undefined
				? summary.initialSessionId
				: summary.activeSessionId,
		originSessionId: null,
		archivedAt:
			summary.archivedAt === undefined ? null : new Date(summary.archivedAt),
		lastMessageAt:
			summary.lastMessageAt === null ? null : new Date(summary.lastMessageAt),
		lastReadAt: summary.unread ? new Date(0) : new Date(summary.updatedAt),
		createdAt: new Date(summary.createdAt),
		updatedAt: new Date(summary.updatedAt),
	});
