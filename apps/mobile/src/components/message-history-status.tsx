import "@zuse/i18n/english/chat";
import { useAtomValue } from "@effect/atom-react";
import type { SessionId } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useCallback, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { connectionSessionKey } from "~/lib/session-key";
import { hasOlderMessagesAtom } from "~/store/messages";
import {
	mobileHistory,
	mobileHistoryKey,
	mobileHistoryRef,
} from "~/store/mobile-client-bus";

/** History progress is shared by cloud and desktop-hosted mobile chats. */
export function MessageHistoryStatus({
	connKey,
	sessionId,
}: {
	connKey: string;
	sessionId: SessionId;
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
	if (!hasOlder || status === "idle") return null;
	return (
		<View role="status" aria-live="polite" className="px-4 py-1">
			{status === "loading" ? (
				<Text className="font-sans text-xs text-muted-foreground">
					{message("chat:cloud_history_loading")}
				</Text>
			) : (
				<Button
					variant="ghost"
					className="h-7"
					onPress={() => mobileHistory.retry(key)}
				>
					{message("chat:cloud_history_retry")}
				</Button>
			)}
		</View>
	);
}
