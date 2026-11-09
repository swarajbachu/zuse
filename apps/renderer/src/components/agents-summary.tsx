import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { ProviderId, Session } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { AiNetworkIcon } from "@zuse/icons/solid-rounded";
import { CornerUpLeft } from "lucide-react";
import { useState } from "react";
import {
	type DelegationStatus,
	subagentDelegationView,
} from "../lib/delegation-display.ts";
import type { DetachedSubagentGroup } from "../lib/group-messages.ts";
import { openSession } from "../lib/session-navigation.ts";
import { cn } from "../lib/utils.ts";
import { useUiStore } from "../store/ui.ts";
import { summaryMetaClass, summaryRowClass } from "./cloud-workspace-info.tsx";
import {
	DelegationElapsed,
	StatusGlyph,
	useDelegationStatusLabel,
} from "./delegation-row.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { SummarySection } from "./summary-section.tsx";

/** Settled agents shown before the rest fold behind "Show more". */
const SETTLED_PREVIEW = 3;

interface AgentEntry {
	readonly id: string;
	readonly title: string;
	readonly providerId: ProviderId;
	readonly status: DelegationStatus;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
	readonly open: () => void;
}

export function AgentsSummary({
	chatRef,
	session,
	sessions,
	nativeAgents,
	historyIncomplete = false,
}: {
	readonly chatRef: ChatRef;
	readonly session: Session;
	readonly sessions: ReadonlyArray<Session>;
	readonly historyIncomplete?: boolean;
	readonly nativeAgents: ReadonlyArray<DetachedSubagentGroup>;
}) {
	const { message } = useMessages(["chat", "common"]);
	const statusLabel = useDelegationStatusLabel();
	const [navigationFailed, setNavigationFailed] = useState(false);
	const [showAllSettled, setShowAllSettled] = useState(false);
	const revealSubagent = useUiStore((state) => state.revealSubagent);
	const children = sessions.filter(
		(candidate) => candidate.parentSessionId === session.id,
	);
	const parent = sessions.find(
		(candidate) => candidate.id === session.parentSessionId,
	);
	const navigate = async (target: Session["id"]) => {
		setNavigationFailed(false);
		try {
			setNavigationFailed(
				!(await openSession({
					environmentId: chatRef.environmentId,
					sessionId: target,
				})),
			);
		} catch {
			setNavigationFailed(true);
		}
	};
	const entries: ReadonlyArray<AgentEntry> = [
		...children.map((child) => ({
			id: `session:${child.id}`,
			title: child.title,
			providerId: child.providerId,
			status: sessionDelegationStatus(child.status),
			startedAt: null,
			completedAt: null,
			open: () => void navigate(child.id),
		})),
		...nativeAgents.map((child) => {
			const view = subagentDelegationView(child, {
				providerId: null,
				parentLive: true,
				canReveal: true,
			});
			return {
				id: `native:${child.childSessionId}`,
				title: view.title,
				// Native subagents run inside the parent's provider.
				providerId: session.providerId,
				status: view.status,
				startedAt: view.startedAt,
				completedAt: view.completedAt,
				open: () => revealSubagent(chatRef, child.childSessionId),
			};
		}),
	];
	if (entries.length === 0 && !session.parentSessionId && !historyIncomplete)
		return null;
	const active = entries.filter((entry) => entry.status === "working");
	const settled = entries.filter((entry) => entry.status !== "working");
	const visibleSettled = showAllSettled
		? settled
		: settled.slice(0, SETTLED_PREVIEW);
	const hiddenSettled = settled.length - visibleSettled.length;
	const row = (entry: AgentEntry) => (
		<button
			key={entry.id}
			type="button"
			onClick={entry.open}
			title={entry.title}
			aria-description={statusLabel(entry.status)}
			className={cn(
				summaryRowClass,
				"hover:bg-muted/60",
				entry.status !== "working" && "text-muted-foreground",
			)}
		>
			<span className="grid size-4 shrink-0 place-items-center">
				<ProviderIcon providerId={entry.providerId} className="size-3.5" />
			</span>
			<span className="min-w-0 flex-1 truncate group-hover:text-foreground">
				{entry.title}
			</span>
			<span className={summaryMetaClass}>
				<DelegationElapsed timing={entry} />
				<span className="grid size-3 place-items-center">
					<StatusGlyph status={entry.status} />
				</span>
			</span>
		</button>
	);
	return (
		<SummarySection
			icon={AiNetworkIcon}
			label={message("chat:agents_summary_title")}
			meta={
				active.length > 0
					? message("chat:agents_summary_running", {
							count: String(active.length),
						})
					: null
			}
		>
			{session.parentSessionId ? (
				<button
					type="button"
					onClick={() => {
						if (session.parentSessionId) void navigate(session.parentSessionId);
					}}
					className={`${summaryRowClass} hover:bg-muted/60`}
				>
					<span className="grid size-4 shrink-0 place-items-center">
						<CornerUpLeft className="size-3.5 text-muted-foreground" />
					</span>
					<span className="min-w-0 flex-1 truncate">
						{parent?.title ?? message("chat:agents_summary_parent_chat")}
					</span>
					<span className={summaryMetaClass}>
						{message("chat:agents_summary_parent")}
					</span>
				</button>
			) : null}
			{active.map(row)}
			{visibleSettled.map(row)}
			{hiddenSettled > 0 ? (
				<button
					type="button"
					onClick={() => setShowAllSettled(true)}
					className={`${summaryRowClass} ps-[34px] text-[11px] text-muted-foreground hover:text-foreground`}
				>
					{message("common:show_more_count", {
						count: String(hiddenSettled),
					})}
				</button>
			) : null}
			{historyIncomplete ? (
				<button
					type="button"
					className={`${summaryRowClass} h-7 ps-[34px] text-[11px] text-muted-foreground hover:text-foreground`}
					onClick={() =>
						useUiStore.getState().revealPanelForChat(chatRef, "subagents")
					}
				>
					{message("chat:history_load_older")}
				</button>
			) : null}
			{navigationFailed ? (
				<p
					role="status"
					className="px-2.5 py-1 ps-[34px] text-[11px] text-muted-foreground"
				>
					{message("chat:agents_summary_unavailable")}
				</p>
			) : null}
		</SummarySection>
	);
}

const sessionDelegationStatus = (
	status: Session["status"],
): DelegationStatus =>
	status === "running" || status === "booting"
		? "working"
		: status === "error"
			? "failed"
			: "done";
