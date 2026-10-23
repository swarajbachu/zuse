import { ChatImageGalleryProvider } from "./chat-image-gallery";
import "@zuse/i18n/english/chat";
import { LegendList } from "@legendapp/list/react";
import type {
	EnvironmentId,
	FolderId,
	Message,
	SessionId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useCallback, useMemo } from "react";

import {
	type ChatTimelineRow,
	deriveChatTimelineRows,
} from "../lib/chat-timeline-rows.ts";
import { ChatLookupsProvider, deriveChatLookups } from "./chat-lookups.tsx";
import { FileChipProvider } from "./file-chip.tsx";
import { TranscriptRow } from "./transcript-row.tsx";

export function ArchivedChatTimeline({
	projectId,
	environmentId,
	sessionId,
	messages,
}: {
	readonly projectId: FolderId;
	readonly environmentId: EnvironmentId;
	readonly sessionId: SessionId;
	readonly messages: ReadonlyArray<Message>;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const rows = useMemo(
		() =>
			deriveChatTimelineRows({
				messages,
				inFlight: false,
				awaitingPlanApproval: false,
			}),
		[messages, uiMessage],
	);
	const lookups = useMemo(
		() => deriveChatLookups(messages),
		[messages, uiMessage],
	);
	const renderRow = useCallback(
		({ item }: { item: ChatTimelineRow }) => (
			<TranscriptRow
				row={item}
				chatRef={null}
				parentLive={false}
				assistantCommands
				environmentId={environmentId}
				sessionId={sessionId}
				readOnly
				forkDestination="chat"
				sourceProjectId={projectId}
			/>
		),
		[environmentId, projectId, sessionId],
	);

	return (
		<FileChipProvider folderId={projectId} worktreeId={null}>
			<ChatImageGalleryProvider key={sessionId} messages={messages}>
				<ChatLookupsProvider value={lookups}>
					<LegendList<ChatTimelineRow>
						key={sessionId}
						data={rows}
						keyExtractor={(row) => row.id}
						getItemType={(row) => row.kind}
						renderItem={renderRow}
						estimatedItemSize={96}
						initialScrollAtEnd
						maintainVisibleContentPosition={{ data: true, size: false }}
						className="h-full min-h-0 flex-1 overflow-x-hidden outline-none"
						aria-label={uiMessage(
							"chat:archived_chat_timeline_archived_chat_transcript",
						)}
						tabIndex={0}
						ListHeaderComponent={<div className="h-2" />}
						ListFooterComponent={<div className="h-2" />}
					/>
				</ChatLookupsProvider>
			</ChatImageGalleryProvider>
		</FileChipProvider>
	);
}
