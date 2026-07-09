import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Privacy-aware email pill. Blurs the address by default so screen recordings
 * and screenshots don't leak it; click toggles reveal/hide.
 */
export function BlurredEmail({ email }: { email: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setRevealed((r) => !r);
      }}
      title={revealed ? "Click to hide" : "Click to reveal"}
      aria-label={revealed ? "Hide email" : "Reveal email"}
      className={cn(
        "inline-block max-w-[16rem] cursor-pointer truncate rounded bg-muted/40 px-1 py-0.5 text-left font-mono text-[11px] text-foreground transition-[filter,background-color] duration-150",
        revealed ? "" : "blur-[5px] select-none hover:blur-[3px]",
      )}
    >
      {email}
    </span>
  );
}
