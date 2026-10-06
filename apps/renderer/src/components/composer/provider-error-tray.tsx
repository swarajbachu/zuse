import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import { HugeiconsIcon } from "@hugeicons/react";
import { cloudProviderAuthenticationMode } from "@zuse/client-runtime/cloud-provider-availability";
import type { EnvironmentId, ProviderId, SessionId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	AlertCircleIcon,
	Cancel01Icon,
	Copy01Icon,
	DashboardSpeedIcon,
	RefreshIcon,
	Settings01Icon,
	Tick01Icon,
} from "@zuse/icons/stroke-rounded";
import { useState } from "react";

import {
	localProjectForCloudEnvironment,
	useCloudChatCatalogStore,
} from "../../lib/cloud-workspace-catalog.ts";
import { openNewChatLanding } from "../../lib/open-new-chat-landing.ts";
import {
	describeProviderError,
	dismissTranscriptProviderError,
	GEMINI_UPGRADE_COMMAND,
	isBlockingNotice,
	type ProviderErrorNotice,
	useDismissedProviderErrors,
} from "../../lib/provider-error-notice.ts";
import {
	type ChatError,
	clearSessionCommandError,
	isRecoveredPreAckSessionError,
	latestTranscriptError,
	pendingSessionCommandError,
	retryLastSessionMessage,
	sendSessionMessage,
	sessionCommandErrorKey,
	useSessionCommandErrors,
} from "../../lib/session-actions.ts";
import { useRendererSessionTimeline } from "../../lib/session-timeline-hooks.ts";
import { cn } from "../../lib/utils.ts";
import { useUiStore } from "../../store/ui.ts";
import { useProviderErrorCopy } from "../provider-error-copy.ts";
import {
	TrayPill,
	trayPillActionClass,
	trayPillTextActionClass,
} from "./tray-pill.tsx";

/**
 * Above-composer notice for a provider failure that stopped the chat: a failed
 * command, a usage limit, an account that needs reconnecting, or reconnects
 * that ran out. The transcript only records the failure as text; recovery and
 * dismissal live here, next to where the user continues the chat. Local
 * provider sign-in is owned by `ProviderSignInTray`.
 */
export function ProviderErrorTray({
	sessionId,
	environmentId,
	providerId,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	providerId: ProviderId;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);
	const describe = useProviderErrorCopy(environmentId);
	const timeline = useRendererSessionTimeline(
		sessionId,
		"connect",
		environmentId,
	);
	const ref = timeline.ref;
	const sessionKey = sessionCommandErrorKey(ref);
	const localError = useSessionCommandErrors(
		(state) => state.errorByResource[sessionKey] ?? null,
	);
	const dismissedId = useDismissedProviderErrors(
		(state) => state.dismissedBySession[sessionKey] ?? null,
	);

	const commandError = localError ?? pendingSessionCommandError(ref);
	const transcriptError = latestTranscriptError(timeline.messages, providerId);

	let source: { error: ChatError; dismiss: () => void } | null = null;
	if (
		commandError !== null &&
		!isRecoveredPreAckSessionError(commandError, timeline.view)
	) {
		source = {
			error: commandError,
			dismiss: () => clearSessionCommandError(ref),
		};
	} else if (
		transcriptError !== null &&
		transcriptError.message.id !== dismissedId &&
		isBlockingNotice(
			describeProviderError(transcriptError.error, providerId, environmentId),
		)
	) {
		const messageId = transcriptError.message.id;
		source = {
			error: transcriptError.error,
			dismiss: () => dismissTranscriptProviderError(sessionKey, messageId),
		};
	}
	if (source === null) return null;

	const notice = describeProviderError(source.error, providerId, environmentId);
	if (notice.kind === "sign-in") return null;
	const copy = describe(notice, source.error);

	return (
		<TrayPill
			flush
			role="status"
			aria-live="polite"
			tone={noticeTone(notice)}
			icon={<HugeiconsIcon icon={noticeIcon(notice)} className="size-3.5" />}
			title={copy.title}
			subtitle={copy.detail.length > 0 ? copy.detail : undefined}
			actions={
				<>
					<ProviderErrorActions
						notice={notice}
						onRetry={() => void retryLastSessionMessage(ref, providerId)}
						onKeepGoing={() =>
							void sendSessionMessage(ref, "keep going", { providerId })
						}
						environmentId={environmentId}
					/>
					<button
						type="button"
						onClick={source.dismiss}
						// Match the h-7 text actions beside it.
						className={cn(trayPillActionClass, "size-7")}
						aria-label={uiMessage("chat:message_row_dismiss_error")}
						title={uiMessage("chat:message_row_dismiss")}
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
					</button>
				</>
			}
		/>
	);
}

