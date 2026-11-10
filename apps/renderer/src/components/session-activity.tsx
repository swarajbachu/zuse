import type { ChatRef, SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { Session, SessionTimelineProjection } from "@zuse/contracts";
import type { DetachedSubagentGroup } from "../lib/group-messages.ts";
import { AgentsSummary } from "./agents-summary.tsx";
import { BackgroundTasks } from "./background-tasks.tsx";
import { SummaryActivity } from "./summary-section.tsx";

/**
 * The session's background work and agents beneath the workspace rows. Each
 * section is keyed by its own kind as well as the session: siblings sharing a
 * key make React leave stale sections behind on every update.
 */
export function SessionActivity({
	session,
	sessionRef,
	view,
	chatRef,
	sessions,
	nativeAgents,
}: {
	readonly session: Session | null;
	readonly sessionRef: SessionRef | null;
	readonly view: ResourceView<SessionTimelineProjection>;
	readonly chatRef: ChatRef | null;
	readonly sessions: ReadonlyArray<Session>;
	readonly nativeAgents: ReadonlyArray<DetachedSubagentGroup>;
}) {
	return (
		<SummaryActivity>
			{sessionRef !== null && session !== null ? (
				<BackgroundTasks
					key={`background:${sessionRef.environmentId}:${sessionRef.sessionId}`}
					view={view}
					sessionRef={sessionRef}
					providerId={session.providerId}
				/>
			) : null}
			{chatRef !== null && session !== null ? (
				<AgentsSummary
					key={`agents:${chatRef.environmentId}:${session.id}`}
					chatRef={chatRef}
					session={session}
					sessions={sessions}
					nativeAgents={nativeAgents}
					historyIncomplete={view.data?.olderMessageSequence != null}
				/>
			) : null}
		</SummaryActivity>
	);
}
