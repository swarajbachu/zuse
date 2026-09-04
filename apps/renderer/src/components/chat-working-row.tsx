import type { PendingCommand } from "@zuse/client-runtime/resource-state";
import type { Message, SessionId } from "@zuse/contracts";
import { useEffect, useMemo, useState } from "react";

import { deriveAgentActivityState } from "../lib/agent-activity-state.ts";
import { cloudSummaryForSession } from "../lib/cloud-workspace-catalog.ts";
import { waitingCloudMessagePresentation } from "../lib/composer-delivery.ts";
import { useActiveSessionById } from "../lib/environment-entity-hooks.ts";
import { PROVIDER_LABEL } from "../lib/provider-labels.ts";
import {
	providerStartupLabel,
	useProviderStartupDelay,
} from "../lib/provider-startup-delay.ts";
import type { SessionRuntimeState } from "../lib/session-runtime-state.ts";
import { cancelSessionCommand } from "../lib/session-timeline-client-bus.ts";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

const formatElapsed = (ms: number): string => {
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec - min * 60;
	return `${min}m ${sec.toFixed(1)}s`;
};

export const providerStartupIsActive = ({
	runtimeState,
	providerOutputStarted,
	startupContextActive,
}: {
	readonly runtimeState: SessionRuntimeState;
	readonly providerOutputStarted: boolean;
	readonly startupContextActive: boolean;
}): boolean =>
	runtimeState === "starting" && !providerOutputStarted && startupContextActive;

export function ChatWorkingRow({
	messages,
	sessionId,
	pendingCommands,
	runtimeState,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly sessionId: SessionId;
	readonly pendingCommands: readonly PendingCommand[];
	readonly runtimeState: SessionRuntimeState;
}) {
	const waitingCommand = waitingCloudMessagePresentation(pendingCommands);
	const session = useActiveSessionById(sessionId);
	const providerLabel =
		session === null || session === undefined
			? "Agent"
			: (PROVIDER_LABEL[session.providerId] ?? session.providerId);
	const cloudSummary = cloudSummaryForSession(sessionId);
	const initialCloudAgentStart =
		cloudSummary !== null && cloudSummary.startupPhase === "starting-agent";
	const providerOutputStarted = messages.some(
		(message) => message.role === "assistant" || message.role === "tool",
	);
	const showStartup = providerStartupIsActive({
		runtimeState,
		providerOutputStarted,
		startupContextActive: cloudSummary === null || initialCloudAgentStart,
	});
	const delayed = useProviderStartupDelay(
		showStartup,
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
					showStartup && delayed ? "text-warning" : "text-muted-foreground"
				}
			>
				{waitingCommand !== null
					? waitingCommand.label
					: showStartup
						? providerStartupLabel({
								providerLabel,
								failed: false,
								delayed,
							})
						: `${providerLabel} is working`}
			</span>
			{waitingCommand?.cancellable === true ? (
				<Button
					size="xs"
					variant="ghost"
					onClick={() =>
						void cancelSessionCommand(waitingCommand.commandId).catch(
							() => undefined,
						)
					}
				>
					Cancel
				</Button>
			) : null}
			<ShimmerText tone="lime" className="tabular-nums">
				{formatElapsed(elapsed)}
			</ShimmerText>
		</div>
	);
}
