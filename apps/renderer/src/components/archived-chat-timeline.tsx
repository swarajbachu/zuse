import { LegendList } from "@legendapp/list/react";
import type { FolderId, Message, SessionId } from "@zuse/contracts";
import { useCallback, useMemo } from "react";

import {
  type ChatTimelineRow,
  deriveChatTimelineRows,
} from "../lib/chat-timeline-rows.ts";
import { ChatLookupsProvider, deriveChatLookups } from "./chat-lookups.tsx";
import { FileChipProvider } from "./file-chip.tsx";
import { MessageRow } from "./message-row.tsx";
import { SubagentRow } from "./subagent-row.tsx";
import { TurnSummary } from "./turn-summary.tsx";

export function ArchivedChatTimeline({
  projectId,
  sessionId,
  messages,
}: {
  readonly projectId: FolderId;
  readonly sessionId: SessionId;
  readonly messages: ReadonlyArray<Message>;
}) {
  const rows = useMemo(
    () =>
      deriveChatTimelineRows({
        messages,
        inFlight: false,
        awaitingPlanApproval: false,
      }),
    [messages],
  );
  const lookups = useMemo(() => deriveChatLookups(messages), [messages]);
  const renderRow = useCallback(
    ({ item }: { item: ChatTimelineRow }) => (
      <ArchivedTimelineRow row={item} sessionId={sessionId} />
    ),
    [sessionId],
  );

  return (
    <FileChipProvider folderId={projectId} worktreeId={null}>
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
          aria-label="Archived chat transcript"
          tabIndex={0}
          ListHeaderComponent={<div className="h-2" />}
          ListFooterComponent={<div className="h-2" />}
        />
      </ChatLookupsProvider>
    </FileChipProvider>
  );
}

function ArchivedTimelineRow({
  row,
  sessionId,
}: {
  readonly row: ChatTimelineRow;
  readonly sessionId: SessionId;
}) {
  switch (row.kind) {
    case "message":
      return (
        <MessageRow message={row.message} sessionId={sessionId} readOnly />
      );
    case "subagent":
      return (
        <SubagentRow
          agentToolUseId={row.parentItemId}
          agentName={row.agentName}
          prompt={row.prompt}
          modelRequested={row.modelRequested}
          childSessionId={row.childSessionId}
          presentation={row.presentation}
          children={row.children}
          summary={row.summary}
          readOnly
        />
      );
    case "turn-summary":
      return <TurnSummary body={row.body} />;
    case "working":
      return null;
  }
}
