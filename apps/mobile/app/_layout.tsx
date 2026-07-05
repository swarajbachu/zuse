import "../global.css";
import "~/polyfills";

import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono";
import { Inter_400Regular, Inter_600SemiBold } from "@expo-google-fonts/inter";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_600SemiBold,
    GeistMono_400Regular
  });

  if (!fontsLoaded) {
    return <View className="flex-1 bg-background" />;
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "hsl(72 5% 6%)" },
          headerTintColor: "hsl(72 4% 92%)",
          headerShadowVisible: false,
          contentStyle: { backgroundColor: "hsl(72 5% 6%)" }
        }}
      >
        <Stack.Screen name="index" options={{ title: "Connections" }} />
        <Stack.Screen name="smoke" options={{ title: "Smoke" }} />
        <Stack.Screen name="connect/scan" options={{ title: "Scan" }} />
        <Stack.Screen name="c/[conn]/index" options={{ title: "Sessions" }} />
        <Stack.Screen name="c/[conn]/session/[sessionId]" options={{ title: "Thread" }} />
      </Stack>
    </>
  );
}
