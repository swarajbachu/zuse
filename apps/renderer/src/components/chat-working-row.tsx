import "@zuse/i18n/english/chat";
import type { PendingCommand } from "@zuse/client-runtime/resource-state";
import type { SessionRuntimeState } from "@zuse/client-runtime/session-presentation";
import type {
	ChatId,
	Message,
	ProviderId,
	SessionId,
	SessionInteraction,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useMemo } from "react";

import { deriveAgentActivityState } from "../lib/agent-activity-state.ts";
import { useCloudChatSummaryForSelection } from "../lib/cloud-workspaces.ts";
import { waitingCloudMessagePresentation } from "../lib/composer-delivery.ts";
import { useProviderDisplayName } from "../lib/provider-labels.ts";
import {
	providerStartupLabel,
	useProviderStartupDelay,
} from "../lib/provider-startup-delay.ts";
import { useRelativeTimeTick } from "../lib/use-relative-time.ts";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

const formatElapsed = (ms: number): string => {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec - min * 60;
	return `${min}m ${sec}s`;
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
	chatId,
	sessionId,
	interactions = [],
	providerId,
	pendingCommands,
	runtimeState,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly chatId: ChatId | null;
	readonly sessionId: SessionId;
	readonly interactions?: readonly SessionInteraction[];
	readonly providerId: ProviderId;
	readonly pendingCommands: readonly PendingCommand[];
	readonly runtimeState: SessionRuntimeState;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const waitingCommand = waitingCloudMessagePresentation(pendingCommands);
	const providerLabel = useProviderDisplayName(providerId);
	const cloudSummary = useCloudChatSummaryForSelection({ chatId, sessionId });
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
		`${sessionId}:${providerId}`,
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
	}, [messages, uiMessage]);

	const now = useRelativeTimeTick(1_000);

	const elapsed = anchorMs === null ? 0 : Math.max(0, now - anchorMs);
	const activityState = deriveAgentActivityState(messages, interactions);

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
						: uiMessage("chat:chat_working_row_is_working", {
								providerLabel: String(providerLabel),
							})}
			</span>
			<ShimmerText tone="lime" className="tabular-nums">
				{formatElapsed(elapsed)}
			</ShimmerText>
		</div>
	);
}

/** One quiet waiting row per background reviewer, even between parent turns. */
export function BackgroundAgentWorkingRows({
	agents,
}: {
	readonly agents: ReadonlyArray<{
		readonly id: string;
		readonly description: string;
		readonly startedAtMs: number;
	}>;
}) {
	const { message } = useUiMessages(["chat"]);
	const now = useRelativeTimeTick(1_000);
	return agents.map((agent) => (
		<div
			key={agent.id}
			role="status"
			className="flex h-7 min-w-0 items-center gap-2 px-4 text-xs text-muted-foreground"
		>
			<AgentActivityOrb state="working" />
			<span className="truncate" title={agent.description}>
				{message("chat:chat_working_row_waiting_for_task", {
					task: agent.description || message("chat:subagent_row_agent_running"),
				})}
			</span>
			<span className="shrink-0 font-mono tabular-nums">
				{formatElapsed(Math.max(0, now - agent.startedAtMs))}
			</span>
		</div>
	));
}
