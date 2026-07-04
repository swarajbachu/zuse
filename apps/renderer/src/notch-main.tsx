import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";

import type { NotchTrayItem, NotchTrayItemState } from "./lib/bridge.ts";
import { cn } from "./lib/utils.ts";

const STATE_LABEL: Record<NotchTrayItemState, string> = {
  permission: "Permission",
  question: "Question",
  planReady: "Plan ready",
  failed: "Failed",
  completed: "Done",
  running: "Running",
};

const STATE_CLASS: Record<NotchTrayItemState, string> = {
  permission: "bg-warning",
  question: "bg-info",
  planReady: "bg-primary",
  failed: "bg-destructive",
  completed: "bg-success",
  running: "bg-muted-foreground",
};

const STATE_RING: Record<NotchTrayItemState, string> = {
  permission: "border-warning/45",
  question: "border-info/45",
  planReady: "border-primary/45",
  failed: "border-destructive/45",
  completed: "border-success/45",
  running: "border-white/20",
};

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

  const visibleItems = useMemo(() => items.slice(0, 8), [items]);
  const compactItems = visibleItems.slice(0, 7);

  return (
    <main
      className="flex h-full w-full items-start justify-center text-foreground"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <section
        className={cn(
          "w-60 overflow-hidden rounded-b-[18px] border-x border-b border-white/[0.06] bg-black text-white shadow-lg shadow-black/25 backdrop-blur-xl transition-[opacity,transform] duration-200 ease-out",
          expanded ? "h-full" : "h-[66px]",
          items.length === 0 && !expanded && "opacity-80",
        )}
      >
        <div className="flex h-[66px] items-end justify-center gap-1.5 px-4 pb-3">
          {compactItems.length === 0 ? (
            <span className="mb-0.5 size-1 rounded-full bg-white/24" />
          ) : (
            compactItems.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={`${STATE_LABEL[item.state]}: ${item.title}`}
                onClick={() => notch?.openChat(item.chatId, item.sessionId)}
                className={cn(
                  "size-2 rounded-full border transition-transform duration-200 ease-out hover:scale-125",
                  STATE_CLASS[item.state],
                  STATE_RING[item.state],
                  item.state === "running" && "animate-pulse",
                )}
              />
            ))
          )}
        </div>

        {expanded && (
          <div className="animate-in fade-in slide-in-from-top-1 flex flex-col gap-px border-t border-white/[0.055] px-1.5 py-2 duration-200">
            {visibleItems.length === 0 ? (
              <div className="flex h-14 items-center justify-center text-[11px] font-medium text-white/38">
                No notifications
              </div>
            ) : (
              visibleItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => notch?.openChat(item.chatId, item.sessionId)}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 hover:bg-white/[0.07]"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full border",
                      STATE_CLASS[item.state],
                      STATE_RING[item.state],
                      item.state === "running" && "animate-pulse",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium leading-none text-white/88">
                      {item.title}
                    </span>
                  </span>
                  <span className="max-w-16 shrink-0 truncate text-[10px] font-medium leading-none text-white/42">
                    {item.label}
                  </span>
                </button>
              ))
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
