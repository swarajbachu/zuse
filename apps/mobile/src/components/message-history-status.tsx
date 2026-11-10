import "@zuse/i18n/english/chat";
import { useAtomValue } from "@effect/atom-react";
import type { SessionId } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { connectionSessionKey } from "~/lib/session-key";
import { hasOlderMessagesAtom } from "~/store/messages";
import {
	mobileHistory,
	mobileHistoryKey,
	mobileHistoryRef,
	requestMobileHistoryPage,
} from "~/store/mobile-client-bus";

/** History progress is shared by cloud and desktop-hosted mobile chats. */
export function MessageHistoryStatus({
	connKey,
	sessionId,
	restorePosition = false,
}: {
	connKey: string;
	sessionId: SessionId;
	restorePosition?: boolean;
}) {
	const { message } = useMessages(["chat"]);
	const ref = mobileHistoryRef(connKey, sessionId);
	const key = ref === null ? "" : mobileHistoryKey(ref);
	const snapshot = useCallback(() => mobileHistory.status(key), [key]);
	const status = useSyncExternalStore(
		mobileHistory.subscribe,
		snapshot,
		snapshot,
	);
	const hasOlder = useAtomValue(
		hasOlderMessagesAtom(connectionSessionKey(connKey, sessionId)),
	);
	useEffect(() => {
		if (restorePosition && hasOlder && status === "idle" && ref !== null)
			requestMobileHistoryPage(ref);
	}, [restorePosition, hasOlder, status, ref]);
	if (!hasOlder) return null;
	return (
		<View role="status" aria-live="polite" className="px-4 py-1">
			{status === "loading" ? (
				<Text className="font-sans text-xs text-muted-foreground">
					{message("chat:cloud_history_loading")}
				</Text>
			) : (
				<Button
					variant="ghost"
					size="sm"
					onPress={() =>
						status === "failed"
							? mobileHistory.retry(key)
							: ref !== null && requestMobileHistoryPage(ref)
					}
				>
					{message(
						status === "failed"
							? "chat:cloud_history_retry"
							: "chat:history_load_older",
					)}
				</Button>
			)}
		</View>
	);
}
