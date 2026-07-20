import type { SessionId } from "@zuse/contracts";
import { proposedPlanMarkdownFromContent } from "@zuse/utils/proposed-plan";
import { router, Stack, useLocalSearchParams } from "expo-router";
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
	const target = messages.find((message) => {
		if (messageId !== undefined && message.id !== messageId) return false;
		if (
			itemId !== undefined &&
			(message.content._tag !== "tool_use" || message.content.itemId !== itemId)
		)
			return false;
		return messageId !== undefined || itemId !== undefined;
	});
	const text =
		target === undefined
			? null
			: proposedPlanMarkdownFromContent(target.content);

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					title: "Plan",
					presentation: "modal",
					headerBackVisible: false,
					headerLargeTitle: false,
				}}
			/>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button
					icon="xmark"
					separateBackground
					onPress={() => router.back()}
				/>
			</Stack.Toolbar>
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
