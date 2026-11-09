import "@zuse/i18n/english/chat";
import { useMessages } from "@zuse/i18n/react";
import { useEffect } from "react";
import {
	requestSessionHistoryPage,
	retryCloudHistory,
	useCloudHistoryStatus,
} from "~/lib/session-timeline-client-bus";
import type { OptionalRendererSessionTimeline } from "~/lib/session-timeline-hooks";

/** Whole-history panes request pages only while explicitly open. */
export function SessionHistoryBackfill({
	timeline,
	enabled = true,
}: {
	timeline: OptionalRendererSessionTimeline;
	enabled?: boolean;
}) {
	const { message } = useMessages(["chat"]);
	const status = useCloudHistoryStatus(timeline.ref);
	const before = timeline.projection?.olderMessageSequence;
	useEffect(() => {
		if (enabled && before != null && status === "idle" && timeline.ref !== null)
			requestSessionHistoryPage(timeline.ref);
	}, [
		enabled,
		before,
		status,
		timeline.ref,
		timeline.view.sync,
		timeline.view.connection,
	]);
	if (before == null) return null;
	return (
		<div className="px-2 py-1 text-xs text-muted-foreground" role="status">
			{status === "failed" ? (
				<button
					type="button"
					className="h-7 hover:text-foreground"
					onClick={() => {
						if (timeline.ref !== null) retryCloudHistory(timeline.ref);
					}}
				>
					{message("chat:cloud_history_retry")}
				</button>
			) : (
				message("chat:cloud_history_loading")
			)}
		</div>
	);
}
