import { useEffect, useState } from "react";

/**
 * The agent's cursor — an SVG arrow pointer overlaid on the browser pane.
 * Sibling to the `<webview>`, positioned absolutely with `pointer-events:
 * none` so it never eats real user clicks. Sits below the screenshot shutter
 * (`z-10`) and above the webview content (`z-5`).
 *
 * The cursor is driven by a sequence of "intents" the executor publishes
 * inside `browser-pane.tsx`. Each intent is an absolute coordinate to glide
 * toward (webview-relative CSS pixels) and an optional click pulse to fire
 * once the glide settles. CSS transitions handle the motion — a single
 * `transform: translate(x, y)` with a 350ms cubic-bezier ease.
 *
 * `prefers-reduced-motion` snaps instead of gliding. The click pulse still
 * fires either way because it's load-bearing feedback, not decoration: it's
 * how the user knows *where* on the page the agent just touched.
 */
export type AgentCursorIntent = {
  /** Monotonic — bump on every new intent so React re-runs the click effect. */
  readonly nonce: number;
  /** Webview-relative CSS pixels. */
  readonly x: number;
  readonly y: number;
  /** Show a click pulse at this position once the glide settles. */
  readonly click?: boolean;
  /** Show the cursor in a "pressed" state for the entire move (drag-style). */
  readonly pressed?: boolean;
};

export function AgentCursor({
  intent,
  visible,
}: {
  intent: AgentCursorIntent | null;
  visible: boolean;
}) {
  const [pulseKey, setPulseKey] = useState(0);
  const [pulseAt, setPulseAt] = useState<{ x: number; y: number } | null>(null);

  // Fire the click pulse after the glide settles. We schedule it a hair after
  // the transition duration so the ripple radiates from the *destination*, not
  // somewhere along the path. If the user has reduced motion on, snap+pulse
  // immediately.
  useEffect(() => {
    if (intent === null || intent.click !== true) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const delay = reduced ? 0 : GLIDE_MS;
    const t = window.setTimeout(() => {
      setPulseAt({ x: intent.x, y: intent.y });
      setPulseKey((n) => n + 1);
    }, delay);
    return () => window.clearTimeout(t);
  }, [intent]);

  if (!visible || intent === null) return null;

  return (
    <>
      <style>{CURSOR_CSS}</style>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[9] overflow-hidden"
      >
        <div
          className="memoize-agent-cursor"
          data-pressed={intent.pressed === true ? "true" : "false"}
          style={{
            transform: `translate(${intent.x}px, ${intent.y}px)`,
          }}
        >
          <CursorArrow />
        </div>
        {pulseAt !== null ? (
          <div
            key={pulseKey}
            className="memoize-agent-cursor-pulse"
            style={{ transform: `translate(${pulseAt.x}px, ${pulseAt.y}px)` }}
          />
        ) : null}
      </div>
    </>
  );
}

function CursorArrow() {
  // Clean modern pointer — single triangle with a soft concave underside, no
  // legacy "tail" line. White fill + dark outline reads on dark and light
  // pages equally. Tip sits at (1.5, 1.5) of the viewBox so the parent's
  // `translate(x, y)` lands the click point right at the tip with a ~2px
  // optical offset that matches what users expect from an OS cursor.
  return (
    <svg
      width="20"
      height="22"
      viewBox="0 0 20 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 2 L2 16.5 L6.5 13 L12 11.5 Z"
        fill="white"
        stroke="#0b0b0c"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

const GLIDE_MS = 350;

const CURSOR_CSS = `
.zuse-agent-cursor {
  position: absolute;
  top: 0;
  left: 0;
  width: 20px;
  height: 22px;
  will-change: transform;
  transition: transform ${GLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45));
}
.zuse-agent-cursor[data-pressed="true"] {
  transform-origin: 0 0;
}
@media (prefers-reduced-motion: reduce) {
  .zuse-agent-cursor {
    transition: none;
  }
}
.zuse-agent-cursor-pulse {
  position: absolute;
  top: 0;
  left: 0;
  width: 8px;
  height: 8px;
  margin: -4px 0 0 -4px;
  border-radius: 50%;
  background: rgba(180, 230, 0, 0.9);
  pointer-events: none;
  animation: memoize-agent-cursor-pulse 520ms ease-out forwards;
}
@keyframes memoize-agent-cursor-pulse {
  0%   { opacity: 0; box-shadow: 0 0 0 0 rgba(180, 230, 0, 0.55); }
  20%  { opacity: 1; }
  100% { opacity: 0; box-shadow: 0 0 0 26px rgba(180, 230, 0, 0); }
}
`;
