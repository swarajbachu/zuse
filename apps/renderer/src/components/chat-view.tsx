import { HugeiconsIcon } from "@hugeicons/react";
import { Message01Icon } from "@hugeicons-pro/core-bulk-rounded";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import type {
  AgentItemId,
  Message,
  MessageId,
  SessionId,
  UserQuestionAnswer,
} from "@zuse/wire";

import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListAnchoredEndSpace,
} from "../lib/chat-list-anchor.ts";
import {
  deriveChatTimelineRows,
  resolveLatestUserMessageId,
  rowAnchorMessageId,
  type ChatTimelineRow,
} from "../lib/chat-timeline-rows.ts";
import {
  getAnchoredTurnMetrics,
  resolveScrollableNodeIsAtEnd,
  shouldDeferAutomaticEndScroll,
  shouldRestoreAnchorScrollOffset,
  type TimelineScrollMode,
} from "../lib/timeline-scroll-anchoring.ts";
import {
  chatArchiveProgressLabel,
  type ChatArchiveProgressPhase,
  useChatsStore,
} from "../store/chats.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { teardownLiveStreams, useMessagesStore } from "../store/messages.ts";
import { usePermissionsStore } from "../store/permissions.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useSkillsStore } from "../store/skills.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { FileChipProvider } from "./file-chip.tsx";
import { useForkMenu } from "./fork-menu.tsx";
import { WorktreeSetupCard } from "./worktree-setup-card.tsx";
import {
  ErrorBubble,
  MessageRow,
  type ToolResultRecord,
} from "./message-row.tsx";
import { ChatLookupsProvider } from "./chat-lookups.tsx";
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
const TIMELINE_HEADER = (
  <>
    <WorktreeSetupCard />
    <div className="h-2" />
  </>
);
const TIMELINE_FOOTER = <div className="h-2" />;

interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

function resolveTimelineIsAtEnd(
  state: TimelineEndState | undefined,
): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
}

/**
 * Read-only timeline of one session. Subscribes to `messages.stream` via the
 * messages store on mount / session-change; the store owns the live fiber.
 * LegendList owns virtualization and measurement. This component owns the
 * chat-specific follow mode: initial land at the live edge, then anchor new
 * turns near the top until the user manually navigates away.
 */
