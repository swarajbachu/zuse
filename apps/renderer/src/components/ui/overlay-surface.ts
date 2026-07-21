/**
 * Shared surface recipes for overlays that can't use the Base UI primitives
 * (CodeMirror-anchored popovers, hand-rolled palettes). Keep in sync with the
 * popup styling in `menu.tsx` / `popover.tsx` so every floating panel shares
 * one visual language.
 */
export const overlaySurface = "rounded-2xl bg-glass border-glass text-popover-foreground";

/** Larger opaque panels (palettes, modals) — no glass, deeper elevation. */
export const overlayPanelSurface =
  "rounded-2xl bg-popover text-popover-foreground shadow-overlay-lg dark:border dark:border-white/10";

/** Interactive row inside an overlay (mirrors MenuItem geometry). */
export const overlayItem =
  "flex min-h-7 cursor-default select-none items-center gap-2 rounded-lg px-2 text-sm outline-none";
