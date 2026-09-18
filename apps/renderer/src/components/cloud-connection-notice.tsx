import "@zuse/i18n/english/connections";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CloudChatSummary, EnvironmentId } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { RefreshIcon } from "@zuse/icons/solid-rounded";
import { useEffect } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import { deriveCloudChatActivity } from "../lib/cloud-chat-activity.ts";
import {
	type CloudConnectionPresentation,
	cloudConnectionPresentation,
} from "../lib/cloud-connection-presentation.ts";
import { cloudFailurePresentation } from "../lib/cloud-failure-presentation.ts";
import {
	cloudSummaryActiveSessionId,
	cloudSummaryForChat,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import { cloudTranscriptActivation } from "../lib/cloud-workspace-lifecycle.ts";
import {
	ensureCloudWorkspaceAttached,
	rearmRegisteredCloudConnection,
} from "../lib/cloud-workspaces.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { usePlatformOnline } from "../lib/network-status.ts";
import {
	getRendererClientBus,
	retryRendererEnvironmentConnection,
} from "../lib/session-timeline-client-bus.ts";
import { useOptionalRendererSessionTimeline } from "../lib/session-timeline-hooks.ts";
import { useChatsStore } from "../store/chats.ts";
import { TrayPill } from "./composer/tray-pill.tsx";
import { DitherCloudIcon } from "./dither-cloud-icon.tsx";
import { Spinner } from "./ui/spinner.tsx";

const copy: Record<
	Exclude<CloudConnectionPresentation, "hidden">,
	{ readonly title: string; readonly detail?: string }
> = {
	paused: {
		get title() {
			return uiMessage(
				"connections:cloud_connection_notice_cloud_workspace_paused",
			);
		},
		detail: "Sending a message or opening a live tool will resume it.",
	},
	resuming: {
		get title() {
			return uiMessage(
				"connections:cloud_connection_notice_resuming_cloud_workspace",
			);
		},
		detail: "The sandbox compute is waking up.",
	},
	updating: {
		get title() {
			return uiMessage(
				"connections:cloud_connection_notice_updating_cloud_runtime",
			);
		},
		detail: "Zuse will reconnect after the compatible runtime starts.",
	},
	"update-required": {
		get title() {
			return uiMessage("connections:cloud_connection_notice_update_required");
		},
		detail: "Update Zuse or the cloud runtime before reconnecting.",
	},
	detached: {
		get title() {
			return uiMessage("connections:cloud_connection_notice_reconnect_needed");
		},
		detail: "The workspace is still running. Retry the live connection.",
	},
	failed: {
		get title() {
			return uiMessage("connections:cloud_connection_notice_connection_failed");
		},
	},
};

type AttachCloudWorkspace = (
	summary: CloudChatSummary,
	activation: "connect" | "wake",
) => Promise<void>;
type RetryRendererConnection = (environmentId: EnvironmentId) => void;

export const retryCloudConnection = async (
	summary: CloudChatSummary,
	attach: AttachCloudWorkspace = ensureCloudWorkspaceAttached,
	retryConnection: RetryRendererConnection = retryRendererEnvironmentConnection,
): Promise<void> => {
	await attach(summary, "wake");
	retryConnection(EnvironmentId.make(summary.workspaceId));
};

export function CloudConnectionNotice() {
	const { message: uiMessage } = useUiMessages(["common", "connections"]);

	const { signIn, signingIn, isSignedIn, isLoading } = useAuth();
	const online = usePlatformOnline();
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const registered =
		selectedChatId === null ? null : cloudSummaryForChat(selectedChatId);
	const summary = useCloudChatCatalogStore((state) =>
		selectedChatId === null
			? null
			: (state.summaries.find((item) => item.chatId === selectedChatId) ??
				registered),
	);
	const shell = useEnvironmentShellResource(
		summary === null ? null : EnvironmentId.make(summary.workspaceId),
		"cache-only",
	);
	const timeline = useOptionalRendererSessionTimeline(
		summary === null ? null : cloudSummaryActiveSessionId(summary),
		summary === null ? "cache-only" : cloudTranscriptActivation(summary),
		summary === null ? null : EnvironmentId.make(summary.workspaceId),
	);
	const runtime = timeline.runtime;
	useEffect(() => {
		if (summary !== null) rearmRegisteredCloudConnection(summary);
	}, [summary, shell.connection]);
	if (summary === null || !online) return null;
	const activity = deriveCloudChatActivity({
		summary,
		connection: shell.connection,
		runtime,
	});
	const presentation = cloudConnectionPresentation(
		summary,
		activity,
		shell.connection,
	);
	// A signed-out session can never reconnect a cloud workspace, so it shows
	// one steady sign-in banner immediately — never the reconnect states.
	const blockedAuth =
		(!isLoading && !isSignedIn) || shell.connection === "blocked-auth";
	const connectionError = getRendererClientBus().connection(
		EnvironmentId.make(summary.workspaceId),
	).error;
	const connectionFailure =
		connectionError === null
			? null
			: cloudFailurePresentation({ cause: connectionError });
	const workspaceFailure = cloudFailurePresentation({
		category: summary.failureDiagnostic ?? summary.statusCode,
	});
	const typedFailure = workspaceFailure ?? connectionFailure;
	const inviteRequired = typedFailure?.kind === "cloud-access-required";
	const betaCheckUnavailable =
		typedFailure?.kind === "cloud-access-unavailable";
	const typedConnectionFailure =
		typedFailure !== null &&
		typedFailure.kind !== "network" &&
		!inviteRequired &&
		!betaCheckUnavailable
			? typedFailure
			: null;
	const signInRequired =
		blockedAuth || typedConnectionFailure?.kind === "sign-in-required";
	const terminalConnectionFailure =
		typedConnectionFailure?.kind === "workspace-deleted" ||
		typedConnectionFailure?.kind === "workspace-storage-unavailable" ||
		typedConnectionFailure?.kind === "session-unavailable" ||
		typedConnectionFailure?.kind === "interaction-expired" ||
		typedConnectionFailure?.kind === "outcome-unknown";
	if (
		presentation === "hidden" &&
		!blockedAuth &&
		!inviteRequired &&
		!betaCheckUnavailable &&
		typedConnectionFailure === null
	)
		return null;
	const retry = () => {
		void retryCloudConnection(summary).catch(() => undefined);
	};
	const value = inviteRequired
		? {
				title: "Cloud access unavailable",
				detail: "Update Zuse and try again to use the Cloud public beta.",
			}
		: betaCheckUnavailable
			? {
					title: uiMessage(
						"connections:cloud_connection_notice_cloud_access_could_not_be_verified",
					),
				}
			: signInRequired
				? {
						title: uiMessage(
							"connections:cloud_connection_notice_sign_in_required",
						),
						detail:
							"Your session expired — sign in to reconnect this cloud workspace.",
					}
				: typedConnectionFailure !== null
					? {
							title: typedConnectionFailure.headline,
							detail: typedConnectionFailure.message,
						}
					: presentation === "hidden"
						? null
						: copy[presentation];
	if (value === null) return null;
	const busy =
		!blockedAuth &&
		typedConnectionFailure === null &&
		!inviteRequired &&
		!betaCheckUnavailable &&
		(presentation === "resuming" || presentation === "updating");
	return (
		<TrayPill
			flush
			role="status"
			aria-live="polite"
			icon={
				busy ? (
					<Spinner className="size-3.5 motion-reduce:animate-none" />
				) : (
					<DitherCloudIcon className="size-3.5" />
				)
			}
			title={value.title}
			subtitle={value.detail}
			actions={
				signInRequired ||
				betaCheckUnavailable ||
				(!terminalConnectionFailure &&
					(presentation === "failed" || presentation === "detached") &&
					!inviteRequired) ? (
					<button
						type="button"
						disabled={signingIn}
						className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => {
							if (signInRequired) void signIn();
							else retry();
						}}
					>
						<HugeiconsIcon icon={RefreshIcon} className="size-3.5" />
						{signInRequired
							? signingIn
								? uiMessage("connections:cloud_connection_notice_signing_in")
								: uiMessage("common:signIn")
							: uiMessage("common:retry")}
					</button>
				) : null
			}
		/>
	);
}
