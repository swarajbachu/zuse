import { HugeiconsIcon } from "@hugeicons/react";
import { Message01Icon } from "@hugeicons-pro/core-bulk-rounded";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentItemId,
  Message,
  SessionId,
  UserQuestionAnswer,
} from "@memoize/wire";

import { groupMessages } from "../lib/group-messages.ts";
import { useMessagesStore } from "../store/messages.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useSkillsStore } from "../store/skills.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { FileChipProvider } from "./file-chip.tsx";
import { WorktreeSetupCard } from "./worktree-setup-card.tsx";
import { ErrorBubble, MessageRow, type ToolResultRecord } from "./message-row.tsx";
import { SubagentRow } from "./subagent-row.tsx";
import { TurnSummary } from "./turn-summary.tsx";
import { Spinner } from "./ui/spinner";

const NEAR_BOTTOM_PX = 80;

// Stable empty-array reference for the selector below. Returning a fresh
// `[]` from a Zustand selector each call breaks `useSyncExternalStore`'s
// snapshot-equality check and triggers an infinite re-render loop.
const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

/**
 * Read-only timeline of one session. Subscribes to `messages.stream` via the
 * messages store on mount / session-change; the store owns the live fiber.
 * Auto-scrolls to bottom on new messages unless the user has scrolled up out
 * of the "near-bottom" band.
 */
