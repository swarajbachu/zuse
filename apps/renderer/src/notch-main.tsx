import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";

import type { NotchTrayItem, NotchTrayItemState } from "./lib/bridge.ts";
import { formatRelativeTime, useRelativeTimeTick } from "./lib/use-relative-time.ts";
import { cn } from "./lib/utils.ts";

const STATE_LABEL: Record<NotchTrayItemState, string> = {
  permission: "Permission",
  question: "Question",
  planReady: "Plan ready",
  failed: "Failed",
  completed: "Done",
  running: "Running",
};

/** Fill color for each state's status dot. */
const STATE_DOT: Record<NotchTrayItemState, string> = {
  permission: "bg-warning",
  question: "bg-info",
  planReady: "bg-primary",
  failed: "bg-destructive",
  completed: "bg-success",
  running: "bg-white/60",
};

/** Colored halo ring, applied only to states that need the user. */
const STATE_HALO: Record<NotchTrayItemState, string> = {
  permission: "ring-2 ring-warning/35",
  question: "ring-2 ring-info/35",
  planReady: "ring-2 ring-primary/30",
  failed: "ring-2 ring-destructive/30",
  completed: "",
  running: "",
};

/** States that block the user and deserve visual weight in the collapsed cap. */
const NEEDS_YOU: ReadonlySet<NotchTrayItemState> = new Set<NotchTrayItemState>([
  "permission",
  "question",
  "planReady",
  "failed",
]);

/** States that gently pulse to draw the eye. */
const PULSES: ReadonlySet<NotchTrayItemState> = new Set<NotchTrayItemState>([
  "permission",
  "question",
  "running",
]);

const MAX_COMPACT_DOTS = 6;
const MAX_ROWS = 8;

const isState = (value: unknown): value is NotchTrayItemState =>
  value === "running" ||
  value === "completed" ||
  value === "failed" ||
  value === "planReady" ||
  value === "question" ||
  value === "permission";

const sanitizeItems = (raw: unknown): ReadonlyArray<NotchTrayItem> => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.id !== "string" ||
      typeof obj.chatId !== "string" ||
      typeof obj.sessionId !== "string" ||
      typeof obj.title !== "string" ||
      typeof obj.subtitle !== "string" ||
      typeof obj.label !== "string" ||
      typeof obj.updatedAt !== "number" ||
      !isState(obj.state)
    ) {
      return [];
    }
    return [
      {
        id: obj.id,
        chatId: obj.chatId,
        sessionId: obj.sessionId,
        title: obj.title,
        subtitle: obj.subtitle,
        state: obj.state,
        label: obj.label,
        updatedAt: obj.updatedAt,
      },
    ];
  });
};

function NotchTray() {
  const notch = window.zuse?.notch ?? window.memoize?.notch;
  const [items, setItems] = useState<ReadonlyArray<NotchTrayItem>>([]);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;
  const now = useRelativeTimeTick(15_000);

  useEffect(() => {
    const unsubItems = notch?.onItems?.((next) => {
      setItems(sanitizeItems(next));
    });
    const unsubPinned = notch?.onPinned?.((next) => setPinned(next));
    return () => {
      unsubItems?.();
      unsubPinned?.();
    };
  }, [notch]);

  useEffect(() => {
    notch?.setExpanded?.(expanded);
  }, [expanded, notch]);

  const compactDots = useMemo(() => items.slice(0, MAX_COMPACT_DOTS), [items]);
  const compactOverflow = Math.max(0, items.length - MAX_COMPACT_DOTS);
  const rows = useMemo(() => items.slice(0, MAX_ROWS), [items]);
  const rowOverflow = Math.max(0, items.length - MAX_ROWS);

  return (
    <main
      className="flex h-full w-full items-start justify-center text-foreground"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <section
        className={cn(
          "w-60 overflow-hidden rounded-b-[18px] border-x border-b border-white/[0.07] bg-black text-white shadow-lg shadow-black/30 backdrop-blur-xl transition-[height] duration-200 ease-out",
          expanded ? "h-full" : "h-[66px]",
        )}
      >
        {/* Cap: the strip below the physical notch. Always present (whisper). */}
        <div className="flex h-[66px] items-end justify-center gap-[7px] px-4 pb-[13px]">
          {compactDots.length === 0 ? (
            <span className="mb-[3px] size-[3px] rounded-full bg-white/25" />
          ) : (
            <>
              {compactDots.map((item) => {
                const needsYou = NEEDS_YOU.has(item.state);
                return (
                  <span
                    key={item.id}
                    aria-label={`${STATE_LABEL[item.state]}: ${item.title}`}
                    className={cn(
                      "shrink-0 rounded-full transition-all duration-200 ease-out",
                      STATE_DOT[item.state],
                      STATE_HALO[item.state],
                      needsYou ? "size-[7px]" : "size-[5px]",
                      PULSES.has(item.state) &&
                        "animate-pulse motion-reduce:animate-none",
                    )}
                  />
                );
              })}
              {compactOverflow > 0 && (
                <span className="mb-[1px] text-[9px] font-semibold leading-none text-white/45">
                  +{compactOverflow}
                </span>
              )}
            </>
          )}
        </div>

        {/* Expanded list: dot + title + relative time, one line per agent. */}
        {expanded && (
          <div className="animate-in fade-in slide-in-from-top-1 flex flex-col gap-px border-t border-white/[0.06] px-1.5 pb-2 pt-1.5 duration-200">
            {rows.length === 0 ? (
              <div className="flex h-12 items-center justify-center text-[11px] font-medium text-white/35">
                All quiet
              </div>
            ) : (
              <>
                {rows.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => notch?.openChat(item.chatId, item.sessionId)}
                    style={{ animationDelay: `${index * 28}ms` }}
                    className="animate-in fade-in slide-in-from-top-1 flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left duration-200 fill-mode-backwards hover:bg-white/[0.07]"
                  >
                    <span
                      className={cn(
                        "size-[7px] shrink-0 rounded-full",
                        STATE_DOT[item.state],
                        STATE_HALO[item.state],
                        item.state === "running" &&
                          "animate-pulse motion-reduce:animate-none",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium leading-none text-white/[0.88]">
                      {item.title}
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-medium leading-none text-white/35 tabular-nums">
                      {formatRelativeTime(item.updatedAt, now) ?? ""}
                    </span>
                  </button>
                ))}
                {rowOverflow > 0 && (
                  <div className="px-2 pt-1 text-[10px] font-medium leading-none text-white/35">
                    +{rowOverflow} more
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing in notch.html");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <NotchTray />
  </React.StrictMode>,
);
