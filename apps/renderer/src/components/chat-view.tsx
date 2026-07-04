import { HugeiconsIcon } from "@hugeicons/react";
import { Message01Icon } from "@hugeicons-pro/core-bulk-rounded";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import type {
  AgentItemId,
  Message,
  SessionId,
  UserQuestionAnswer,
} from "@zuse/wire";

import { groupMessages } from "../lib/group-messages.ts";
import {
  chatArchiveProgressLabel,
  type ChatArchiveProgressPhase,
  useChatsStore,
} from "../store/chats.ts";
import { useChatScroll } from "../lib/use-chat-scroll.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { teardownLiveStreams, useMessagesStore } from "../store/messages.ts";
import { useChatMotionStore } from "../store/chat-motion.ts";
import { usePermissionsStore } from "../store/permissions.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useSkillsStore } from "../store/skills.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { FileChipProvider } from "./file-chip.tsx";
import { WorktreeSetupCard } from "./worktree-setup-card.tsx";
import {
  ErrorBubble,
  MessageRow,
  type ToolResultRecord,
} from "./message-row.tsx";
import { JumpToLatestPill } from "./jump-to-latest-pill.tsx";
import { SubagentRow } from "./subagent-row.tsx";
import { TurnSummary } from "./turn-summary.tsx";
import { NextUnreadButton } from "./next-unread-button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { Spinner } from "./ui/spinner";

// Stable empty-array reference for the selector below. Returning a fresh
// `[]` from a Zustand selector each call breaks `useSyncExternalStore`'s
// snapshot-equality check and triggers an infinite re-render loop.
const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

const isUserMessage = (m: Message | undefined): boolean =>
  m !== undefined &&
  (m.content._tag === "user" || m.content._tag === "user_rich");

type SendFlight = {
  readonly id: string;
  readonly text: string;
  readonly style: CSSProperties & {
    readonly "--chat-send-x": string;
    readonly "--chat-send-y": string;
  };
};

/**
 * Read-only timeline of one session. Subscribes to `messages.stream` via the
 * messages store on mount / session-change; the store owns the live fiber.
 * Scroll behavior is owned by `useChatScroll`: it anchors each new turn near
 * the top and follows the live edge only while the reader is there.
 */
