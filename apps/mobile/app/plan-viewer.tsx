import type { SessionId } from "@zuse/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View } from "react-native";

import { Markdown } from "~/components/messages/markdown";
import { connectionSessionKey } from "~/lib/session-key";
import { selectSessionMessages } from "~/lib/session-messages";
import { useMobileMessagesStore } from "~/store/messages";

export default function PlanViewerScreen() {
	const { conn, sessionId, messageId, itemId } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		messageId?: string;
		itemId?: string;
	}>();
	const messages = useMobileMessagesStore((state) =>
		selectSessionMessages(
			state.messagesBySession,
			connectionSessionKey(conn, sessionId as SessionId),
		),
	);
	const target = messages.find(
		(message) =>
			message.id === messageId ||
			(message.content._tag === "tool_use" &&
				message.content.itemId === itemId),
	);
	const text = (() => {
		if (target?.content._tag === "assistant") return target.content.text;
		if (target?.content._tag !== "tool_use") return null;
		const input = target.content.input;
		return input !== null &&
			typeof input === "object" &&
			"plan" in input &&
			typeof (input as { plan?: unknown }).plan === "string"
			? (input as { plan: string }).plan
			: null;
	})();

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen options={{ title: "Plan", presentation: "modal" }} />
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{ padding: 24, paddingBottom: 48 }}
			>
				{text === null ? (
					<Text className="font-sans text-[15px] leading-6 text-muted-foreground">
						This plan is no longer available.
					</Text>
				) : (
					<Markdown>{text}</Markdown>
				)}
			</ScrollView>
		</View>
	);
}
