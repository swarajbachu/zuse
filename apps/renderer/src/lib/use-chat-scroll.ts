import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

import type { Message, SessionId } from "@zuse/wire";

// How far below the top of the viewport a freshly-sent user message lands, so
// the tail of the previous turn stays visible above it (principle 6).
const TOP_GAP = 24;
// The sentinel counts as "at the live edge" while it sits within this many px
// of the bottom of the scroll viewport.
const LIVE_EDGE_BAND_PX = 80;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const isUserMessage = (m: Message | undefined): boolean =>
  m !== undefined &&
  (m.content._tag === "user" || m.content._tag === "user_rich");

export interface ChatScroll {
  /** The scrollable viewport. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Wraps every turn; observed for size changes. */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Zero-height marker after the last real message; drives live-edge detection. */
  sentinelRef: RefObject<HTMLDivElement | null>;
  /** Dynamic bottom spacer that lets a short answer be read from the top. */
  spacerRef: RefObject<HTMLDivElement | null>;
  spacerHeight: number;
  /** Show the "Jump to latest" pill (reader has scrolled away from the edge). */
  showPill: boolean;
  /** A response is streaming out of view (drives the pill's activity dot). */
  streaming: boolean;
  jumpToLatest: () => void;
}

/**
 * Scroll controller for the streaming chat timeline. Honors the "great
 * streaming chat" principles: never moves the reader against their intent
 * (1-3), anchors each new turn near the top so the answer streams into the
 * space below (4-7), surfaces offscreen activity (8), offers a jump-to-latest
 * affordance (9), preserves position across layout shifts (12), and never lets
 * an interruption / error steal scroll position (13).
 *
 * Live-edge detection uses an IntersectionObserver on a bottom sentinel rather
 * than scroll math, so it stays correct even while the dynamic spacer is
 * present. "Following" (stick-to-bottom) is mirrored in a ref so event handlers
 * and layout effects read the latest value synchronously.
 */
