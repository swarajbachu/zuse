import "@zuse/i18n/english/chat";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type {
	ChatId,
	EnvironmentId,
	ProviderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { EnvironmentId as EnvironmentIdSchema } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ChevronDown } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
	type DelegationMember,
	type DelegationView,
	delegationGroupTiming,
	type SpawnedSessionState,
	spawnDelegationView,
	spawnTarget,
	subagentDelegationView,
	summarizeDelegationStatuses,
} from "~/lib/delegation-display";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks";
import { useRendererSessionTimelines } from "~/lib/session-timeline-hooks";
import { cn } from "~/lib/utils";
import { useChatsStore } from "~/store/chats";
import { useSessionsStore } from "~/store/sessions";
import { useUiStore } from "~/store/ui";

import {
	DelegationElapsed,
	type DelegationInlineBody,
	DelegationRow,
} from "./delegation-row.tsx";
import { DelegationAvatar } from "./subagent-identity.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

const MAX_STACK = 3;

const STATUS_COUNT_KEY = {
	working: "chat:delegation_group_working",
	done: "chat:delegation_group_done",
	failed: "chat:delegation_group_failed",
	stopped: "chat:delegation_group_stopped",
} as const;

/** Live state for every orchestrated session in the group, in one subscription. */
const useSpawnedSessions = (
	members: ReadonlyArray<DelegationMember>,
	explicitEnvironmentId: EnvironmentId | undefined,
): ReadonlyMap<string, SpawnedSessionState> => {
	const active = useActiveEnvironmentEntities();
	const environmentId = explicitEnvironmentId ?? active.environmentId;
	const sessionIds = members.flatMap((member) => {
		if (member.kind !== "spawn") return [];
		const sessionId = spawnTarget(member)?.sessionId;
		return sessionId === null || sessionId === undefined ? [] : [sessionId];
	});
	const refs = useMemo(
		() =>
			sessionIds.map((sessionId) => ({
				environmentId: EnvironmentIdSchema.make(environmentId),
				sessionId: sessionId as SessionId,
			})),
		[environmentId, sessionIds.join("\n")],
	);
	const timelines = useRendererSessionTimelines(refs, "cache-only");
	const { sessionsByProject } = active;
	return useMemo(() => {
		const wanted = new Set<string>(sessionIds);
		const sessions = new Map<string, Session>();
		for (const list of Object.values(sessionsByProject)) {
			for (const session of list) {
				if (wanted.has(session.id)) sessions.set(session.id, session);
			}
		}
		const states = new Map<string, SpawnedSessionState>();
		for (const timeline of timelines) {
			const session = sessions.get(timeline.ref.sessionId);
			if (session === undefined) continue;
			states.set(session.id, {
				providerId: session.providerId,
				status: session.status,
				runtime: timeline.runtime,
				messages: timeline.messages,
			});
		}
		return states;
	}, [timelines, sessionsByProject]);
};

/**
 * Delegated agents from one stretch of a turn. A single agent renders as its
 * row; several collapse under a header with an avatar stack, live status
 * counts, and one elapsed span — open while any of them still works.
 */
export const DelegationGroup = memo(function DelegationGroup({
	members,
	providerId,
	parentLive,
	chatRef,
	environmentId,
	readOnly = false,
}: {
	readonly members: ReadonlyArray<DelegationMember>;
	/** The parent session's provider; subagents run on it unless told otherwise. */
	readonly providerId: ProviderId | null;
	readonly parentLive: boolean;
	readonly chatRef: ChatRef | null;
	readonly environmentId: EnvironmentId | undefined;
	readonly readOnly?: boolean;
}) {
	const { message } = useUiMessages(["chat"]);
	const spawned = useSpawnedSessions(
		members,
		environmentId ?? chatRef?.environmentId,
	);
	const revealSubagent = useUiStore((state) => state.revealSubagent);
	const canReveal = !readOnly && chatRef !== null;

	const entries = members.map((member) => {
		if (member.kind === "subagent") {
			const view = subagentDelegationView(member.group, {
				providerId,
				parentLive,
				canReveal,
			});
			const inline: DelegationInlineBody | null =
				view.open === null
					? {
							prompt: member.group.prompt,
							children: member.group.children,
							summaryText: member.group.summary?.text ?? null,
							readOnly,
							environmentId: environmentId ?? chatRef?.environmentId,
						}
					: null;
			return { view, inline };
		}
		const sessionId = spawnTarget(member)?.sessionId ?? null;
		const view = spawnDelegationView(member, {
			fallbackProviderId: providerId,
			session: sessionId === null ? null : (spawned.get(sessionId) ?? null),
		});
		return { view, inline: null };
	});

	const open = (view: DelegationView): (() => void) | null => {
		const target = view.open;
		if (target === null || readOnly) return null;
		if (target.kind === "chat") {
			return () => {
				useChatsStore.getState().select(target.chatId as ChatId);
				useSessionsStore.getState().select(target.sessionId as SessionId);
			};
		}
		if (chatRef === null) return null;
		return () => revealSubagent(chatRef, target.childSessionId);
	};

	const rows = entries.map(({ view, inline }) => (
		<DelegationRow
			key={view.id}
			view={view}
			onOpen={open(view)}
			inline={inline}
		/>
	));

	const views = entries.map((entry) => entry.view);
	const working = views.filter((view) => view.status === "working").length;
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	if (members.length === 1) return <div className="px-2">{rows}</div>;

	const expanded = userExpanded ?? true;
	const failed = views.some((view) => view.status === "failed");
	const label = message("chat:delegation_group_count", {
		count: members.length,
	});
	const summary =
		working > 0
			? message("chat:delegation_group_running", {
					working,
					total: members.length,
				})
			: summarizeDelegationStatuses(views.map((view) => view.status))
					.map(({ status, count }) =>
						message(STATUS_COUNT_KEY[status], { count }),
					)
					.join(" · ");
	return (
		<div className="py-1">
			<button
				type="button"
				aria-label={label}
				aria-description={summary}
				aria-expanded={expanded}
				onClick={() => setUserExpanded(!expanded)}
				className="flex h-7 w-full min-w-0 items-center gap-2 ps-3 pe-4 text-left text-xs text-muted-foreground hover:text-foreground"
			>
				<span className="flex shrink-0 items-center -space-x-1">
					{views.slice(0, MAX_STACK).map((view) => (
						<DelegationAvatar
							key={view.id}
							providerId={view.providerId}
							name={view.title}
						/>
					))}
					{views.length > MAX_STACK ? (
						<span className="inline-flex size-5 items-center justify-center rounded-md bg-muted text-[10px] font-medium ring-2 ring-background">
							+{views.length - MAX_STACK}
						</span>
					) : null}
				</span>
				<span className="min-w-0 flex-1 truncate">
					{working > 0 ? (
						<ShimmerText tone="lime">{summary}</ShimmerText>
					) : (
						<span className={failed ? "text-destructive" : undefined}>
							{summary}
						</span>
					)}
				</span>
				<span className="shrink-0 tabular-nums">
					<DelegationElapsed timing={delegationGroupTiming(views)} />
				</span>
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
						!expanded && "-rotate-90",
					)}
				/>
			</button>
			<div hidden={!expanded}>
				{entries.map(({ view }, index) => (
					<div
						key={view.id}
						className={cn(
							"tool-activity-branch",
							index === entries.length - 1 && "tool-activity-last",
						)}
					>
						<div className="ms-2">{rows[index]}</div>
					</div>
				))}
			</div>
		</div>
	);
});
