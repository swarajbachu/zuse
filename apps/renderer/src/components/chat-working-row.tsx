import type { Message, SessionId } from "@zuse/contracts";
import { useEffect, useMemo, useState } from "react";

import { deriveAgentActivityState } from "../lib/agent-activity-state.ts";
import { PROVIDER_LABEL } from "../lib/provider-labels.ts";
import {
	providerStartupLabel,
	useProviderStartupDelay,
} from "../lib/provider-startup-delay.ts";
import { effectiveSessionRuntimeState } from "../lib/session-runtime-state.ts";
import { useSessionRuntimeStore } from "../store/session-runtime.ts";
import { getSessionById, useSessionsStore } from "../store/sessions.ts";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

const formatElapsed = (ms: number): string => {
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec - min * 60;
	return `${min}m ${sec.toFixed(1)}s`;
};

export function ChatWorkingRow({
	messages,
	sessionId,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly sessionId: SessionId;
}) {
	const runtimeState = useSessionRuntimeStore((state) =>
		effectiveSessionRuntimeState(state.bySession[sessionId]),
	);
	const session = useSessionsStore((state) => {
		void state.sessionsByProject;
		return getSessionById(sessionId);
	});
	const providerLabel =
		session === null || session === undefined
			? "Agent"
			: (PROVIDER_LABEL[session.providerId] ?? session.providerId);
	const delayed = useProviderStartupDelay(
		runtimeState === "starting",
		`${sessionId}:${session?.providerId ?? "unknown"}:${session?.model ?? "unknown"}`,
	);
	const anchorMs = useMemo(() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message === undefined) continue;
			if (
				message.content._tag === "user" ||
				message.content._tag === "user_rich"
			) {
				return message.createdAt.getTime();
			}
		}
		return null;
	}, [messages]);

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const tickId = window.setInterval(() => setNow(Date.now()), 100);
		return () => window.clearInterval(tickId);
	}, []);

	const elapsed = anchorMs === null ? 0 : Math.max(0, now - anchorMs);
	const activityState = deriveAgentActivityState(messages);

	return (
		<div
			className="flex min-h-9 items-center gap-2 px-4 py-2 text-[11px] text-muted-foreground"
			role="status"
			aria-live="polite"
		>
			<AgentActivityOrb state={activityState} />
			<span
				className={
					runtimeState === "starting" && delayed
						? "text-warning"
						: "text-muted-foreground"
				}
			>
				{runtimeState === "starting"
					? providerStartupLabel({
							providerLabel,
							failed: false,
							delayed,
						})
					: `${providerLabel} is working`}
			</span>
			<ShimmerText tone="lime" className="ml-auto tabular-nums">
				{formatElapsed(elapsed)}
			</ShimmerText>
		</div>
	);
}
