import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Robot01Icon } from "@hugeicons-pro/core-bulk-rounded";
import type { Message, SessionId } from "@zuse/contracts";
import { useMemo } from "react";

import { groupMessages, type RenderGroup } from "~/lib/group-messages";
import { isToolActivityMessage } from "~/lib/tool-activity";
import { useChatsStore } from "~/store/chats";
import { useMessagesStore } from "~/store/messages";
import { useUiStore } from "~/store/ui";

import { MessageRow } from "./message-row";
import { ToolGroup } from "./tool-group";

type DetachedGroup = Extract<RenderGroup, { readonly kind: "subagent" }> & {
  readonly childSessionId: string;
};

const detachedGroups = (messages: ReadonlyArray<Message>): DetachedGroup[] =>
  groupMessages(messages).flatMap((group) =>
    group.kind === "subagent" &&
    group.presentation === "detached" &&
    group.childSessionId !== undefined
      ? [{ ...group, childSessionId: group.childSessionId }]
      : [],
  );

const formatAge = (date: Date): string => {
  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
};

export function SubagentsPane({
  sessionId,
}: {
  readonly sessionId: SessionId | null;
}) {
  const messages = useMessagesStore((state) =>
    sessionId === null ? [] : (state.messagesBySession[sessionId] ?? []),
  );
  const chatId = useChatsStore((state) => state.selectedChatId);
  const selectedId = useUiStore((state) =>
    chatId === null ? null : (state.selectedSubagentByChat[chatId] ?? null),
  );
  const selectSubagent = useUiStore((state) => state.selectSubagent);
  const groups = useMemo(() => detachedGroups(messages), [messages]);
  const selected =
    groups.find((group) => group.childSessionId === selectedId) ?? null;

  if (selected !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <button
            type="button"
            aria-label="Back to subagents"
            onClick={() => selectSubagent(null)}
            className="grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline focus-visible:outline-1"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
          </button>
          <HugeiconsIcon
            icon={Robot01Icon}
            className="size-4 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {selected.agentName}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <SubagentTranscript messages={selected.children} />
          {selected.summary?.text ? (
            <MessageRow
              message={{
                ...selected.parent,
                id: `${selected.parent.id}:summary` as Message["id"],
                content: { _tag: "assistant", text: selected.summary.text },
              }}
            />
          ) : null}
        </div>
      </div>
    );
  }

  const active = groups.filter((group) => group.summary === null);
  const done = groups.filter((group) => group.summary !== null);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
      <AgentSection title="Active" groups={active} onSelect={selectSubagent} />
      <AgentSection
        title={`Done · ${done.length}`}
        groups={done}
        onSelect={selectSubagent}
      />
      {groups.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">
          Detached subagents will appear here.
        </p>
      ) : null}
    </div>
  );
}

function AgentSection({
  title,
  groups,
  onSelect,
}: {
  readonly title: string;
  readonly groups: ReadonlyArray<DetachedGroup>;
  readonly onSelect: (id: string | null) => void;
}) {
  if (groups.length === 0 && title.startsWith("Done")) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-2 px-2 text-xs text-muted-foreground">{title}</h2>
      {groups.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground/70">
          No active subagents
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {groups.map((group) => {
            const latest =
              group.children.at(-1)?.createdAt ?? group.parent.createdAt;
            const detail = group.summary?.text || group.prompt || "Working…";
            return (
              <button
                key={group.childSessionId}
                type="button"
                onClick={() => onSelect(group.childSessionId)}
                className="flex min-h-14 w-full items-start gap-2.5 rounded px-2 py-2 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-1"
              >
                <HugeiconsIcon
                  icon={Robot01Icon}
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground/90">
                    {group.agentName}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {detail}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                  {formatAge(latest)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SubagentTranscript({
  messages,
}: {
  readonly messages: ReadonlyArray<Message>;
}) {
  const rows: React.ReactNode[] = [];
  let tools: Message[] = [];
  const flush = () => {
    if (tools.length === 0) return;
    const batch = tools;
    tools = [];
    const first = batch[0];
    if (first !== undefined) {
      rows.push(<ToolGroup key={`tools:${first.id}`} messages={batch} />);
    }
  };
  for (const message of messages) {
    if (isToolActivityMessage(message)) {
      tools.push(message);
      continue;
    }
    flush();
    rows.push(<MessageRow key={message.id} message={message} />);
  }
  flush();
  return rows;
}
