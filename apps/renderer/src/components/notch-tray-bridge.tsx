import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatId, SessionId } from "@zuse/contracts";

import {
  buildNotchItems,
  noteCompletedSessions,
  pruneRecentCompletions,
  type RecentCompletion,
} from "~/lib/notch-items.ts";
import { useChatsStore } from "~/store/chats.ts";
import { useMessagesStore } from "~/store/messages.ts";
import { usePermissionsStore } from "~/store/permissions.ts";
import { useSessionsStore } from "~/store/sessions.ts";
import { useSettingsStore } from "~/store/settings.ts";
import { useUiStore } from "~/store/ui.ts";
import { useWorkspaceStore } from "~/store/workspace.ts";

export function NotchTrayBridge(): null {
  const bridge = window.zuse?.notch ?? window.memoize?.notch;
  const enabled = useSettingsStore((s) => s.notchTrayEnabled);
  const pinned = useSettingsStore((s) => s.notchTrayPinned);
  const folders = useWorkspaceStore((s) => s.folders);
  const chatsByProject = useChatsStore((s) => s.chatsByProject);
  const sessionsByProject = useSessionsStore((s) => s.sessionsByProject);
  const messagesBySession = useMessagesStore((s) => s.messagesBySession);
  const runningBySession = useMessagesStore((s) => s.runningBySession);
  const requestsById = usePermissionsStore((s) => s.requestsById);
  const permissionRequests = useMemo(
    () => Object.values(requestsById),
    [requestsById],
  );
  const previousRunningRef = useRef<Record<string, boolean>>({});
  const [recentCompletions, setRecentCompletions] = useState<
    Record<string, RecentCompletion>
  >({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    bridge?.setEnabled(enabled);
  }, [bridge, enabled]);

  useEffect(() => {
    bridge?.setPinned(pinned);
  }, [bridge, pinned]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const current = runningBySession;
    const next = noteCompletedSessions(
      previousRunningRef.current,
      current,
      recentCompletions,
      Date.now(),
    );
    previousRunningRef.current = { ...current };
    if (JSON.stringify(next) !== JSON.stringify(recentCompletions)) {
      setRecentCompletions(next);
    }
  }, [recentCompletions, runningBySession]);

  useEffect(() => {
    setRecentCompletions((current) => pruneRecentCompletions(current, now));
  }, [now]);

  const items = useMemo(
    () =>
      buildNotchItems({
        folders,
        chatsByProject,
        sessionsByProject,
        messagesBySession,
        runningBySession,
        permissionRequests,
        recentCompletions,
        now,
      }),
    [
      folders,
      chatsByProject,
      sessionsByProject,
      messagesBySession,
      runningBySession,
      permissionRequests,
      recentCompletions,
      now,
    ],
  );

  useEffect(() => {
    bridge?.setItems(enabled ? items : []);
  }, [bridge, enabled, items]);

  useEffect(() => {
    const unsubscribe = bridge?.onOpenChat?.(({ chatId, sessionId }) => {
      useUiStore.getState().setView("chat");
      useChatsStore.getState().select(chatId as ChatId);
      useSessionsStore.getState().select(sessionId as SessionId);
    });
    return () => unsubscribe?.();
  }, [bridge]);

  return null;
}
