/**
 * Camera-shutter flash overlaid on the browser pane when the agent takes a
 * screenshot. Purely decorative — `pointer-events:none` so it never eats
 * clicks. Keyed by a nonce the executor bumps right after `capturePage()`
 * resolves; bumping the key remounts the element so the CSS animation
 * replays every shot.
 *
 * Respects `prefers-reduced-motion`: the keyframes collapse to a single brief
 * dim instead of a white flash + scale for users who opt out of motion.
 */
export function BrowserShutter({ nonce }: { nonce: number }) {
  // nonce === 0 is the initial mount — nothing has been captured yet, so
  // render nothing (avoids a stray flash on first paint).
  if (nonce === 0) return null;
  return (
    <>
      <style>{SHUTTER_CSS}</style>
      <div
        key={nonce}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 memoize-browser-shutter"
      />
    </>
  );
}

const SHUTTER_CSS = `
@keyframes memoize-shutter-flash {
  0%   { opacity: 0; transform: scale(1.04); }
  8%   { opacity: 0.85; }
  100% { opacity: 0; transform: scale(1); }
}
@keyframes memoize-shutter-dim {
  0%   { opacity: 0; }
  20%  { opacity: 0.4; }
  100% { opacity: 0; }
}
.zuse-browser-shutter {
  background: white;
  animation: memoize-shutter-flash 420ms ease-out forwards;
}
@media (prefers-reduced-motion: reduce) {
  .zuse-browser-shutter {
    background: black;
    animation: memoize-shutter-dim 320ms ease-out forwards;
  }
}
`;
