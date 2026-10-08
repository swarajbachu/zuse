import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import {
	type CloudChatSummary,
	EnvironmentId,
	type Message,
} from "@zuse/contracts";
import { useMemo } from "react";
import { deriveCloudChatActivity } from "./cloud-chat-activity.ts";
import {
	type CloudQueueStatus,
	cloudQueueStatus,
} from "./cloud-queue-status.ts";
import { useCloudChatCatalogStore } from "./cloud-workspace-catalog.ts";
import { partitionCloudMessages } from "./composer-delivery.ts";
import { useEnvironmentShellResource } from "./environment-shell-client-bus.ts";
import { usePendingSessionMessages } from "./pending-session-messages.ts";
import { isCloudWorkspaceEnvironment } from "./rpc-client.ts";
import type { OptionalRendererSessionTimeline } from "./session-timeline-hooks.ts";

const EMPTY: readonly Message[] = [];

/** One presentation for staged uploads, durable acceptance, and runtime handoff. */
export function useCloudMessageQueue(
	timeline: OptionalRendererSessionTimeline,
) {
	const environmentId = timeline.ref?.environmentId ?? null;
	const catalogCloud = useCloudChatCatalogStore(
		(state) =>
			environmentId !== null &&
			state.summaries.some((summary) => summary.workspaceId === environmentId),
	);
	const cloud =
		catalogCloud ||
		(environmentId !== null && isCloudWorkspaceEnvironment(environmentId));
	const key = timeline.ref === null ? null : resourceRefKey(timeline.ref);
	const preparing = usePendingSessionMessages((state) =>
		cloud && key !== null ? (state.byResource[key] ?? EMPTY) : EMPTY,
	);
	return useMemo(
		() =>
			cloud
				? partitionCloudMessages(
						timeline.messages,
						timeline.view.pendingCommands,
						preparing,
					)
				: { transcript: timeline.messages, waiting: EMPTY },
		[cloud, timeline.messages, timeline.view.pendingCommands, preparing],
	);
}

/** The single status line shown above prompts waiting for cloud compute. */
export function useCloudQueueStatus(
	summary: CloudChatSummary | null,
	timeline: OptionalRendererSessionTimeline,
): CloudQueueStatus {
	const shell = useEnvironmentShellResource(
		summary === null ? null : EnvironmentId.make(summary.workspaceId),
		"cache-only",
	);
	const activity =
		summary === null
			? null
			: deriveCloudChatActivity({
					summary,
					connection: shell.connection,
					runtime: timeline.runtime,
					timeline: timeline.view,
				});
	return cloudQueueStatus({
		summary,
		activity,
		connection: shell.connection,
		pendingCommands: timeline.view.pendingCommands,
	});
}
