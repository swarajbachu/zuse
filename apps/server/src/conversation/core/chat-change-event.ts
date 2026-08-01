import type { ChatSummaryChange, FolderId } from "@zuse/contracts";

export type ChatChangeEvent = {
	readonly projectId: FolderId;
	readonly change: ChatSummaryChange;
};
