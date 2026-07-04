import type { SVGProps } from "react";

import type { ProviderId } from "@zuse/wire";

import { cn } from "~/lib/utils";
import { ClaudeIcon } from "./icons/claude-icon";
import { CodexIcon } from "./icons/codex-icon";
import { GeminiIcon } from "./icons/gemini-icon";
import { GrokIcon } from "./icons/grok-icon";

type ProviderIconProps = SVGProps<SVGSVGElement> & {
  providerId: ProviderId;
};

/**
 * OpenCode brand mark. We inline the official SVG from the opencode brand kit
 * and tint both paths via currentColor (the inner block at reduced opacity to
 * preserve the original two-tone look).
 */
function OpencodeBrandIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 240 300"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-3.5 shrink-0 fill-current", className)}
      aria-hidden="true"
      {...props}
    >
      <path d="M180 240H60V120H180V240Z" fillOpacity={0.45} />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" />
    </svg>
  );
}

/**
 * Cursor brand mark. We inline the official brand SVG and tint it to match the
 * surrounding text colour (foreground in light/dark themes).
 */
function CursorBrandIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 466.73 532.09"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-3.5 shrink-0 fill-current", className)}
      aria-hidden="true"
      {...props}
    >
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  );
}

/**
 * Provider glyph for Claude, Codex, Grok, Gemini, Cursor, and OpenCode
 * sessions. Every provider uses an inline brand SVG (real logos, no remote
 * downloads, tinted via currentColor). Default size matches the `size-3.5`
 * pattern used elsewhere in the sidebar/composer.
 */
export function ProviderIcon({
  providerId,
  className,
  ...props
}: ProviderIconProps) {
  const sized = cn("size-3.5 shrink-0", className);
  switch (providerId) {
    case "claude":
      return <ClaudeIcon className={sized} {...props} />;
    case "codex":
      return <CodexIcon className={sized} {...props} />;
    case "grok":
      return <GrokIcon className={sized} {...props} />;
    case "gemini":
      return <GeminiIcon className={sized} {...props} />;
    case "cursor":
      return <CursorBrandIcon className={className} {...props} />;
    case "opencode":
      return <OpencodeBrandIcon className={className} {...props} />;
  }
}
