import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons-pro/core-bulk-rounded";
import {
  ArchiveArrowUpIcon,
  ArchiveIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { useEffect, useMemo, useState } from "react";
import { Effect } from "effect";

import type { Chat, FolderId } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";
import { useChatsStore } from "../store/chats.ts";
import { useUiStore } from "../store/ui.ts";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

const formatDate = (date: Date): string =>
  date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });

export function ArchivedChatsPage({
  projectId,
  projectName,
}: {
  projectId: FolderId | null;
  projectName: string;
}) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<ReadonlyArray<Chat>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unarchive = useChatsStore((s) => s.unarchive);
  const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);

  const load = async () => {
    if (projectId === null) {
      setArchived([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const client = await getRpcClient();
      const chats = await Effect.runPromise(
        client["chat.list"]({ projectId, includeArchived: true }),
      );
      setArchived(
        chats
          .filter((chat) => chat.archivedAt !== null)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return archived;
    return archived.filter((chat) => chat.title.toLowerCase().includes(needle));
  }, [archived, query]);

  const onRestore = async (chat: Chat) => {
    await unarchive(chat.id);
    setArchived((rows) => rows.filter((row) => row.id !== chat.id));
    setActiveMainTab("chat");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background/55">
      <div className="border-b border-border/50 px-8 py-5">
        <div className="flex items-center gap-3">
          <HugeiconsIcon
            icon={ArchiveIcon}
            className="size-5 text-muted-foreground"
          />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-foreground">
              Archived chats
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {projectName}
            </p>
          </div>
        </div>
        <label className="mt-5 flex h-9 max-w-xl items-center gap-2 rounded-md border border-border/70 bg-background px-3 text-sm">
          <HugeiconsIcon
            icon={Search01Icon}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter archived chats..."
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
        {projectId === null ? (
          <EmptyState text="Select a repository to view archived chats." />
        ) : loading ? (
          <EmptyState text="Loading archived chats..." loading />
        ) : error !== null ? (
          <EmptyState text={error} />
        ) : filtered.length === 0 ? (
          <EmptyState
            text={
              query.trim().length > 0
                ? "No archived chats match that filter."
                : "No archived chats in this repository."
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border/45">
            {filtered.map((chat) => (
              <li
                key={chat.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-1 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {chat.title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Archived{" "}
                    {chat.archivedAt === null
                      ? formatDate(chat.updatedAt)
                      : formatDate(chat.archivedAt)}
                  </p>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatDate(chat.updatedAt)}
                </span>
                <Button
                  variant="settings"
                  size="sm"
                  onClick={() => void onRestore(chat)}
                >
                  <HugeiconsIcon
                    icon={ArchiveArrowUpIcon}
                    className="size-3.5"
                  />
                  Unarchive
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  text,
  loading = false,
}: {
  text: string;
  loading?: boolean;
}) {
  return (
    <div className="flex h-full min-h-64 items-center justify-center text-sm text-muted-foreground">
      {loading ? <ShimmerText>{text}</ShimmerText> : text}
    </div>
  );
}
