import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ClipboardIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import type { AgentItemId, Message } from "@zuse/contracts";
import { memo, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui";

import { CopyButton } from "./copy-button.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import { MessageRow } from "./message-row.tsx";
import { Spinner } from "./ui/spinner";
import { SubagentAvatar } from "./subagent-identity";

const MODEL_LABEL: Record<string, string> = {
  "claude-sonnet-5": "Sonnet 5",
  "claude-fable-5": "Fable 5",
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};

const AGENT_ACTIVITY_WINDOW_MS = 10_000;

const labelForModel = (model: string | undefined): string => {
  if (!model) return "inherit";
  return MODEL_LABEL[model] ?? model;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms - min * 60_000) / 1000);
  return `${min}m ${sec}s`;
};

/**
 * Wrapper row for a sub-agent run. Visually mirrors `tool-row.tsx`'s
 * `ExpandableIconRow` (icon → label → detail → expandable body) so the
 * sub-agent collapses into the timeline cleanly. The body renders a
 * `Prompt` summary at the top followed by nested `MessageRow`s for every
 * message tagged with this `parentItemId`. Closes with the sub-agent's
 * final assistant text once the `SubagentSummary` lands.
 *
 * Sub-agent rows stay collapsed by default, including while running, so long
 * nested agent work does not dominate the main transcript.
 */
function SubagentRowImpl({
  agentToolUseId,
  agentName,
  prompt,
  modelRequested,
  childSessionId,
  presentation,
  children,
  summary,
  readOnly = false,
}: {
  readonly agentToolUseId: AgentItemId;
  readonly agentName: string;
  readonly prompt: string;
  readonly modelRequested: string | undefined;
  readonly childSessionId: string | undefined;
  readonly presentation: "inline" | "detached";
  readonly children: ReadonlyArray<Message>;
  readonly summary: {
    readonly text: string;
    readonly turns: number;
    readonly durationMs: number;
    readonly model: string;
    readonly isError: boolean;
  } | null;
  readonly readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealSubagent = useUiStore((state) => state.revealSubagent);

  const trailingMeta = useMemo(() => {
    if (summary !== null) {
      return `${labelForModel(summary.model)} · ${summary.turns} turn${summary.turns === 1 ? "" : "s"} · ${formatDuration(summary.durationMs)}`;
    }
    return labelForModel(modelRequested);
  }, [summary, modelRequested]);

  const latestChildAt = useMemo(() => {
    let latest = 0;
    for (const child of children) {
      latest = Math.max(latest, child.createdAt.getTime());
    }
    return latest;
  }, [children]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (summary !== null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [summary]);

  const showActivityLoader =
    summary === null &&
    (latestChildAt === 0 || now - latestChildAt < AGENT_ACTIVITY_WINDOW_MS);

  void agentToolUseId; // reserved for future deeplink anchor

  return (
    <div className="px-4">
      <button
        type="button"
        onClick={() => {
          if (
            !readOnly &&
            presentation === "detached" &&
            childSessionId !== undefined
          ) {
            revealSubagent(childSessionId);
            return;
          }
          setExpanded((e) => !e);
        }}
        className={cn(
          "group flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs",
          "hover:bg-muted/40 cursor-pointer",
        )}
      >
        <div className="relative grid size-5 shrink-0 place-items-center">
          {showActivityLoader ? (
            <>
              <SubagentAvatar name={agentName} size="sm" />
              <Spinner
                className="absolute -inset-0.5 size-6 text-muted-foreground"
                aria-label="Agent running"
              />
            </>
          ) : (
            <SubagentAvatar name={agentName} size="sm" />
          )}
        </div>
        <span className="shrink-0 font-medium text-foreground/90">
          {agentName}
        </span>
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 truncate text-muted-foreground",
            summary?.isError && "text-red-300",
          )}
        >
          <span className="min-w-0 truncate">{trailingMeta}</span>
        </span>
      </button>
      {expanded && (presentation === "inline" || readOnly) ? (
        <div className="ml-7 mt-1 border-l border-border/60 pl-3">
          <PromptRow text={prompt} />
          <div className="flex flex-col">
            {children.map((m) => (
              <MessageRow key={m.id} message={m} readOnly={readOnly} />
            ))}
          </div>
          {summary !== null && summary.text.length > 0 ? (
            <div className="px-4 py-1">
              <MarkdownBody className="text-xs">{summary.text}</MarkdownBody>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const SubagentRow = memo(SubagentRowImpl);
SubagentRow.displayName = "SubagentRow";

function PromptRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;
  return (
    <div className="px-4 pt-1">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          "group flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs",
          "hover:bg-muted/40 cursor-pointer",
        )}
      >
        <div className="relative grid size-4 shrink-0 place-items-center">
          <HugeiconsIcon
            icon={ClipboardIcon}
            strokeWidth={2}
            aria-hidden="true"
            className={cn(
              "col-start-1 row-start-1 size-3.5 text-muted-foreground transition-opacity duration-150 ease-out",
              "group-hover:opacity-0 motion-reduce:transition-none",
            )}
          />
          <HugeiconsIcon
            icon={chevron}
            aria-hidden="true"
            className={cn(
              "col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out",
              "group-hover:opacity-100 motion-reduce:transition-none",
            )}
          />
        </div>
        <span className="shrink-0 font-medium text-foreground/90">Prompt</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {text}
        </span>
      </button>
      {expanded ? (
        <div className="ml-7 mt-1 max-w-2xl border-l border-border/60 pl-3 pr-1">
          <div className="group/prompt relative">
            <CopyButton
              text={text}
              label="Copy prompt"
              className="absolute right-1.5 top-1.5 opacity-60 hover:opacity-100 focus-visible:opacity-100"
            />
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-message-rule bg-message-pre-bg px-3 py-2 pr-9 font-mono text-[11px] text-foreground/80">
              {text || "(empty)"}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
