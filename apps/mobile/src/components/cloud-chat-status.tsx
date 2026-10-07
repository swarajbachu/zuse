import { useAtomValue } from "@effect/atom-react";
import { cloudFailurePresentation } from "@zuse/client-runtime/cloud-failure-presentation";
import type { Message, SessionId } from "@zuse/contracts";
import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { cloudLifecycle } from "~/lib/cloud-lifecycle";
import { connectionSessionKey } from "~/lib/session-key";
import { cloudCatalogAtom, refreshCloudCatalog } from "~/store/cloud-catalog";
import { sessionDeliveryAtom } from "~/store/messages";
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
	// Preparing, resuming, sleeping and failed startup are shown by
	// CloudStartupCard; this line covers delivery and account problems.
	const lifecycleOwned = cloudLifecycle(summary) !== null;
	const failure = cloudFailurePresentation({
		state: failed?.terminal?.state,
		category:
			failed?.terminal?.category ??
			pending?.category ??
			(lifecycleOwned ? undefined : summary?.statusCode),
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
	const reconnectingAuth = (pending?.category ?? providerText ?? "").includes(
		"-auth-reconnecting",
	);
	const label = legacy
		? "This retained chat uses legacy authentication."
		: providerAuthFailure
			? "Reconnect your provider once in Sign In."
			: reconnectingAuth
				? "Reconnecting agent authentication…"
				: (failure?.message ??
					(pending !== undefined && !lifecycleOwned
						? "Waiting for agent"
						: error && !lifecycleOwned
							? "Cloud history could not refresh. Pull to retry."
							: null));
	if (label === null && actionError === null) return null;
	const lastUser = messages[lastUserIndex];
	const draft =
		lastUser?.content._tag === "user" || lastUser?.content._tag === "user_rich"
			? lastUser.content.text
			: "";
	return (
		<View role="status" aria-live="polite" className="gap-2 px-4 py-2">
			<Text className="font-sans text-sm text-muted-foreground">{label}</Text>

			<View className="flex-row flex-wrap gap-2">
				{pending?.cancellable ? (
					<Button
						size="sm"
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
						Cancel Message
					</Button>
				) : null}
				{providerAuthFailure ? (
					<Button
						size="sm"
						variant="ghost"
						onPress={() => router.push("/cloud-auth")}
					>
						Providers
					</Button>
				) : null}
				{legacy || storageLost || outcomeUnknown ? (
					<Button
						size="sm"
						variant="ghost"
						onPress={() =>
							router.push({
								pathname: "/new-chat",
								params: {
									sandbox: "",
									cloudProjectId: summary?.projectId,
									draft,
								},
							})
						}
					>
						{outcomeUnknown ? "New Draft" : "New Chat"}
					</Button>
				) : null}
				{failure?.kind === "update-required" ? (
					<Button
						size="sm"
						variant="ghost"
						onPress={() => router.push("/cloud-auth")}
					>
						Settings
					</Button>
				) : null}
				{failure?.kind === "network" && !reconnectingAuth ? (
					<Button
						size="sm"
						variant="ghost"
						onPress={() => void refreshCloudCatalog()}
					>
						Refresh
					</Button>
				) : null}
			</View>
			{actionError ? (
				<Text
					accessibilityRole="alert"
					className="font-sans text-xs text-danger"
				>
					{actionError}
				</Text>
			) : null}
		</View>
	);
}
