import "../global.css";
import "~/polyfills";

import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono";
import {
  Inter_400Regular,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { CrashReportOverlay } from "~/components/crash-report-overlay";
import { installCrashReporting } from "~/lib/crash-reporting";
import { installNotificationResponseHandler } from "~/notifications/push";

const BG = "hsl(72 5% 6%)";
const FG = "hsl(72 4% 92%)";
const ACCENT = "hsl(72 98% 54%)";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_600SemiBold,
    Inter_700Bold,
    GeistMono_400Regular,
  });

  useEffect(() => {
    installCrashReporting();
    return installNotificationResponseHandler();
  }, []);

  if (!fontsLoaded) {
    return <View className="flex-1 bg-background" />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          // iOS large-title headers that float over a blurred backdrop as
          // content scrolls beneath them. Screens opt out per-route below.
          headerLargeTitle: true,
          headerTransparent: true,
          headerBlurEffect: "systemChromeMaterialDark",
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          headerStyle: { backgroundColor: "transparent" },
          headerLargeTitleStyle: { color: FG, fontFamily: "Inter_700Bold" },
          headerTitleStyle: { color: FG, fontFamily: "Inter_600SemiBold" },
          headerTintColor: ACCENT,
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: BG },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Chats" }} />
        <Stack.Screen
          name="new-chat"
          options={{
            title: "New Chat",
            headerLargeTitle: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="settings"
          options={{
            title: "Settings",
            presentation: "formSheet",
            headerLargeTitle: false,
            headerTransparent: true,
            contentStyle: { backgroundColor: "transparent" },
            sheetAllowedDetents: [0.52, 0.92],
            sheetCornerRadius: 28,
            sheetGrabberVisible: true,
            sheetLargestUndimmedDetentIndex: 0,
          }}
        />
        <Stack.Screen
          name="plan-viewer"
          options={{
            title: "Plan",
            presentation: "modal",
            headerLargeTitle: false,
          }}
        />
        <Stack.Screen
          name="connect/manual"
          options={{
            title: "Add connection",
            presentation: "formSheet",
            headerLargeTitle: false,
            headerTransparent: false,
            sheetGrabberVisible: true,
            sheetAllowedDetents: [0.55, 0.92],
            sheetCornerRadius: 20,
          }}
        />
        <Stack.Screen
          name="connect/scan"
          options={{
            title: "Scan",
            headerLargeTitle: false,
            presentation: "modal",
          }}
        />
        <Stack.Screen name="c/[conn]/index" options={{ title: "Sessions" }} />
        <Stack.Screen
          name="c/[conn]/session/[sessionId]"
          options={{ title: "Thread", headerLargeTitle: false }}
        />
        <Stack.Screen
          name="smoke"
          options={{ title: "Smoke", headerLargeTitle: false }}
        />
      </Stack>
      <CrashReportOverlay />
    </GestureHandlerRootView>
  );
}