export function ChatView({ sessionId }: { sessionId: SessionId }) {
  const messages = useMessagesStore(
    (s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const inFlight = useMessagesStore(
    (s) => s.runningBySession[sessionId] === true,
  );
  const error = useMessagesStore((s) => s.errorBySession[sessionId] ?? null);
  const clearError = useMessagesStore((s) => s.clearError);
  const hydrate = useMessagesStore((s) => s.hydrate);
  const hydrateSkills = useSkillsStore((s) => s.hydrate);

  const session = useSessionsStore((s) => {
    for (const list of Object.values(s.sessionsByProject)) {
      const match = list.find((session) => session.id === sessionId);
      if (match !== undefined) return match;
    }
    return null;
  });

  // While this session's worktree is still being set up — or the provider
  // CLI is still booting — the inline setup card carries the "what's
  // happening" message, so suppress the empty "New chat" placeholder under it.
  const worktreeId = session?.worktreeId ?? null;
  const worktreeSetupActive = useWorktreesStore((s) => {
    if (worktreeId === null) return false;
    for (const list of Object.values(s.byProject)) {
      const wt = (list ?? EMPTY_WORKTREES).find((w) => w.id === worktreeId);
      if (wt !== undefined) {
        return (
          wt.setupStatus === "running" ||
          wt.setupStatus === "pending" ||
          wt.setupStatus === "failed"
        );
      }
    }
    return false;
  });
  const setupActive = worktreeSetupActive || session?.status === "booting";

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    void hydrate(sessionId);
    void hydrateSkills(sessionId);
  }, [sessionId, hydrate, hydrateSkills]);

  // Track whether the user is near the bottom of the timeline; if they
  // scroll up, we stop auto-scrolling so reading older context isn't
  // disrupted by streaming new replies.
  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < NEAR_BOTTOM_PX;
  };

  useLayoutEffect(() => {
    // A message the user just sent always re-engages auto-scroll, even if
    // they had scrolled up to read older context.
    const last = messages[messages.length - 1];
    if (
      last?.content._tag === "user" ||
      last?.content._tag === "user_rich"
    ) {
      stickToBottomRef.current = true;
    }
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Pair tool_result rows back to their originating tool_use by AgentItemId.
  // The driver assigns the SDK's tool_use id to both events, so each
  // ToolRow can render its own result inline. We only record results that
  // have a preceding tool_use in this transcript so true orphans (e.g. a
  // dropped tool_use event) still fall through to a standalone error row
  // in MessageRow rather than disappearing silently.
  // Split the flat message stream into turns: each turn is one user message
  // (or null for an open response with no preceding user msg) plus every
  // assistant / thinking / tool message that follows until the next user
  // message. Used to wrap completed turns in a TurnSummary card.
  const turns = useMemo(() => {
    const out: Array<{
      user: Message | null;
      body: Message[];
    }> = [];
    let current: { user: Message | null; body: Message[] } | null = null;
    for (const m of messages) {
      if (m.content._tag === "user" || m.content._tag === "user_rich") {
        if (current !== null) out.push(current);
        current = { user: m, body: [] };
      } else {
        if (current === null) current = { user: null, body: [] };
        current.body.push(m);
      }
    }
    if (current !== null) out.push(current);
    return out;
  }, [messages]);

  const resultsByItemId = useMemo(() => {
    const seenUseIds = new Set<AgentItemId>();
    const map = new Map<AgentItemId, ToolResultRecord>();
    for (const m of messages) {
      if (m.content._tag === "tool_use") {
        seenUseIds.add(m.content.itemId);
      } else if (
        m.content._tag === "tool_result" &&
        seenUseIds.has(m.content.itemId)
      ) {
        map.set(m.content.itemId, {
          output: m.content.output,
          isError: m.content.isError,
        });
      }
    }
    return map;
  }, [messages]);

  // Pair `user_question_answer` rows back to their originating
  // `user_question` by itemId so the `UserInputRow` can render Q + A as one
  // accordion. Mirrors `resultsByItemId`. Pending (unanswered) questions
  // stay absent from this map — `MessageRow` returns null for them and the
  // composer slot owns the live interaction.
  const answersByItemId = useMemo(() => {
    const seenQuestionIds = new Set<AgentItemId>();
    const map = new Map<AgentItemId, ReadonlyArray<UserQuestionAnswer>>();
    for (const m of messages) {
      if (m.content._tag === "user_question") {
        seenQuestionIds.add(m.content.itemId);
      } else if (
        m.content._tag === "user_question_answer" &&
        seenQuestionIds.has(m.content.itemId)
      ) {
        map.set(m.content.itemId, m.content.answers);
      }
    }
    return map;
  }, [messages]);


  return (
    <FileChipProvider
      folderId={session?.projectId ?? null}
      worktreeId={session?.worktreeId ?? null}
    >
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <WorktreeSetupCard />
      {messages.length === 0 ? (
        setupActive ? null : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <HugeiconsIcon
              icon={Message01Icon}
              className="size-10 opacity-40"
            />
            <div>
              <p className="text-sm">{session?.title ?? "New chat"}</p>
              <p className="mt-1 text-xs">
                Type a message below to get started.
              </p>
            </div>
          </div>
        )
      ) : (
        <div className="flex flex-col py-2">
          {turns.map((turn, idx) => {
            const isLastTurn = idx === turns.length - 1;
            const isLive = inFlight && isLastTurn;
            const hasToolCalls = turn.body.some(
              (m) => m.content._tag === "tool_use",
            );
            // Only collapse into a summary when there's a final assistant
            // message worth showing as the body — otherwise a turn with
            // just tool calls would lose its content behind the accordion.
            const hasFinalText = turn.body.some(
              (m) =>
                m.content._tag === "assistant" &&
                m.content.text.trim().length > 0,
            );
            const showSummary = !isLive && hasToolCalls && hasFinalText;
            const turnKey = turn.user?.id ?? `turn-${idx}`;
            // Within an open (non-collapsed) turn, group sub-agent rows
            // under a SubagentRow wrapper. TurnSummary handles its own
            // rendering for collapsed turns; sub-agents inside a collapsed
            // turn render via TurnSummary's existing path.
            const bodyGroups = groupMessages(turn.body);
            // Hoist ExitPlanMode rows out of TurnSummary so the Plan card
            // (and its resolved accordion) stays a top-level row in
            // scrollback — it's a user-facing decision, not just another
            // tool call to bury in the "N tool calls" rollup.
            const planMessages = turn.body.filter(
              (m) =>
                m.content._tag === "tool_use" &&
                m.content.tool === "ExitPlanMode",
            );
            const planItemIds = new Set(
              planMessages.flatMap((m) =>
                m.content._tag === "tool_use" ? [m.content.itemId] : [],
              ),
            );
            const summaryBody =
              planMessages.length === 0
                ? turn.body
                : turn.body.filter((m) => {
                    if (
                      m.content._tag === "tool_use" &&
                      m.content.tool === "ExitPlanMode"
                    ) {
                      return false;
                    }
                    if (
                      m.content._tag === "tool_result" &&
                      planItemIds.has(m.content.itemId)
                    ) {
                      return false;
                    }
                    return true;
                  });
            return (
              <Fragment key={turnKey}>
                {turn.user !== null ? (
                  <MessageRow
                    message={turn.user}
                    resultsByItemId={resultsByItemId}
                    answersByItemId={answersByItemId}
                    sessionId={sessionId}
                  />
                ) : null}
                {showSummary ? (
                  <>
                    {planMessages.map((m) => (
                      <MessageRow
                        key={m.id}
                        message={m}
                        resultsByItemId={resultsByItemId}
                        answersByItemId={answersByItemId}
                        sessionId={sessionId}
                      />
                    ))}
                    <TurnSummary
                      body={summaryBody}
                      resultsByItemId={resultsByItemId}
                      answersByItemId={answersByItemId}
                    />
                  </>
                ) : (
                  bodyGroups.map((group) =>
                    group.kind === "single" ? (
                      <MessageRow
                        key={group.message.id}
                        message={group.message}
                        resultsByItemId={resultsByItemId}
                        answersByItemId={answersByItemId}
                        sessionId={sessionId}
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
                  )
                )}
              </Fragment>
            );
          })}
          {inFlight && <WorkingRow messages={messages} />}
        </div>
      )}
      {error !== null && (
        <ErrorBubble
          error={error}
          sessionId={sessionId}
          onDismiss={() => clearError(sessionId)}
        />
      )}
    </div>
    </FileChipProvider>
  );
}

const formatElapsed = (ms: number): string => {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `${min}m ${sec.toFixed(1)}s`;
};

function WorkingRow({ messages }: { messages: ReadonlyArray<Message> }) {
  // Anchor to the most recent user message — we want the live "current turn"
  // elapsed time beside the loader, not the session-wide total.
  const anchorMs = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.content._tag === "user" || m.content._tag === "user_rich")
        return m.createdAt.getTime();
    }
    return null;
  }, [messages]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tickId = window.setInterval(() => setNow(Date.now()), 100);
    return () => {
      window.clearInterval(tickId);
    };
  }, []);

  const elapsed = anchorMs === null ? 0 : Math.max(0, now - anchorMs);

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-[11px] text-muted-foreground">
      <Spinner className="size-3" />
      <span className="tabular-nums">{formatElapsed(elapsed)}</span>
    </div>
  );
}
