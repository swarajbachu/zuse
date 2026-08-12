import { HugeiconsIcon } from "@hugeicons/react";
import { CloudIcon, RefreshIcon } from "@zuse/icons/solid-rounded";
import { deriveCloudChatActivity } from "../lib/cloud-chat-activity.ts";
import {
	type CloudConnectionPresentation,
	cloudConnectionPresentation,
} from "../lib/cloud-connection-presentation.ts";
import { effectiveSessionRuntimeState } from "../lib/session-runtime-state.ts";
import { useChatsStore } from "../store/chats.ts";
import {
	cloudSummaryForChat,
	useCloudExecutionStore,
} from "../store/cloud-chat-registry.ts";
import {
	ensureCloudWorkspaceAttached,
	useCloudChatsStore,
} from "../store/cloud-chats.ts";
import { useSessionRuntimeStore } from "../store/session-runtime.ts";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { Spinner } from "./ui/spinner.tsx";

const copy: Record<
	Exclude<CloudConnectionPresentation, "hidden">,
	{ readonly title: string; readonly detail: string }
> = {
	paused: {
		title: "Cloud workspace paused",
		detail: "Sending a message or opening a live tool will resume it.",
	},
	resuming: {
		title: "Resuming cloud workspace",
		detail: "The sandbox compute is waking up.",
	},
	reconnecting: {
		title: "Reconnecting",
		detail: "Compute is online; Zuse is attaching securely.",
	},
	queued: {
		title: "Sending message",
		detail: "Waiting for the connected workspace to accept it.",
	},
	updating: {
		title: "Updating cloud runtime",
		detail: "Zuse will reconnect after the compatible runtime starts.",
	},
	failed: {
		title: "Connection failed",
		detail: "Your cached chat is still available.",
	},
};

export function CloudConnectionNotice() {
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const registered =
		selectedChatId === null ? null : cloudSummaryForChat(selectedChatId);
	const summary = useCloudChatsStore((state) =>
		selectedChatId === null
			? null
			: (state.summaries.find((item) => item.chatId === selectedChatId) ??
				registered),
	);
	const attachment = useCloudExecutionStore((state) =>
		summary === null
			? "detached"
			: (state.stateByWorkspace[summary.workspaceId] ?? "detached"),
	);
	const command = useCloudChatsStore((state) =>
		summary === null
			? null
			: (state.commandByWorkspace[summary.workspaceId]?.state ?? null),
	);
	const runtime = useSessionRuntimeStore((state) =>
		summary === null
			? "idle"
			: effectiveSessionRuntimeState(state.bySession[summary.initialSessionId]),
	);
	if (summary === null) return null;
	const activity = deriveCloudChatActivity({
		summary,
		attachment,
		runtime,
		command,
	});
	const presentation = cloudConnectionPresentation(summary, activity);
	if (presentation === "hidden") return null;
	const value = copy[presentation];
	const busy =
		presentation === "resuming" ||
		presentation === "reconnecting" ||
		presentation === "queued" ||
		presentation === "updating";
	return (
		<div
			role="status"
			aria-live="polite"
			className="mb-1 flex min-h-9 items-center gap-2 rounded-lg border border-border/60 bg-background/90 px-3 py-2 text-xs shadow-sm"
		>
			{busy ? (
				<Spinner className="size-4 shrink-0 text-muted-foreground motion-reduce:animate-none" />
			) : (
				<HugeiconsIcon
					icon={CloudIcon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
			)}
			<div className="min-w-0 flex-1">
				{busy ? (
					<ShimmerText>{value.title}</ShimmerText>
				) : (
					<p className="font-medium text-foreground">{value.title}</p>
				)}
				<p className="truncate text-muted-foreground">{value.detail}</p>
			</div>
			{presentation === "failed" ? (
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() =>
						void ensureCloudWorkspaceAttached(summary).catch(() => {})
					}
				>
					<HugeiconsIcon icon={RefreshIcon} className="size-3.5" />
					Retry
				</button>
			) : null}
		</div>
	);
}