export function useChatScroll(opts: {
  sessionId: SessionId;
  messages: ReadonlyArray<Message>;
  inFlight: boolean;
}): ChatScroll {
  const { sessionId, messages, inFlight } = opts;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);

  // `following` = stick-to-bottom engaged. Ref mirror for synchronous reads.
  const followingRef = useRef(true);
  const [, setFollowingState] = useState(true);
  const setFollowing = useCallback((v: boolean) => {
    if (followingRef.current === v) return;
    followingRef.current = v;
    setFollowingState(v);
  }, []);

  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const [spacerHeight, setSpacerHeight] = useState(0);
  const setSpacer = useCallback((px: number) => {
    setSpacerHeight((prev) => (prev === px ? prev : px));
  }, []);

  // Bookkeeping refs (synchronous; safe to read inside effects/handlers).
  const prevSessionRef = useRef<SessionId>(sessionId);
  const didInitialScrollRef = useRef(false);
  const lastAnchoredUserIdRef = useRef<Message["id"] | null>(null);
  // True while a freshly-sent turn is top-anchored (drives spacer sizing).
  const anchorModeRef = useRef(false);
  // Guards our own scroll writes from being mis-read as user intent.
  const programmaticRef = useRef(false);

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    // Clear after the resulting scroll event has fired (two frames is plenty
    // for an instant scroll; smooth scrolls only move downward, which the
    // intent listener ignores anyway).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
    });
  }, []);

  // Size the spacer so the anchored user message can sit TOP_GAP from the top
  // even when the answer is shorter than the viewport. Shrinks to 0 as the
  // answer grows past the available space.
  const recomputeSpacer = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const id = lastAnchoredUserIdRef.current;
    if (
      el === null ||
      content === null ||
      !anchorModeRef.current ||
      id === null
    )
      return;
    const anchor = content.querySelector<HTMLElement>(
      `[data-user-anchor="${CSS.escape(String(id))}"]`,
    );
    if (anchor === null) return;
    const anchorTop =
      anchor.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const belowAnchor = content.offsetHeight - anchorTop;
    setSpacer(Math.max(0, el.clientHeight - TOP_GAP - belowAnchor));
  }, [setSpacer]);

  const jumpToLatest = useCallback(() => {
    anchorModeRef.current = false;
    setSpacer(0);
    setFollowing(true);
    // Collapse the spacer on this paint, then scroll to the true bottom.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el === null) return;
      markProgrammatic();
      el.scrollTo({
        top: el.scrollHeight,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
  }, [markProgrammatic, setFollowing, setSpacer]);

  // --- Live-edge detection + re-engage (IntersectionObserver on sentinel) ---
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (root === null || sentinel === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        const edge = entry.isIntersecting;
        setAtLiveEdge(edge);
        // Reaching the edge via a user scroll resumes following. Our own
        // programmatic scrolls (jump-to-latest, pin) are guarded out.
        if (edge && !programmaticRef.current) {
          anchorModeRef.current = false;
          setSpacer(0);
          setFollowing(true);
        }
      },
      { root, rootMargin: `0px 0px ${LIVE_EDGE_BAND_PX}px 0px`, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sessionId, setFollowing, setSpacer]);

  // --- Disengage on a genuine upward user scroll ---
  // A user scroll-up decreases scrollTop; content growth does not, so this
  // never fires from streaming or from our own pinning (which is guarded).
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const cur = el.scrollTop;
      const delta = cur - lastTop;
      lastTop = cur;
      if (programmaticRef.current || delta >= -2) return;
      const sentinel = sentinelRef.current;
      if (sentinel === null) {
        setFollowing(false);
        return;
      }
      const dist =
        sentinel.getBoundingClientRect().bottom -
        el.getBoundingClientRect().bottom;
      if (dist > LIVE_EDGE_BAND_PX) setFollowing(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [sessionId, setFollowing]);

  // --- Selecting text inside the transcript is reading intent (principle 3) ---
  useEffect(() => {
    const onSelect = () => {
      const sel = document.getSelection();
      if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return;
      const el = scrollRef.current;
      const node = sel.anchorNode;
      if (el !== null && node !== null && el.contains(node))
        setFollowing(false);
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, [setFollowing]);

  // --- Keep position across layout shifts (images, code, markdown expanding) ---
  // While following, re-pin to the bottom; while anchored, resize the spacer.
  // (Reading position when not following is preserved by Chromium's native
  // `overflow-anchor`, which we never disable.)
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (content === null || el === null) return;
    const ro = new ResizeObserver(() => {
      if (followingRef.current) {
        markProgrammatic();
        el.scrollTop = el.scrollHeight;
      } else if (anchorModeRef.current) {
        recomputeSpacer();
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [sessionId, markProgrammatic, recomputeSpacer]);

  // --- React to new messages: initial land, new-turn anchor, follow-pin ---
  useLayoutEffect(() => {
    // Session switch: reset to a fresh "follow + land at bottom" state.
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      followingRef.current = true;
      setFollowingState(true);
      didInitialScrollRef.current = false;
      anchorModeRef.current = false;
      lastAnchoredUserIdRef.current = null;
      setSpacer(0);
      setAtLiveEdge(true);
    }

    const el = scrollRef.current;
    const content = contentRef.current;
    if (el === null) return;

    if (messages.length === 0) {
      didInitialScrollRef.current = true;
      return;
    }
    const last = messages[messages.length - 1]!;

    // First paint of a (possibly backfilled) transcript: land at the bottom
    // and record the newest user id so history never triggers a top-anchor.
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (isUserMessage(messages[i])) {
          lastAnchoredUserIdRef.current = messages[i]!.id;
          break;
        }
      }
      markProgrammatic();
      el.scrollTop = el.scrollHeight;
      return;
    }

    // A brand-new user turn: anchor it near the top, open space below for the
    // answer, and stop following so the reader stays at the top of the answer.
    if (isUserMessage(last) && last.id !== lastAnchoredUserIdRef.current) {
      lastAnchoredUserIdRef.current = last.id;
      anchorModeRef.current = true;
      followingRef.current = false;
      setFollowingState(false);
      if (content !== null) {
        const anchor = content.querySelector<HTMLElement>(
          `[data-user-anchor="${CSS.escape(String(last.id))}"]`,
        );
        if (anchor !== null) {
          const anchorTop =
            anchor.getBoundingClientRect().top -
            content.getBoundingClientRect().top;
          const belowAnchor = content.offsetHeight - anchorTop;
          const next = Math.max(0, el.clientHeight - TOP_GAP - belowAnchor);
          // Apply synchronously so scrollIntoView has room to reach the top.
          if (spacerRef.current !== null)
            spacerRef.current.style.height = `${next}px`;
          setSpacer(next);
          markProgrammatic();
          anchor.scrollIntoView({ block: "start", behavior: "auto" });
        }
      }
      return;
    }

    // Streamed rows (assistant / thinking / tool): pin to bottom only while
    // following; otherwise let them arrive offscreen without moving the reader.
    if (followingRef.current) {
      markProgrammatic();
      el.scrollTop = el.scrollHeight;
    } else if (anchorModeRef.current) {
      recomputeSpacer();
    }
  }, [sessionId, messages, markProgrammatic, recomputeSpacer, setSpacer]);

  return {
    scrollRef,
    contentRef,
    sentinelRef,
    spacerRef,
    spacerHeight,
    showPill: !atLiveEdge && messages.length > 0,
    streaming: inFlight && !atLiveEdge,
    jumpToLatest,
  };
}
