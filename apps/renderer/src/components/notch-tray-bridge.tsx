import { type ChatId, EnvironmentId, type SessionId } from "@zuse/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { useEnvironmentPermissions } from "~/lib/environment-permissions-client-bus.ts";
import {
	buildNotchItems,
	deriveRunningSessions,
	noteCompletedSessions,
	pruneRecentCompletions,
	type RecentCompletion,
} from "~/lib/notch-items.ts";
import { useRendererSessionTimelines } from "~/lib/session-timeline-hooks.ts";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import { useChatsStore } from "~/store/chats.ts";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog.ts";
import { useSessionsStore } from "~/store/sessions.ts";
import { useUiStore } from "~/store/ui.ts";
import { useWorkspaceStore } from "~/store/workspace.ts";

export function NotchTrayBridge(): null {
	const bridge = window.zuse?.notch ?? window.memoize?.notch;
	const enabled = useSettingsStore((s) => s.notchTrayEnabled);
	const pinned = useSettingsStore((s) => s.notchTrayPinned);
	const folders = useWorkspaceStore((s) => s.folders);
	const { chatsByProject, sessionsByProject } = useActiveEnvironmentEntities();
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	const timelineRefs = useMemo(
		() =>
			Object.values(sessionsByProject)
				.flat()
				.map((session) => ({
					environmentId: EnvironmentId.make(activeEnvironmentId),
					sessionId: session.id,
				})),
		[activeEnvironmentId, sessionsByProject],
	);
	const timelines = useRendererSessionTimelines(timelineRefs, "cache-only");
	const messagesBySession = useMemo(
		() =>
			Object.fromEntries(
				timelines.map((timeline) => [
					timeline.ref.sessionId,
					timeline.messages,
				]),
			),
		[timelines],
	);
	const runtimeBySession = useMemo(
		() =>
			Object.fromEntries(
				timelines.map((timeline) => [timeline.ref.sessionId, timeline.runtime]),
			),
		[timelines],
	);
	const reconciledRunningBySession = useMemo(
		() => deriveRunningSessions(sessionsByProject, runtimeBySession),
		[sessionsByProject, runtimeBySession],
	);
	const requestsById = useEnvironmentPermissions().data?.requestsById ?? {};
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
		const current = reconciledRunningBySession;
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
	}, [recentCompletions, reconciledRunningBySession]);

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
				runtimeBySession,
				permissionRequests,
				recentCompletions,
				now,
			}),
		[
			folders,
			chatsByProject,
			sessionsByProject,
			messagesBySession,
			runtimeBySession,
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
