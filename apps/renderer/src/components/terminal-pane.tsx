import { type ReactNode, useEffect, useRef } from "react";

import type { ChatId } from "@zuse/contracts";

import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import * as terminalRegistry from "../lib/terminal-registry.ts";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import {
  EMPTY_TERMINALS,
  type TerminalInstance,
  terminalsKey,
  useTerminalsStore,
} from "../store/terminals.ts";

/**
 * Right-pane terminal host. Each right-dock terminal tab carries a
 * chat-relative `slot`; `TerminalSlotPane` resolves it against the active
 * chat's terminal list and mounts one `PtyTerminal`. The xterm + PTY live in
 * `terminal-registry.ts`, so unmounting (e.g. switching chats) detaches the
 * DOM but leaves the shell running — re-selecting the chat reconnects.
 */
function TerminalPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Renders a single terminal for one right-dock tab. The tab carries a
 * chat-relative `slot`; this resolves it to the active chat's Nth terminal
 * instance (seeding via `ensureSlot`) and mounts one `PtyTerminal`. The PTY's
 * cwd is the active workspace root, but the terminal LIST is owned by the
 * chat, so each chat keeps its own shells.
 */
export function TerminalSlotPane({ slot }: { slot: number }) {
  const ctx = useActiveContext();
  const chatId = useChatsStore((s) => s.selectedChatId);
  const ready = ctx.status === "ready" && !ctx.worktreePending;

  if (ctx.status === "loading") {
    return (
      <TerminalPlaceholder>
        <ShimmerText>Loading workspace…</ShimmerText>
      </TerminalPlaceholder>
    );
  }
  if (ctx.status === "empty") {
    return (
      <TerminalPlaceholder>
        No folder selected. Add or pick a folder on the left.
      </TerminalPlaceholder>
    );
  }
  if (ctx.worktreePending) {
    return (
      <TerminalPlaceholder>
        <ShimmerText>Preparing worktree…</ShimmerText>
      </TerminalPlaceholder>
    );
  }
  if (!ready || chatId === null) return null;
  return (
    <PlainTerminalSlot chatId={chatId} rootPath={ctx.rootPath} slot={slot} />
  );
}

function PlainTerminalSlot({
  chatId,
  rootPath,
  slot,
}: {
  chatId: ChatId;
  rootPath: string;
  slot: number;
}) {
  const key = terminalsKey(chatId);
  const list = useTerminalsStore((s) => s.byKey[key] ?? EMPTY_TERMINALS);
  const ensureSlot = useTerminalsStore((s) => s.ensureSlot);

  useEffect(() => {
    if (list.length <= slot) ensureSlot(key, slot, rootPath);
  }, [key, list.length, slot, ensureSlot, rootPath]);

  const inst = list[slot];
  if (inst === undefined) return null;
  return (
    <PtyTerminal cwd={inst.cwd} instanceId={inst.id} command={inst.command} />
  );
}

/**
 * Thin host for one terminal instance. The xterm + PTY live in
 * `terminal-registry.ts` keyed by `instanceId`; this just `attach`es the live
 * entry into its container on mount and `detach`es (NOT disposes) on unmount,
 * so the shell keeps running while its chat is in the background. The PTY is
 * only torn down on explicit close — see `useTerminalsStore.remove`.
 */
export function PtyTerminal({
  cwd,
  instanceId,
  command,
}: {
  cwd: string;
  instanceId: string;
  command?: TerminalInstance["command"];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    terminalRegistry.attach(instanceId, container, { cwd, command });
    return () => terminalRegistry.detach(instanceId);
    // `cwd`/`command` only matter on first open; reconnects reuse the live
    // entry, so the instance id is the sole identity that should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full min-w-0 overflow-hidden bg-background p-2"
    />
  );
}
