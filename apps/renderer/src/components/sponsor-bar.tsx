import { classify } from "@adtention/sdk";
import { useEffect } from "react";

import type { SessionId, SponsorCategory } from "@zuse/contracts";

import { openExternal } from "../lib/use-provider-login.ts";
import { useMessagesStore } from "../store/messages.ts";
import { useSponsorStore } from "../store/sponsor.ts";

/**
 * One sponsored line (ADtention) in the composer footer's wait state. Serving
 * lives in `store/sponsor.ts` (and, under it, the server) — this component only
 * derives a targeting category from the latest prompt, asks the store to
 * refresh, and renders the result. Keeping no serve state here means the
 * shell's frequent remounts of this component neither lose the ad nor re-serve.
 */

// Targeting category, derived from the user's most recent prompt rather than
// the project's files: Zuse is general-purpose, so the repo's stack is a
// poor proxy for what the user is doing this turn. `classify` runs fully
// on-device (keyword heuristics, no network); only the resulting tag is sent
// to the server. Falls back to "general" when there's no prompt yet or the
// text is too sparse to classify.
const categoryFromLatestPrompt = (
  sessionId: SessionId | null,
): SponsorCategory => {
  if (sessionId === null) return "general";
  const msgs = useMessagesStore.getState().messagesBySession[sessionId] ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i]!.content;
    if (c._tag === "user_rich" || c._tag === "user") {
      // `classify` returns the SDK's category union, which today matches our
      // wire `SponsorCategory` exactly. The cast bridges the two type names; if
      // the SDK ever adds a category our wire union doesn't have, the RPC payload
      // schema rejects it and the serve degrades to no ad (never throws).
      return classify(c.text) as SponsorCategory;
    }
  }
  return "general";
};

interface SponsorBarProps {
  sessionId: SessionId | null;
}

export function SponsorBar({ sessionId }: SponsorBarProps) {
  const line = useSponsorStore((s) => s.line);
  const refresh = useSponsorStore((s) => s.refresh);

  // Refresh once per *completed* turn (and on session switch / mount). The
  // trigger key is session + latest user message id, but we only serve when the
  // session is idle: while a turn is in flight, `messagesBySession` reconciles
  // the optimistic and streamed user message, so the "last user message id"
  // thrashes between the previous and current prompt. Serving on every flip
  // would loop (and the server dwell-cache would freeze the line). Waiting for
  // the turn to settle gives one clean serve with the stable prompt id — and,
  // being well past the ~15s dwell window, a genuinely fresh ad.
  const latestUserMsgId = useMessagesStore((s) => {
    const msgs =
      sessionId !== null ? s.messagesBySession[sessionId] : undefined;
    if (msgs === undefined) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const c = msgs[i]!.content;
      if (c._tag === "user_rich" || c._tag === "user") return msgs[i]!.id;
    }
    return null;
  });
  const running = useMessagesStore((s) =>
    sessionId !== null ? s.runningBySession[sessionId] === true : false,
  );

  useEffect(() => {
    if (running) return;
    refresh(
      `${sessionId ?? ""}:${latestUserMsgId ?? ""}`,
      categoryFromLatestPrompt(sessionId),
    );
  }, [sessionId, latestUserMsgId, running, refresh]);

  if (line === null) return null;

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border bg-background px-3 py-1.5 text-xs">
      <span className="rounded border border-border px-1 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Sponsored
      </span>
      {line.clickUrl !== null ? (
        <button
          type="button"
          onClick={() => openExternal(line.clickUrl!)}
          title={line.clickUrl}
          aria-label={`Sponsored: ${line.text} (opens in browser)`}
          className="group min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 hover:text-foreground"
        >
          {line.text}
          <span
            aria-hidden
            className="ml-1 text-muted-foreground/60 group-hover:text-foreground"
          >
            ↗
          </span>
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-foreground/80">
          {line.text}
        </span>
      )}
    </div>
  );
}
