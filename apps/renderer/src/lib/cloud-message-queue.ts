import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import type { Message } from "@zuse/contracts";
import { useMemo } from "react";
import { partitionCloudMessages } from "./composer-delivery.ts";
import { usePendingSessionMessages } from "./pending-session-messages.ts";
import { isCloudWorkspaceEnvironment } from "./rpc-client.ts";
import type { RendererSessionTimeline } from "./session-timeline-hooks.ts";

const EMPTY: readonly Message[] = [];

/** One presentation for staged uploads, durable acceptance, and runtime handoff. */
export function useCloudMessageQueue(timeline: RendererSessionTimeline) {
	const cloud = isCloudWorkspaceEnvironment(timeline.ref.environmentId);
	const key = resourceRefKey(timeline.ref);
	const preparing = usePendingSessionMessages((state) =>
		cloud ? (state.byResource[key] ?? EMPTY) : EMPTY,
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
