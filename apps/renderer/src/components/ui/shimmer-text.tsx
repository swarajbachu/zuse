import { GradientShimmer, type GradientStop } from "gradient-shimmer";
import type React from "react";
import { usePrefersReducedMotion } from "~/hooks/use-media-query";

/**
 * `muted` — a soft near-white highlight that brightens the text's own (usually
 * muted) color; the default for plain loading/status text.
 * `lime` — the theme lime accent, reserved for agent-activity text (Thinking,
 * tool inline hints) so the eye reads "the agent is working".
 *
 * Only the highlight band is specified — `GradientShimmer`'s `baseColor`
 * defaults to `currentColor`, so the sweep fades back into whatever color the
 * call site already uses. That keeps each site's resting look unchanged.
 */
type ShimmerTone = "muted" | "lime";

const TONE_STOPS: Record<ShimmerTone, GradientStop[]> = {
  muted: [{ position: 0.5, color: "oklch(0.97 0.004 260)" }],
  lime: [{ position: 0.5, color: "hsl(72 98% 54%)" }],
};

type ShimmerTextProps = {
  /** Plain string only — the gradient sweeps over it. */
  children: string;
  tone?: ShimmerTone;
  className?: string;
  as?: React.ElementType;
  style?: React.CSSProperties;
};

/**
 * Animated gradient shimmer for pending/loading status text. Wraps the
 * `gradient-shimmer` package with project-themed defaults so call sites stay a
 * drop-in for a `<span>`. Use only while a state is actually pending; render
 * plain text for done/error states.
 *
 * Under `prefers-reduced-motion` we render static text (not even the package's
 * static gradient) so the resting color is identical to what it replaced.
 */
export function ShimmerText({
  children,
  tone = "muted",
  className,
  as: As = "span",
  style,
}: ShimmerTextProps): React.ReactElement {
  const reduced = usePrefersReducedMotion();

  if (reduced) {
    return (
      <As className={className} style={style}>
        {children}
      </As>
    );
  }

  return (
    <GradientShimmer
      gradient={TONE_STOPS[tone]}
      easing="smooth"
      duration={1.5}
      spread={5}
      angle={105}
      pauseBetween={350}
      as={As}
      className={className}
      style={style}
    >
      {children}
    </GradientShimmer>
  );
}
