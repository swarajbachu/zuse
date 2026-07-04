import fuzzysort from "fuzzysort";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Chat, FolderId } from "@zuse/wire";

import { cn } from "~/lib/utils";
import { useChatsStore } from "../store/chats.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";

/**
 * Cross-project chat quick-switcher (Cmd+K). Lists every non-archived chat
 * across every project; fuzzy-search by chat title or project name, then jump
 * with Enter. Selecting a chat in another project automatically switches the
 * active project too — that's handled inside `useChatsStore.select`, so this
 * component just decides *which* chat and calls it.
 *
 * Modeled on the keyboard-list pattern in `composer/slash-command-popover.tsx`
 * (fuzzysort + arrow-key highlight) but presented as a centered modal.
 */
export function ChatSwitcher() {
  const open = useUiStore((s) => s.chatSwitcherOpen);
  if (!open) return null;
  return <ChatSwitcherInner />;
}

interface Row {
  readonly chat: Chat;
  readonly projectId: FolderId;
  readonly projectName: string;
  /** Pre-lowercased title used for the empty-query recents label / fuzzy keys. */
  readonly title: string;
}

const recencyOf = (chat: Chat): number =>
  (chat.lastMessageAt ?? chat.updatedAt ?? chat.createdAt).getTime();

function ChatSwitcherInner() {
  const folders = useWorkspaceStore((s) => s.folders);
  const chatsByProject = useChatsStore((s) => s.chatsByProject);
  const selectedChatId = useChatsStore((s) => s.selectedChatId);

  const close = () => useUiStore.getState().setChatSwitcherOpen(false);

  // Restore focus to wherever the user was when they opened the switcher,
  // but only when they dismiss without picking (selecting navigates focus).
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      // no-op cleanup; explicit restore happens in `dismiss`.
    };
  }, []);

  // All non-archived chats across all projects, with their project name.
  const allRows = useMemo<ReadonlyArray<Row>>(() => {
    const projectName = new Map<FolderId, string>(
      folders.map((f) => [f.id, f.name]),
    );
    const rows: Row[] = [];
    for (const [pid, chats] of Object.entries(chatsByProject)) {
      const folderId = pid as FolderId;
      for (const chat of chats) {
        if (chat.archivedAt !== null) continue;
        rows.push({
          chat,
          projectId: folderId,
          projectName: projectName.get(folderId) ?? "Unknown project",
          title: chat.title.length > 0 ? chat.title : "New chat",
        });
      }
    }
    return rows;
  }, [folders, chatsByProject]);

  const [query, setQuery] = useState("");

  const rows = useMemo<ReadonlyArray<Row>>(() => {
    if (query.trim().length === 0) {
      // Recents first across all projects.
      return allRows
        .slice()
        .sort((a, b) => recencyOf(b.chat) - recencyOf(a.chat));
    }
    const ranked = fuzzysort.go(query, allRows, {
      keys: ["title", "projectName"],
      threshold: 0.3,
      limit: 50,
    });
    return ranked.map((r) => r.obj);
  }, [allRows, query]);

  const [highlight, setHighlight] = useState(0);
  useEffect(() => setHighlight(0), [rows]);

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    itemRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const dismiss = () => {
    close();
    prevFocusRef.current?.focus?.();
  };

  const confirm = (row: Row | undefined) => {
    if (row === undefined) return;
    close();
    useChatsStore.getState().select(row.chat.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        return;
      }
      if (rows.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => (h + 1) % rows.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => (h - 1 + rows.length) % rows.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        confirm(rows[highlight]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, highlight]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 px-4 py-[12vh] backdrop-blur-sm"
      onMouseDown={dismiss}
    >
      <div
        role="dialog"
        aria-label="Switch chat"
        className="flex h-fit max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats across all projects…"
          className="w-full shrink-0 border-b border-border/60 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No chats found.
            </p>
          ) : (
            rows.map((row, i) => {
              const active = i === highlight;
              const isCurrent = row.chat.id === selectedChatId;
              return (
                <button
                  key={row.chat.id}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => confirm(row)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {row.title}
                  </span>
                  {isCurrent && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      current
                    </span>
                  )}
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    {row.projectName}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
