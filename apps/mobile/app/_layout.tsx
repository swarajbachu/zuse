import "../global.css";
import "~/polyfills";

import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { CrashReportOverlay } from "~/components/crash-report-overlay";
import { installCrashReporting } from "~/lib/crash-reporting";
import { installNotificationResponseHandler } from "~/notifications/push";
import { colors } from "~/theme";

export default function RootLayout() {
	const colorScheme = useColorScheme();
	const [fontsLoaded] = useFonts({
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
			<ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
				<StatusBar style="auto" />
				<Stack
					screenOptions={{
						// iOS large-title headers that float over a blurred backdrop as
						// content scrolls beneath them. Screens opt out per-route below.
						headerLargeTitle: true,
						headerTransparent: true,
						headerBlurEffect:
							colorScheme === "dark"
								? "systemChromeMaterialDark"
								: "systemChromeMaterialLight",
						headerShadowVisible: false,
						headerLargeTitleShadowVisible: false,
						headerStyle: { backgroundColor: "transparent" },
						headerLargeTitleStyle: { color: colors.fg },
						headerTitleStyle: { color: colors.fg },
						headerTintColor: colors.accent,
						headerBackButtonDisplayMode: "minimal",
						contentStyle: { backgroundColor: colors.bg },
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
						name="c/[conn]/session/[sessionId]/tool/[itemId]"
						options={{ title: "Tool details", headerLargeTitle: false }}
					/>
					<Stack.Screen
						name="smoke"
						options={{ title: "Smoke", headerLargeTitle: false }}
					/>
				</Stack>
				<CrashReportOverlay />
			</ThemeProvider>
		</GestureHandlerRootView>
	);
}