const noticeTone = (notice: ProviderErrorNotice) =>
	notice.kind === "usage-limit" || notice.kind === "reconnecting"
		? "default"
		: "danger";

const noticeIcon = (notice: ProviderErrorNotice) =>
	notice.kind === "usage-limit"
		? DashboardSpeedIcon
		: notice.kind === "reconnecting"
			? RefreshIcon
			: AlertCircleIcon;

function ProviderErrorActions({
	notice,
	onRetry,
	onKeepGoing,
	environmentId,
}: {
	notice: ProviderErrorNotice;
	onRetry: () => void;
	onKeepGoing: () => void;
	environmentId: EnvironmentId;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const cloudSummary = useCloudChatCatalogStore(
		(state) =>
			state.summaries.find(
				(summary) => summary.workspaceId === environmentId,
			) ?? null,
	);
	const [copied, setCopied] = useState(false);

	const openSettings = (section: "providers" | "machines") => {
		setView("settings");
		setSettingsSection({ kind: section });
	};

	switch (notice.kind) {
		case "gemini-upgrade":
			return (
				<button
					type="button"
					className={trayPillTextActionClass}
					onClick={() => {
						void navigator.clipboard
							.writeText(GEMINI_UPGRADE_COMMAND)
							.then(() => {
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1600);
							});
					}}
				>
					<HugeiconsIcon
						icon={copied ? Tick01Icon : Copy01Icon}
						className="size-3.5"
					/>
					{copied
						? uiMessage("common:copied")
						: uiMessage("chat:message_row_copy_upgrade_command")}
				</button>
			);
		case "cloud-auth": {
			const legacy =
				cloudProviderAuthenticationMode(notice.providerId, cloudSummary) ===
				"legacy-image";
			const replacementProjectId =
				localProjectForCloudEnvironment(environmentId);
			return (
				<>
					{legacy && replacementProjectId !== null ? (
						<button
							type="button"
							className={trayPillTextActionClass}
							onClick={() => openNewChatLanding(replacementProjectId)}
						>
							{uiMessage("chat:message_row_create_replacement_chat")}
						</button>
					) : null}
					<button
						type="button"
						className={trayPillTextActionClass}
						onClick={() => openSettings("machines")}
					>
						<HugeiconsIcon icon={Settings01Icon} className="size-3.5" />
						{uiMessage("chat:message_row_open_cloud_authentication")}
					</button>
				</>
			);
		}
		case "reconnecting":
			return notice.attempt >= notice.maxAttempts ? (
				<button
					type="button"
					className={trayPillTextActionClass}
					onClick={onKeepGoing}
				>
					{uiMessage("common:retry")}
				</button>
			) : null;
		case "auth":
			return (
				<>
					<button
						type="button"
						className={trayPillTextActionClass}
						onClick={() => openSettings("providers")}
					>
						<HugeiconsIcon icon={Settings01Icon} className="size-3.5" />
						{uiMessage("chat:message_row_open_provider_settings")}
					</button>
					<RetryAction onRetry={onRetry} />
				</>
			);
		case "usage-limit":
		case "network":
		case "generic":
			return <RetryAction onRetry={onRetry} />;
		case "terminal":
		case "sign-in":
			return null;
	}
}

function RetryAction({ onRetry }: { onRetry: () => void }) {
	const { message: uiMessage } = useUiMessages(["common"]);
	return (
		<button type="button" className={trayPillTextActionClass} onClick={onRetry}>
			{uiMessage("common:retry")}
		</button>
	);
}
