import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

import type { Message, SessionId } from "@zuse/wire";

// The reader counts as "at the bottom" while the viewport is within this many
// px of the true bottom. Our own pin writes land at distance 0, so following
// stays engaged; a genuine scroll-up grows the distance past this and releases.
const NEAR_BOTTOM_PX = 64;

export interface ChatScroll {
  /** The scrollable viewport. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Wraps every turn; observed for size changes (async layout shifts). */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Show the "Jump to latest" pill (reader has scrolled away from the bottom). */
  showPill: boolean;
  /** A response is streaming while the reader is scrolled away (drives the dot). */
  streaming: boolean;
  jumpToLatest: () => void;
}

/**
 * Minimal stick-to-bottom controller for the streaming chat timeline.
 *
 * The whole thing is derived from one measurement: the distance from the
 * bottom of the viewport. While that distance is within {@link NEAR_BOTTOM_PX}
 * we "follow" — pinning to the bottom as new content arrives. The instant the
 * reader scrolls up, the distance grows and following releases; because we read
 * position (never scroll deltas) and our own pin writes leave the distance at
 * ~0, there is no way for a programmatic scroll to be mistaken for user intent,
 * and a scroll-up always wins immediately. No sentinel, no spacer, no guard.
 */
export function useChatScroll(opts: {
  sessionId: SessionId;
  messages: ReadonlyArray<Message>;
  inFlight: boolean;
}): ChatScroll {
  const { sessionId, messages, inFlight } = opts;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // `stick` = follow-to-bottom engaged. Ref mirror for synchronous reads inside
  // effects/observers; state mirror so the pill can react to changes.
  const stickRef = useRef(true);
  const [stuck, setStuckState] = useState(true);
  const setStuck = useCallback((v: boolean) => {
    if (stickRef.current === v) return;
    stickRef.current = v;
    setStuckState(v);
  }, []);

  const prevSessionRef = useRef<SessionId>(sessionId);
  const didInitialScrollRef = useRef(false);

  const pin = useCallback((el: HTMLDivElement) => {
    // Instant — no smooth animation. Smooth writes fight rapid streaming updates.
    el.scrollTop = el.scrollHeight;
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    setStuck(true);
    pin(el);
  }, [pin, setStuck]);

  // --- Derive stickiness from scroll position on every scroll ---
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setStuck(distance <= NEAR_BOTTOM_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [sessionId, setStuck]);

  // --- Pin on async layout shifts (images, code blocks, markdown expanding) ---
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (el === null || content === null) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) pin(el);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [sessionId, pin]);

  // --- New content: land initially, reset on session switch, follow-pin ---
  useLayoutEffect(() => {
    // Session switch: reset to a fresh "follow + land at bottom" state.
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      stickRef.current = true;
      setStuckState(true);
      didInitialScrollRef.current = false;
    }

    const el = scrollRef.current;
    if (el === null) return;

    if (messages.length === 0) {
      didInitialScrollRef.current = true;
      return;
    }

    // First paint of a (possibly backfilled) transcript: land at the bottom.
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      pin(el);
      return;
    }

    // Streamed rows: pin only while following; otherwise let them arrive
    // offscreen without moving the reader.
    if (stickRef.current) pin(el);
  }, [sessionId, messages, pin]);

  return {
    scrollRef,
    contentRef,
    showPill: !stuck && messages.length > 0,
    streaming: inFlight && !stuck,
    jumpToLatest,
  };
}
