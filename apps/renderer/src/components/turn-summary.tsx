import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  BubbleChatIcon,
  Wrench01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";

import type { AgentItemId, Message, UserQuestionAnswer } from "@memoize/wire";

import { groupMessages } from "../lib/group-messages.ts";
import { cn } from "~/lib/utils";

import { CopyButton } from "./copy-button.tsx";
import { FileBadge } from "./file-badge.tsx";
import {
  diffStats,
  extractEdits,
  extractPatchEntries,
  patchStats,
} from "./inline-diff.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import { MessageRow, type ToolResultRecord } from "./message-row.tsx";
import { SubagentRow } from "./subagent-row.tsx";
import { iconForTool } from "./tool-row.tsx";

const formatElapsed = (ms: number): string => {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec - min * 60);
  return `${min}m, ${sec}s`;
};

interface FileStat {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

const aggregateFileStats = (body: ReadonlyArray<Message>): FileStat[] => {
  const map = new Map<string, { added: number; removed: number }>();
  const addStats = (
    path: string,
    stats: { added: number; removed: number },
  ) => {
    const prev = map.get(path) ?? { added: 0, removed: 0 };
    map.set(path, {
      added: prev.added + stats.added,
      removed: prev.removed + stats.removed,
    });
  };
  for (const m of body) {
    if (m.content._tag !== "tool_use") continue;
    const tool = m.content.tool;
    if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") continue;
    const patches = extractPatchEntries(m.content.input);
    if (patches.length > 0) {
      for (const patch of patches) {
        addStats(patch.file_path, patchStats([patch]));
      }
      continue;
    }
    const edits = extractEdits(tool, m.content.input);
    if (edits.length === 0) continue;
    const stats = diffStats(edits);
    const path = edits[0]!.path;
    addStats(path, stats);
  }
  return Array.from(map.entries()).map(([path, s]) => ({ path, ...s }));
};

const findFinalAssistant = (body: ReadonlyArray<Message>): Message | null => {
  for (let i = body.length - 1; i >= 0; i--) {
    const m = body[i]!;
    if (m.content._tag === "assistant") return m;
  }
  return null;
};

const MAX_PREVIEW_ICONS = 5;

/**
 * Inline summary of a completed turn. The header (chevron + counts + tool
 * icon preview) toggles the detail rows. The final assistant text always
 * shows below; the footer carries elapsed time and file edit stats. No
 * outer card — sections sit flat in the timeline like every other row.
 */
export function TurnSummary({
  body,
  resultsByItemId,
  answersByItemId,
}: {
  body: ReadonlyArray<Message>;
  resultsByItemId: ReadonlyMap<AgentItemId, ToolResultRecord>;
  answersByItemId?: ReadonlyMap<AgentItemId, ReadonlyArray<UserQuestionAnswer>>;
}) {
  const [expanded, setExpanded] = useState(false);

  const toolUses = useMemo(
    () => body.filter((m) => m.content._tag === "tool_use"),
    [body],
  );
  const messageCount = useMemo(
    () =>
      body.filter(
        (m) => m.content._tag === "thinking" || m.content._tag === "assistant",
      ).length,
    [body],
  );

  const finalAssistant = useMemo(() => findFinalAssistant(body), [body]);
  const fileStats = useMemo(() => aggregateFileStats(body), [body]);

  const duration = useMemo(() => {
    if (body.length === 0) return 0;
    const start = body[0]!.createdAt.getTime();
    const end = body[body.length - 1]!.createdAt.getTime();
    return Math.max(0, end - start);
  }, [body]);

  const detailRows = useMemo(
    () => body.filter((m) => m !== finalAssistant),
    [body, finalAssistant],
  );

  // Group sub-agent runs so each `Agent` tool_use renders as a SubagentRow
  // with its nested children inside, instead of dumping every nested Bash
  // / text row at the top level alongside the parent's own work — which
  // makes parallel sub-agents look like duplicates.
  const detailGroups = useMemo(() => groupMessages(detailRows), [detailRows]);

  // Dedupe by icon identity (not tool name) — Edit/Write/MultiEdit share an
  // icon, as do Grep/Glob, etc. We want one slot per visual, ordered by
  // first appearance in the turn.
  const previewIcons = useMemo(() => {
    const items: { key: string; icon: ReturnType<typeof iconForTool> }[] = [];
    const seen = new Set<unknown>();
    for (const m of toolUses) {
      if (m.content._tag !== "tool_use") continue;
      const icon = iconForTool(m.content.tool);
      if (seen.has(icon)) continue;
      seen.add(icon);
      items.push({ key: m.id, icon });
    }
    return items;
  }, [toolUses]);

  const chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;
  const mutedWhenOpen = expanded
    ? "text-muted-foreground/50"
    : "text-muted-foreground";

  const overflowCount = previewIcons.length - MAX_PREVIEW_ICONS;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          "flex w-full items-center gap-3 rounded px-4 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/40",
          mutedWhenOpen,
        )}
      >
        <HugeiconsIcon
          icon={chevron}
          className="size-3.5 shrink-0 opacity-70"
        />
        <span className="flex items-center gap-1.5">
          <HugeiconsIcon
            icon={Wrench01Icon}
            strokeWidth={2}
            aria-hidden="true"
            className="size-3.5"
          />
          <span className="tabular-nums">{toolUses.length}</span>
          <span>tool {toolUses.length === 1 ? "call" : "calls"}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <HugeiconsIcon
            icon={BubbleChatIcon}
            strokeWidth={2}
            aria-hidden="true"
            className="size-3.5"
          />
          <span className="tabular-nums">{messageCount}</span>
          <span>{messageCount === 1 ? "message" : "messages"}</span>
        </span>
        {previewIcons.length > 0 ? (
          <span className="flex items-center gap-1.5 opacity-70">
            {previewIcons.slice(0, MAX_PREVIEW_ICONS).map((p) => (
              <HugeiconsIcon
                key={p.key}
                icon={p.icon}
                strokeWidth={2}
                aria-hidden="true"
                className="size-3.5"
              />
            ))}
            {overflowCount > 0 ? (
              <span className="tabular-nums">+{overflowCount}</span>
            ) : null}
          </span>
        ) : null}
      </button>

      {expanded && detailGroups.length > 0 ? (
        <div className="py-1">
          {detailGroups.map((group) =>
            group.kind === "single" ? (
              <MessageRow
                key={group.message.id}
                message={group.message}
                resultsByItemId={resultsByItemId}
                answersByItemId={answersByItemId}
              />
            ) : (
              <SubagentRow
                key={group.parent.id}
                agentToolUseId={group.parentItemId}
                agentName={group.agentName}
                prompt={group.prompt}
                modelRequested={group.modelRequested}
                children={group.children}
                summary={group.summary}
                resultsByItemId={resultsByItemId}
                answersByItemId={answersByItemId}
              />
            ),
          )}
        </div>
      ) : null}

      {finalAssistant !== null &&
      finalAssistant.content._tag === "assistant" ? (
        <div className="px-4 py-2">
          <div className="max-w-[88%]">
            <MarkdownBody>{finalAssistant.content.text}</MarkdownBody>
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 text-[11px]",
          mutedWhenOpen,
        )}
      >
        <span className="tabular-nums">{formatElapsed(duration)}</span>
        {finalAssistant !== null &&
        finalAssistant.content._tag === "assistant" ? (
          <CopyButton
            text={finalAssistant.content.text}
            label="Copy message"
            className="size-5 rounded opacity-70 hover:opacity-100"
          />
        ) : null}
        {fileStats.map((f) => (
          <FileBadge
            key={f.path}
            path={f.path}
            view="diff"
            diffStats={{ added: f.added, removed: f.removed }}
          />
        ))}
      </div>
    </div>
  );
}