export function ChatView({ sessionId }: { sessionId: SessionId }) {
  const messages = useMessagesStore(
    (s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const inFlight = useMessagesStore(
    (s) => s.runningBySession[sessionId] === true,
  );
  // While a plan sits awaiting approval the turn is technically still "running",
  // but the agent is blocked on the user — show no spinner, since we're the ones
  // waiting. The Approve/Cancel decision lives in the pinned PlanApprovalTray.
  const awaitingPlanApproval = usePermissionsStore((s) => {
    for (const req of Object.values(s.requestsById)) {
      if (req.sessionId !== sessionId) continue;
      if (req.kind._tag !== "Other") continue;
      if (req.kind.tool !== "ExitPlanMode") continue;
      return true;
    }
    return false;
  });
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
  const externalResume =
    session !== null && session.resumeStrategy !== "none";
  const setupActive =
    worktreeSetupActive || (!externalResume && session?.status === "booting");
  const archiveProgress = useChatsStore((s) =>
    session?.chatId === undefined
      ? null
      : (s.archiveProgressByChat[session.chatId] ?? null),
  );

  const {
    scrollRef,
    contentRef,
    sentinelRef,
    spacerRef,
    spacerHeight,
    showPill,
    streaming,
    jumpToLatest,
  } = useChatScroll({ sessionId, messages, inFlight });
  const pendingSendMotion = useChatMotionStore(
    (s) => s.pendingBySession[sessionId as string] ?? null,
  );
  const consumeSendMotion = useChatMotionStore((s) => s.consumeSend);
  const [sendFlight, setSendFlight] = useState<SendFlight | null>(null);
  useRegisterPane("chat", scrollRef);

  useEffect(() => {
    void hydrate(sessionId);
    void hydrateSkills(sessionId);
    // Tear down the live message fibers on unmount / session change. Without
    // this, the previous session's stream lingered until the next hydrate
    // tore it down, and a hydrate caught mid-await could install orphaned
    // fibers after the view was gone. `teardownLiveStreams` bumps the hydrate
    // epoch so any in-flight hydrate bails. The next hydrate re-subscribes;
    // `messagesBySession` is preserved, so there's no empty-state flash.
    return () => {
      void teardownLiveStreams();
    };
  }, [sessionId, hydrate, hydrateSkills]);

  useEffect(() => {
    if (pendingSendMotion === null) return;
    let latestUser: Message | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i]!;
      if (isUserMessage(candidate)) {
        latestUser = candidate;
        break;
      }
    }
    if (latestUser === null) return;
    if (latestUser.createdAt.getTime() + 1_000 < pendingSendMotion.createdAt) {
      return;
    }

    const content = contentRef.current;
    if (content === null) return;
    const anchor = content.querySelector<HTMLElement>(
      `[data-user-anchor="${CSS.escape(String(latestUser.id))}"]`,
    );
    if (anchor === null) return;
    const bubble =
      anchor.querySelector<HTMLElement>("[data-chat-user-bubble]") ?? anchor;
    const target = bubble.getBoundingClientRect();
    const source = pendingSendMotion.sourceRect;
    const fromLeft = source.left + 12;
    const fromTop = source.top + 8;
    setSendFlight({
      id: pendingSendMotion.id,
      text: pendingSendMotion.text,
      style: {
        left: fromLeft,
        top: fromTop,
        maxWidth: Math.max(160, Math.min(source.width - 24, 420)),
        "--chat-send-x": `${target.left - fromLeft}px`,
        "--chat-send-y": `${target.top - fromTop}px`,
      },
    });
    consumeSendMotion(sessionId, pendingSendMotion.id);
    const timeout = window.setTimeout(() => setSendFlight(null), 260);
    return () => window.clearTimeout(timeout);
  }, [
    contentRef,
    consumeSendMotion,
    messages,
    pendingSendMotion,
    sessionId,
  ]);

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
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-pane="chat"
          tabIndex={-1}
          className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto outline-none"
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
            <div ref={contentRef} className="flex flex-col py-2">
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
                      <div
                        data-user-anchor={turn.user.id}
                        className="chat-row-enter chat-row-enter-user scroll-mt-6"
                      >
                        <MessageRow
                          message={turn.user}
                          resultsByItemId={resultsByItemId}
                          answersByItemId={answersByItemId}
                          sessionId={sessionId}
                        />
                      </div>
                    ) : null}
                    {showSummary ? (
                      <>
                        {planMessages.map((m) => (
                          <div key={m.id} className="chat-row-enter">
                            <MessageRow
                              message={m}
                              resultsByItemId={resultsByItemId}
                              answersByItemId={answersByItemId}
                              sessionId={sessionId}
                            />
                          </div>
                        ))}
                        <div className="chat-row-enter">
                          <TurnSummary
                            body={summaryBody}
                            resultsByItemId={resultsByItemId}
                            answersByItemId={answersByItemId}
                          />
                        </div>
                      </>
                    ) : (
                      bodyGroups.map((group) =>
                        group.kind === "single" ? (
                          <div
                            key={group.message.id}
                            className="chat-row-enter"
                          >
                            <MessageRow
                              message={group.message}
                              resultsByItemId={resultsByItemId}
                              answersByItemId={answersByItemId}
                              sessionId={sessionId}
                            />
                          </div>
                        ) : (
                          <div
                            key={group.parent.id}
                            className="chat-row-enter"
                          >
                            <SubagentRow
                              agentToolUseId={group.parentItemId}
                              agentName={group.agentName}
                              prompt={group.prompt}
                              modelRequested={group.modelRequested}
                              children={group.children}
                              summary={group.summary}
                              resultsByItemId={resultsByItemId}
                              answersByItemId={answersByItemId}
                            />
                          </div>
                        ),
                      )
                    )}
                  </Fragment>
                );
              })}
              {inFlight && !awaitingPlanApproval && (
                <WorkingRow messages={messages} />
              )}
            </div>
          )}
          {error !== null && (
            <ErrorBubble
              error={error}
              sessionId={sessionId}
              onDismiss={() => clearError(sessionId)}
            />
          )}
          {/* Live-edge sentinel — must be the last child so it sits at the very
          bottom of the real content (before the spacer). */}
          <div ref={sentinelRef} aria-hidden className="h-px w-full shrink-0" />
          {/* Dynamic spacer: lets a freshly-sent turn be read from the top while
          its answer streams into the space below. */}
          <div
            ref={spacerRef}
            aria-hidden
            className="shrink-0"
            style={{ height: spacerHeight }}
          />
        </div>
        <JumpToLatestPill
          visible={showPill}
          streaming={streaming}
          onClick={jumpToLatest}
        />
        {sendFlight !== null ? (
          <div
            key={sendFlight.id}
            className="chat-send-flight fixed z-50 truncate rounded-2xl rounded-tr-sm bg-user-bubble px-3 py-2 text-sm text-user-bubble-foreground shadow-lg/20"
            style={sendFlight.style}
          >
            {sendFlight.text}
          </div>
        ) : null}
        <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex items-center gap-2">
          <NextUnreadButton />
        </div>
        {archiveProgress !== null ? (
          <ArchiveProgressOverlay phase={archiveProgress} />
        ) : null}
      </div>
    </FileChipProvider>
  );
}

function ArchiveProgressOverlay({
  phase,
}: {
  phase: ChatArchiveProgressPhase;
}) {
  const label = chatArchiveProgressLabel(phase);
  const detail =
    phase === "removing-dirty-worktree"
      ? "Discarding local changes and removing the checkout."
      : "Saving the chat to archives.";

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/72 px-6 backdrop-blur-sm">
      <div className="flex w-full max-w-sm items-center gap-3 rounded-lg border border-border/70 bg-popover px-4 py-3 text-popover-foreground shadow-lg/10">
        <Spinner className="size-5 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium text-sm">{label}</div>
          <div className="mt-1 text-muted-foreground text-xs">{detail}</div>
        </div>
      </div>
    </div>
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
      <ShimmerText tone="lime" className="tabular-nums">
        {formatElapsed(elapsed)}
      </ShimmerText>
    </div>
  );
}
