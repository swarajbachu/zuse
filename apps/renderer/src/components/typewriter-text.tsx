import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const CHAR_MS = 28;

/**
 * Reveals `text` character-by-character when it changes. Skips animation on
 * first mount and when the user prefers reduced motion.
 */
export function TypewriterText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const mountedRef = useRef(false);
  const prevTextRef = useRef(text);
  const [displayed, setDisplayed] = useState(text);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevTextRef.current = text;
      setDisplayed(text);
      return;
    }
    if (text === prevTextRef.current) return;
    prevTextRef.current = text;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayed(text);
      return;
    }

    let index = 0;
    setDisplayed("");
    const timer = window.setInterval(() => {
      index += 1;
      setDisplayed(text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
      }
    }, CHAR_MS);
    return () => window.clearInterval(timer);
  }, [text]);

  return <span className={cn(className)}>{displayed}</span>;
}
