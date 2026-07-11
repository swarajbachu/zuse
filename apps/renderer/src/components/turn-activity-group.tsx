import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Wrench01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import type { Message } from "@zuse/contracts";
import { memo, useMemo, useState } from "react";

import { groupMessages } from "~/lib/group-messages";
import {
  countTurnProgressMessages,
  isToolActivityMessage,
} from "~/lib/tool-activity";

import { MessageRow } from "./message-row.tsx";
import { SubagentRow } from "./subagent-row.tsx";
import { ToolGroup } from "./tool-group.tsx";

const formatDuration = (messages: ReadonlyArray<Message>): string => {
  const first = messages[0]?.createdAt.getTime() ?? 0;
  const last = messages.at(-1)?.createdAt.getTime() ?? first;
  const seconds = Math.max(0, Math.round((last - first) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} ${minutes === 1 ? "min" : "mins"}`;
};

function TurnActivityGroupImpl({
  body,
  totalBody,
}: {
  readonly body: ReadonlyArray<Message>;
  readonly totalBody: ReadonlyArray<Message>;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupMessages(body), [body]);
  const toolCount = body.filter(
    (message) => message.content._tag === "tool_use",
  ).length;
  const messageCount = countTurnProgressMessages(body);
  const label = `Worked with ${toolCount} tool ${toolCount === 1 ? "call" : "calls"}, ${messageCount} ${messageCount === 1 ? "update" : "updates"} in ${formatDuration(totalBody)}`;
  const chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;

  return (
    <div className="px-4">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex min-h-8 w-full max-w-2xl items-center gap-2 rounded text-left text-xs text-muted-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      >
        <div className="relative grid size-4 shrink-0 place-items-center">
          <HugeiconsIcon
            icon={Wrench01Icon}
            strokeWidth={2}
            aria-hidden="true"
            className="col-start-1 row-start-1 size-3.5 transition-opacity duration-150 ease-out group-hover:opacity-0 motion-reduce:transition-none"
          />
          <HugeiconsIcon
            icon={chevron}
            aria-hidden="true"
            className="col-start-1 row-start-1 size-3.5 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 motion-reduce:transition-none"
          />
        </div>
        <span className="min-w-0 flex-1 truncate tabular-nums">{label}</span>
      </button>
      {expanded ? <TurnDetails groups={groups} /> : null}
    </div>
  );
}

export const TurnActivityGroup = memo(TurnActivityGroupImpl);
TurnActivityGroup.displayName = "TurnActivityGroup";

function TurnDetails({
  groups,
}: {
  readonly groups: ReturnType<typeof groupMessages>;
}) {
  const hasSingleActivityBlock = groups.every(
    (group) => group.kind === "single" && isToolActivityMessage(group.message),
  );
  if (hasSingleActivityBlock) {
    return (
      <div>
        {groups.map((group) => {
          if (group.kind !== "single") return null;
          if (group.message.content._tag === "tool_result") return null;
          return (
            <MessageRow
              key={group.message.id}
              message={group.message}
              compact
            />
          );
        })}
      </div>
    );
  }

  const rows: React.ReactNode[] = [];
  let activity: Message[] = [];
  const flush = () => {
    const first = activity[0];
    if (first === undefined) return;
    const toolUses = activity.filter(
      (message) => message.content._tag === "tool_use",
    );
    if (toolUses.length <= 1) {
      for (const message of activity) {
        if (message.content._tag !== "tool_result") {
          rows.push(<MessageRow key={message.id} message={message} compact />);
        }
      }
    } else {
      rows.push(<ToolGroup key={`activity:${first.id}`} messages={activity} />);
    }
    activity = [];
  };

  for (const group of groups) {
    if (group.kind === "single" && isToolActivityMessage(group.message)) {
      activity.push(group.message);
      continue;
    }
    flush();
    if (group.kind === "single") {
      rows.push(
        <MessageRow key={group.message.id} message={group.message} compact />,
      );
      continue;
    }
    rows.push(
      <SubagentRow
        key={group.parent.id}
        agentToolUseId={group.parentItemId}
        agentName={group.agentName}
        prompt={group.prompt}
        modelRequested={group.modelRequested}
        childSessionId={group.childSessionId}
        presentation={group.presentation}
        children={group.children}
        summary={group.summary}
      />,
    );
  }
  flush();
  return <div>{rows}</div>;
}
