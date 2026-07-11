import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Brain01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import type { Message } from "@zuse/contracts";
import { memo, useMemo, useState } from "react";

import { summarizeToolActivity } from "~/lib/tool-activity";
import { cn } from "~/lib/utils";

import { MessageRow } from "./message-row.tsx";
import { iconForTool } from "./tool-row.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

function ToolGroupImpl({
  messages,
  live = false,
}: {
  readonly messages: ReadonlyArray<Message>;
  readonly live?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(
    () => summarizeToolActivity(messages, live),
    [messages, live],
  );
  const firstUse = messages.find(
    (message) => message.content._tag === "tool_use",
  );
  const icon =
    firstUse?.content._tag === "tool_use"
      ? iconForTool(firstUse.content.tool)
      : Brain01Icon;
  const chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;
  const content = messages.map((message) => {
    if (message.content._tag === "tool_result") return null;
    return <MessageRow key={message.id} message={message} compact muted />;
  });

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "group flex min-h-8 w-full max-w-2xl items-center gap-2 rounded text-left text-xs text-muted-foreground",
          "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1",
        )}
      >
        <div className="relative grid size-4 shrink-0 place-items-center">
          <HugeiconsIcon
            icon={icon}
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
        <span className="min-w-0 flex-1 truncate">
          {summary.pending ? (
            <ShimmerText className="text-xs">{summary.label}</ShimmerText>
          ) : (
            summary.label
          )}
        </span>
      </button>
      {expanded ? <div>{content}</div> : null}
    </div>
  );
}

export const ToolGroup = memo(ToolGroupImpl);
ToolGroup.displayName = "ToolGroup";
