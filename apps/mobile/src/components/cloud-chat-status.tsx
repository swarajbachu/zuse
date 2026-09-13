import { useAtomValue } from "@effect/atom-react";
import { cloudFailurePresentation } from "@zuse/client-runtime/cloud-failure-presentation";
import type { Message, SessionId } from "@zuse/contracts";
import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { connectionSessionKey } from "~/lib/session-key";
import { cloudCatalogAtom, refreshCloudCatalog } from "~/store/cloud-catalog";
import {
	hasOlderMessagesAtom,
	loadOlderMessages,
	sessionDeliveryAtom,
} from "~/store/messages";
import { mobileClientBus } from "~/store/mobile-client-bus";

export function CloudChatStatus({
	workspaceId,
	connKey,
	sessionId,
	messages,
	error,
}: {
	workspaceId: string;
	connKey: string;
	sessionId: SessionId;
	messages: readonly Message[];
	error?: string | null;
}) {
	const catalog = useAtomValue(cloudCatalogAtom);
	const delivery = useAtomValue(
		sessionDeliveryAtom(connectionSessionKey(connKey, sessionId)),
	);
	const hasOlder = useAtomValue(
		hasOlderMessagesAtom(connectionSessionKey(connKey, sessionId)),
	);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const summary = catalog.chats.find((row) => row.workspaceId === workspaceId);
	const pending = delivery.pending.find(
		(command) => command.kind === "messages.send",
	);
	const lastUserIndex = messages.findLastIndex(
		(message) => message.role === "user",
	);
	const lastFailed = delivery.failed.at(-1);
	const failed =
		pending === undefined &&
		(lastFailed?.failedAt ?? 0) >=
			(messages[lastUserIndex]?.createdAt.getTime() ?? 0)
			? lastFailed
			: undefined;
	const providerError = messages
		.slice(lastUserIndex + 1)
		.findLast((message) => message.content._tag === "error");
	const providerText =
		providerError?.content._tag === "error"
			? providerError.content.message
			: undefined;
	const failure = cloudFailurePresentation({
		state: failed?.terminal?.state,
		category:
			failed?.terminal?.category ?? pending?.category ?? summary?.statusCode,
		blockedUntil: pending?.blockedUntil,
		cause: failed?.error ?? providerText ?? error,
	});
	const providerAuthFailure =
		failure?.kind === "sign-in-required" &&
		(providerText !== undefined ||
			(
				failed?.terminal?.category ??
				pending?.category ??
				summary?.statusCode ??
				""
			).includes("-auth-"));
	const legacy =
		providerAuthFailure &&
		(summary?.agent === "codex"
			? summary.codexAuthMode
			: summary?.providerAuthMode) === "legacy-image";
	const storageLost = failure?.kind === "workspace-storage-unavailable";
	const outcomeUnknown = failure?.kind === "outcome-unknown";
	const waking =
		summary !== undefined &&
		summary.state !== "ready" &&
		summary.desiredState === "ready" &&
		summary.state !== "failed";
	const reconnectingAuth = (pending?.category ?? providerText ?? "").includes(
		"-auth-reconnecting",
	);
	const label = legacy
		? "This retained chat uses legacy authentication."
		: providerAuthFailure
			? "Reconnect your provider once in Cloud Authentication."
			: reconnectingAuth
				? "Reconnecting agent authentication…"
				: (failure?.message ??
					(pending !== undefined
						? "Waiting for agent"
						: waking
							? "Waking cloud workspace…"
							: summary?.state === "paused"
								? "Cloud workspace is sleeping. Your next message will wake it."
								: error
									? "Cloud history could not refresh. Pull to retry."
									: null));
	if (label === null && actionError === null && !hasOlder) return null;
	const lastUser = messages[lastUserIndex];
	const draft =
		lastUser?.content._tag === "user" || lastUser?.content._tag === "user_rich"
			? lastUser.content.text
			: "";
	return (
		<View role="status" aria-live="polite" className="gap-2 px-4 py-2">
			<Text className="font-sans text-sm text-muted-foreground">{label}</Text>
			{pending !== undefined && waking ? (
				<Text className="font-sans text-xs text-muted-foreground">
					Waking cloud workspace · {summary?.startupPhase.replaceAll("-", " ")}
				</Text>
			) : null}
			<View className="flex-row flex-wrap gap-2">
				{hasOlder ? (
					<Button
						className="h-7"
						variant="ghost"
						disabled={loadingOlder}
						onPress={() => {
							setLoadingOlder(true);
							void loadOlderMessages(connKey, sessionId)
								.catch(() =>
									setActionError("Could not load older messages. Try again."),
								)
								.finally(() => setLoadingOlder(false));
						}}
					>
						{loadingOlder ? "Loading history…" : "Load earlier messages"}
					</Button>
				) : null}
				{pending?.cancellable ? (
					<Button
						className="h-7"
						variant="ghost"
						onPress={() =>
							void mobileClientBus()
								.cancelCommand(pending.commandId)
								.catch(() =>
									setActionError(
										"The agent may already have picked up this message. Refresh its status.",
									),
								)
						}
					>
						Cancel queued message
					</Button>
				) : null}
				{providerAuthFailure ? (
					<Button
						className="h-7"
						variant="ghost"
						onPress={() => router.push("/cloud-auth")}
					>
						Cloud Authentication
					</Button>
				) : null}
				{legacy || storageLost || outcomeUnknown ? (
					<Button
						className="h-7"
						variant="ghost"
						onPress={() =>
							router.push({
								pathname: "/new-cloud-chat",
								params: { projectId: summary?.projectId, draft },
							})
						}
					>
						{outcomeUnknown ? "Create draft" : "Create replacement chat"}
					</Button>
				) : null}
				{failure?.kind === "update-required" ? (
					<Button
						className="h-7"
						variant="ghost"
						onPress={() => router.push("/cloud-auth")}
					>
						Cloud settings
					</Button>
				) : null}
				{failure?.kind === "network" && !reconnectingAuth ? (
					<Button
						className="h-7"
						variant="ghost"
						onPress={() => void refreshCloudCatalog()}
					>
						Refresh status
					</Button>
				) : null}
			</View>
			{actionError ? (
				<Text
					accessibilityRole="alert"
					className="font-sans text-xs text-destructive"
				>
					{actionError}
				</Text>
			) : null}
		</View>
	);
}