export function ChatView({ sessionId }: { sessionId: SessionId }) {
  const forkMenu = useForkMenu();
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
  const externalResume = session !== null && session.resumeStrategy !== "none";
  const setupActive =
    worktreeSetupActive || (!externalResume && session?.status === "booting");
  const archiveProgress = useChatsStore((s) =>
    session?.chatId === undefined
      ? null
      : (s.archiveProgressByChat[session.chatId] ?? null),
  );

  const rows = useMemo(
    () =>
      deriveChatTimelineRows({
        messages,
        inFlight,
        awaitingPlanApproval,
      }),
    [awaitingPlanApproval, inFlight, messages],
  );

  const latestUserMessageId = useMemo(
    () => resolveLatestUserMessageId(rows),
    [rows],
  );
  const [timelineAnchorMessageId, setTimelineAnchorMessageId] = useState<
    string | null
  >(null);
  // Mirror for sync reads in free-scroll cancel / wheel handlers.
  const timelineAnchorMessageIdRef = useRef<string | null>(null);
  timelineAnchorMessageIdRef.current = timelineAnchorMessageId;
  const anchoredEndSpace = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(rows, timelineAnchorMessageId, (row) =>
        rowAnchorMessageId(row),
      ),
    [rows, timelineAnchorMessageId],
  );

  const listRef = useRef<LegendListRef | null>(null);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollModeRef =
    useRef<TimelineScrollMode>("following-end");
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const lastAnchoredUserMessageIdRef = useRef<string | null>(null);
  const latestUserMessageIdRef = useRef<string | null>(latestUserMessageId);
  latestUserMessageIdRef.current = latestUserMessageId;
  const pendingTimelineAnchorRef = useRef<string | null>(null);
  const positionedTimelineAnchorRef = useRef<string | null>(null);
  const settledTimelineAnchorRef = useRef<string | null>(null);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: string;
    readonly offset: number;
    readonly userNavigationGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  const userNavigationGenerationRef = useRef(0);
  const liveFollowGenerationRef = useRef<number | null>(0);
  const showPillTimerRef = useRef<number | null>(null);
  const isAtEndRef = useRef(true);
  const [showPill, setShowPill] = useState(false);
  useRegisterPane("chat", scrollElementRef);

  const clearShowPillTimer = useCallback(() => {
    if (showPillTimerRef.current !== null) {
      window.clearTimeout(showPillTimerRef.current);
      showPillTimerRef.current = null;
    }
  }, []);

  const hideJumpPill = useCallback(() => {
    clearShowPillTimer();
    setShowPill(false);
  }, [clearShowPillTimer]);

  const showJumpPillSoon = useCallback(() => {
    if (showPillTimerRef.current !== null) return;
    showPillTimerRef.current = window.setTimeout(() => {
      showPillTimerRef.current = null;
      setShowPill(true);
    }, 150);
  }, []);

  const showJumpPillIfScrollNodeLeftEnd = useCallback(() => {
    const scrollNode = listRef.current?.getScrollableNode();
    const isAtEnd = resolveScrollableNodeIsAtEnd(scrollNode);
    if (isAtEnd === false) {
      isAtEndRef.current = false;
      showJumpPillSoon();
    } else if (isAtEnd === true) {
      isAtEndRef.current = true;
      hideJumpPill();
    }
  }, [hideJumpPill, showJumpPillSoon]);

  // Cancel live follow on intentional navigation, then only show the jump
  // pill once the scroll node is meaningfully away from the live edge.
  // Never force-show on wheel/touch alone — tiny trackpad ticks used to
  // flash the pill even while still near the bottom.
  // Keep the turn anchor + positioned/settled markers: clearing the anchor
  // re-enables maintainScrollAtEnd and yanks to the live edge mid-stream;
  // clearing positioned lets handleAnchorReady re-run scrollToIndex and
  // pin the user prompt again while free-scrolling.
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    userNavigationGenerationRef.current += 1;
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowGenerationRef.current = null;
    pendingTimelineAnchorRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }

    // Lock markers so late ready/size callbacks no-op instead of re-pinning.
    const anchorId = timelineAnchorMessageIdRef.current;
    if (anchorId !== null) {
      positionedTimelineAnchorRef.current = anchorId;
      settledTimelineAnchorRef.current = anchorId;
    }

    // Interrupt any in-flight animated scrollToIndex from turn anchoring.
    const list = listRef.current;
    const offset = list?.getState().scroll;
    if (list !== null && list !== undefined && typeof offset === "number") {
      void list.scrollToOffset({ offset, animated: false });
    }

    requestAnimationFrame(showJumpPillIfScrollNodeLeftEnd);
  }, [showJumpPillIfScrollNodeLeftEnd]);

  const scrollToEnd = useCallback(
    (animated = false) => {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "following-end";
      liveFollowGenerationRef.current = userNavigationGenerationRef.current;
      pendingTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      // Keep the turn anchor + positioned/settled markers so Jump to latest
      // does not re-run scrollToIndex back to the user prompt, and so
      // maintainScrollAtEnd stays off for the rest of the session.
      pendingAnchorScrollRestoreRef.current = null;
      if (anchorScrollRestoreFrameRef.current !== null) {
        cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
        anchorScrollRestoreFrameRef.current = null;
      }
      lastAnchoredUserMessageIdRef.current = latestUserMessageIdRef.current;
      hideJumpPill();
      void listRef.current?.scrollToEnd({ animated });
    },
    [hideJumpPill],
  );

  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? listRef.current;
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || anchorIndex === null) {
        return null;
      }

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight: 0,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      });
    },
    [],
  );

  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? listRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || state.data.length === 0) {
        return false;
      }

      const lastRowIndex = state.data.length - 1;
      const lastRowTop = state.positionAtIndex(lastRowIndex);
      const lastRowHeight = state.sizeAtIndex(lastRowIndex);
      if (
        typeof lastRowTop !== "number" ||
        typeof lastRowHeight !== "number" ||
        !Number.isFinite(lastRowTop) ||
        !Number.isFinite(lastRowHeight)
      ) {
        return false;
      }

      const realContentBottom = lastRowTop + Math.max(1, lastRowHeight);
      const visibleScrollLength = Math.max(
        0,
        (state.scrollLength ?? 0) - CHAT_LIST_ANCHOR_OFFSET,
      );
      return realContentBottom > visibleScrollLength;
    },
    [],
  );

  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (info.anchorIndex === undefined) return;
      if (timelineAnchorMessageId !== null) {
        pendingTimelineAnchorRef.current =
          pendingTimelineAnchorRef.current === timelineAnchorMessageId
            ? null
            : pendingTimelineAnchorRef.current;
      }
      activeTimelineAnchorIndexRef.current = info.anchorIndex;
      if (
        timelineAnchorMessageId === null ||
        positionedTimelineAnchorRef.current === timelineAnchorMessageId
      ) {
        return;
      }
      // User already free-scrolled away — lock markers without re-pinning.
      if (timelineScrollModeRef.current === "free-scrolling") {
        positionedTimelineAnchorRef.current = timelineAnchorMessageId;
        settledTimelineAnchorRef.current = timelineAnchorMessageId;
        return;
      }
      positionedTimelineAnchorRef.current = timelineAnchorMessageId;
      settledTimelineAnchorRef.current = null;
      const messageId = timelineAnchorMessageId;
      const positioningGeneration = userNavigationGenerationRef.current;
      const positionAnchor = (remainingAttempts: number) => {
        requestAnimationFrame(() => {
          if (positionedTimelineAnchorRef.current !== messageId) return;
          if (timelineScrollModeRef.current === "free-scrolling") return;
          if (userNavigationGenerationRef.current !== positioningGeneration) {
            return;
          }

          const list = listRef.current;
          if (!list) {
            if (remainingAttempts > 0) positionAnchor(remainingAttempts - 1);
            return;
          }

          const scrollNode = list.getScrollableNode();
          let finished = false;
          let fallbackTimer = 0;
          const finishAnimatedPositioning = () => {
            if (finished) return;
            finished = true;
            window.clearTimeout(fallbackTimer);
            scrollNode?.removeEventListener(
              "scrollend",
              finishAnimatedPositioning,
            );
            if (positionedTimelineAnchorRef.current !== messageId) return;
            if (timelineScrollModeRef.current === "free-scrolling") return;
            if (userNavigationGenerationRef.current !== positioningGeneration) {
              return;
            }

            const scrollOffset = list.getState().scroll;
            void list.scrollToOffset({ offset: scrollOffset, animated: false });
            settledTimelineAnchorRef.current = messageId;
          };

          fallbackTimer = window.setTimeout(finishAnimatedPositioning, 750);
          scrollNode?.addEventListener("scrollend", finishAnimatedPositioning, {
            once: true,
          });
          void list.scrollToIndex({
            index: info.anchorIndex!,
            animated: true,
            viewPosition: 0,
            viewOffset: CHAT_LIST_ANCHOR_OFFSET,
          });
        });
      };
      requestAnimationFrame(() => positionAnchor(12));
    },
    [timelineAnchorMessageId],
  );

  const handleAnchorSizeChanged = useCallback((size: number) => {
    void size;
    const messageId = timelineAnchorMessageId;
    if (
      messageId === null ||
      settledTimelineAnchorRef.current !== messageId ||
      liveFollowGenerationRef.current === userNavigationGenerationRef.current
    ) {
      return;
    }

    const scrollOffset = listRef.current?.getState().scroll;
    if (scrollOffset === undefined) return;

    if (pendingAnchorScrollRestoreRef.current === null) {
      pendingAnchorScrollRestoreRef.current = {
        messageId,
        offset: scrollOffset,
        userNavigationGeneration: userNavigationGenerationRef.current,
      };
    }
    if (anchorScrollRestoreFrameRef.current !== null) return;

    anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
      anchorScrollRestoreFrameRef.current = null;
      const pending = pendingAnchorScrollRestoreRef.current;
      pendingAnchorScrollRestoreRef.current = null;
      const list = listRef.current;
      const currentOffset = list?.getState().scroll;
      if (
        list === null ||
        pending === null ||
        typeof currentOffset !== "number" ||
        !shouldRestoreAnchorScrollOffset({
          anchorId: pending.messageId,
          settledAnchorId: settledTimelineAnchorRef.current,
          expectedOffset: pending.offset,
          currentOffset,
          expectedUserNavigationGeneration: pending.userNavigationGeneration,
          currentUserNavigationGeneration: userNavigationGenerationRef.current,
        })
      ) {
        return;
      }

      void list.scrollToOffset({ offset: pending.offset, animated: false });
    });
  }, [timelineAnchorMessageId]);

  const handleScroll = useCallback(() => {
    const list = listRef.current;
    const nodeAtEnd = resolveScrollableNodeIsAtEnd(list?.getScrollableNode());
    const stateAtEnd = resolveTimelineIsAtEnd(list?.getState());
    const isAtEnd = nodeAtEnd ?? stateAtEnd;
    if (isAtEnd === undefined) return;

    if (
      !isAtEnd &&
      liveFollowGenerationRef.current === userNavigationGenerationRef.current
    ) {
      hideJumpPill();
      return;
    }

    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;

    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowGenerationRef.current = userNavigationGenerationRef.current;
      hideJumpPill();
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowGenerationRef.current = null;
      showJumpPillSoon();
    }
  }, [hideJumpPill, showJumpPillSoon]);

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

  useEffect(() => () => clearShowPillTimer(), [clearShowPillTimer]);

  useLayoutEffect(() => {
    const node = listRef.current?.getScrollableNode() ?? null;
    if (node instanceof HTMLDivElement) {
      node.dataset.pane = "chat";
      node.tabIndex = -1;
      scrollElementRef.current = node;
    } else {
      scrollElementRef.current = null;
    }
  }, [sessionId, rows.length]);

  // Session switch: always land at the live edge. Seed lastAnchored to the
  // current latest user message so reopening an in-flight chat does not look
  // like a brand-new send and re-pin the prompt to the top of the viewport.
  useEffect(() => {
    timelineScrollModeRef.current = "following-end";
    activeTimelineAnchorIndexRef.current = null;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
    setTimelineAnchorMessageId(null);
    lastAnchoredUserMessageIdRef.current = latestUserMessageIdRef.current;
    userNavigationGenerationRef.current = 0;
    liveFollowGenerationRef.current = 0;
    isAtEndRef.current = true;
    hideJumpPill();

    // key={sessionId} remounts the list with initialScrollAtEnd; also force
    // scrollToEnd after layout so hydration races still land at the live edge.
    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void listRef.current?.scrollToEnd({ animated: false });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [hideJumpPill, sessionId]);

  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attachListeners = (remainingAttempts: number) => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (!scrollNode) {
        if (remainingAttempts > 0) {
          frame = requestAnimationFrame(() =>
            attachListeners(remainingAttempts - 1),
          );
        }
        return;
      }
      if (scrollNode instanceof HTMLDivElement) {
        scrollNode.dataset.pane = "chat";
        scrollNode.tabIndex = -1;
        scrollElementRef.current = scrollNode;
      } else {
        scrollElementRef.current = null;
      }
      const handleManualNavigation = () => {
        cancelTimelineLiveFollowForUserNavigation();
      };
      scrollNode.addEventListener("wheel", handleManualNavigation, {
        passive: true,
      });
      scrollNode.addEventListener("touchmove", handleManualNavigation, {
        passive: true,
      });
      scrollNode.addEventListener("pointerdown", handleManualNavigation, {
        passive: true,
      });
      removeListeners = () => {
        scrollNode.removeEventListener("wheel", handleManualNavigation);
        scrollNode.removeEventListener("touchmove", handleManualNavigation);
        scrollNode.removeEventListener("pointerdown", handleManualNavigation);
      };
    };
    frame = requestAnimationFrame(() => attachListeners(30));

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [cancelTimelineLiveFollowForUserNavigation, sessionId]);

  // Anchor only when a *new* user message appears while this session is
  // already open. Session switch seeds lastAnchored so reopening never
  // re-triggers this path for an existing prompt.
  useEffect(() => {
    if (latestUserMessageId === null) return;
    const previousLatestUserMessageId = lastAnchoredUserMessageIdRef.current;
    if (previousLatestUserMessageId === latestUserMessageId) return;

    lastAnchoredUserMessageIdRef.current = latestUserMessageId;
    // Hydrating an idle transcript into an empty seed must not pin the
    // historical user message. A real first send sets inFlight around the
    // optimistic row and still anchors.
    if (previousLatestUserMessageId === null && !inFlight) return;

    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowGenerationRef.current = userNavigationGenerationRef.current;
    pendingTimelineAnchorRef.current = latestUserMessageId;
    activeTimelineAnchorIndexRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    setTimelineAnchorMessageId(latestUserMessageId);
    hideJumpPill();
  }, [hideJumpPill, inFlight, latestUserMessageId]);

  useEffect(() => {
    if (
      liveFollowGenerationRef.current !== userNavigationGenerationRef.current
    ) {
      return;
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (
          liveFollowGenerationRef.current !== userNavigationGenerationRef.current
        ) {
          return;
        }

        const list = listRef.current;
        if (!list) return;
        if (
          shouldDeferAutomaticEndScroll({
            pendingAnchorId: pendingTimelineAnchorRef.current,
            positionedAnchorId: positionedTimelineAnchorRef.current,
            settledAnchorId: settledTimelineAnchorRef.current,
          })
        ) {
          return;
        }

        if (timelineScrollModeRef.current === "anchoring-new-turn") {
          const metrics = getActiveTimelineTurnMetrics(list);
          if (!metrics || metrics.scrollDeltaToRevealEnd <= 1) return;

          const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd;
          void list.scrollToOffset({ offset: nextOffset, animated: false });
          return;
        }

        if (timelineScrollModeRef.current !== "following-end") return;
        if (!timelineRealContentOverflowsViewport(list)) return;
        void list.scrollToEnd({ animated: false });
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [getActiveTimelineTurnMetrics, rows, timelineRealContentOverflowsViewport]);

  // Pair tool_result rows back to their originating tool_use by AgentItemId.
  // The driver assigns the SDK's tool_use id to both events, so each
  // ToolRow can render its own result inline. We only record results that
  // have a preceding tool_use in this transcript so true orphans (e.g. a
  // dropped tool_use event) still fall through to a standalone error row
  // in MessageRow rather than disappearing silently.
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

  const chatLookups = useMemo(
    () => ({ resultsByItemId, answersByItemId }),
    [resultsByItemId, answersByItemId],
  );

  const renderTimelineRow = useCallback(
    ({ item }: { item: ChatTimelineRow }) => (
      <div className="mx-auto w-full max-w-4xl">
        <TimelineRow
          row={item}
          sessionId={sessionId}
          onFork={forkMenu.openAt}
        />
      </div>
    ),
    [forkMenu.openAt, sessionId],
  );

  return (
    <FileChipProvider
      folderId={session?.projectId ?? null}
      worktreeId={session?.worktreeId ?? null}
    >
      <div className="relative flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 flex-1 flex-col">
          {messages.length === 0 ? (
            <div
              data-pane="chat"
              tabIndex={-1}
              ref={scrollElementRef}
              className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto outline-none"
            >
              <WorktreeSetupCard />
              {setupActive ? null : (
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
              )}
            </div>
          ) : (
            <ChatLookupsProvider value={chatLookups}>
              <LegendList<ChatTimelineRow>
                key={sessionId}
                ref={listRef}
                data={rows}
                keyExtractor={(row) => row.id}
                getItemType={(row) => row.kind}
                renderItem={renderTimelineRow}
                estimatedItemSize={96}
                initialScrollAtEnd
                {...(anchoredEndSpace
                  ? {
                      anchoredEndSpace: {
                        ...anchoredEndSpace,
                        onReady: handleAnchorReady,
                        onSizeChanged: handleAnchorSizeChanged,
                      },
                    }
                  : {})}
                maintainScrollAtEnd={
                  anchoredEndSpace
                    ? false
                    : {
                        animated: false,
                        on: {
                          dataChange: true,
                          itemLayout: true,
                          layout: true,
                        },
                      }
                }
                maintainVisibleContentPosition={{ data: true, size: false }}
                onScroll={handleScroll}
                className="h-full min-h-0 flex-1 overflow-x-hidden px-3 outline-none [overflow-anchor:none]"
                data-pane="chat"
                tabIndex={-1}
                ListHeaderComponent={TIMELINE_HEADER}
                ListFooterComponent={TIMELINE_FOOTER}
              />
            </ChatLookupsProvider>
          )}
          {error !== null ? (
            <ErrorBubble
              error={error}
              sessionId={sessionId}
              onDismiss={() => clearError(sessionId)}
            />
          ) : null}
        </div>
        <JumpToLatestPill
          visible={showPill}
          streaming={inFlight && showPill}
          onClick={() => scrollToEnd(true)}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20">
          <div className="mx-auto flex w-full max-w-4xl justify-end px-3">
            <NextUnreadButton />
          </div>
        </div>
        {archiveProgress !== null ? (
          <ArchiveProgressOverlay phase={archiveProgress} />
        ) : null}
      </div>
      {forkMenu.menu}
    </FileChipProvider>
  );
}

function TimelineRow({
  row,
  sessionId,
  onFork,
}: {
  row: ChatTimelineRow;
  sessionId: SessionId;
  onFork: (
    event: MouseEvent,
    sourceSessionId: SessionId,
    fromMessageId: MessageId,
  ) => void;
}) {
  switch (row.kind) {
    case "message":
      return (
        <div
          className={
            row.enterUser
              ? "chat-row-enter chat-row-enter-user"
              : "chat-row-enter"
          }
          onContextMenu={
            row.message.content._tag === "user" ||
            row.message.content._tag === "user_rich" ||
            row.message.content._tag === "assistant"
              ? (event) => onFork(event, sessionId, row.message.id)
              : undefined
          }
        >
          <MessageRow message={row.message} sessionId={sessionId} />
        </div>
      );
    case "subagent":
      return (
        <div className="chat-row-enter">
          <SubagentRow
            agentToolUseId={row.parentItemId}
            agentName={row.agentName}
            prompt={row.prompt}
            modelRequested={row.modelRequested}
            children={row.children}
            summary={row.summary}
          />
        </div>
      );
    case "turn-summary":
      return (
        <div className="chat-row-enter">
          <TurnSummary body={row.body} />
        </div>
      );
    case "working":
      return <WorkingRow messages={row.messages} />;
  }
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
