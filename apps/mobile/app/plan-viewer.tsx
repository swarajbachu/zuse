import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View } from "react-native";

import { Markdown } from "~/components/messages/markdown";
import { getPlanDocument } from "~/store/plan-viewer";

export default function PlanViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const text = typeof id === "string" ? getPlanDocument(id) : null;

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
