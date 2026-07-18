import "../global.css";
import "~/polyfills";

import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono";
import { useFonts } from "expo-font";
import * as Linking from "expo-linking";
import { router, Stack } from "expo-router";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Uniwind, useUniwind } from "uniwind";

import { CrashReportOverlay } from "~/components/crash-report-overlay";
import { installCrashReporting } from "~/lib/crash-reporting";
import { isLegacyPairingUrl } from "~/lib/pairing";
import { installNotificationResponseHandler } from "~/notifications/push";
import { colors } from "~/theme";

// The app follows the device appearance. Reset any development-session theme
// override before the first screen renders so light mode cannot inherit dark
// utility styles while native navigation is already light.
Uniwind.setTheme("system");

export default function RootLayout() {
	const { theme } = useUniwind();
	const isDark = theme === "dark";
	const [fontsLoaded] = useFonts({
		GeistMono_400Regular,
	});
	const incomingUrl = Linking.useURL();

	useEffect(() => {
		installCrashReporting();
		return installNotificationResponseHandler();
	}, []);

	useEffect(() => {
		if (incomingUrl !== null && isLegacyPairingUrl(incomingUrl)) {
			router.replace({
				pathname: "/connect/pair",
				params: { pairing: incomingUrl },
			});
		}
	}, [incomingUrl]);

	if (!fontsLoaded) {
		return <View className="flex-1 bg-background" />;
	}

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
				<StatusBar style="auto" />
				<Stack
					screenOptions={{
						// Keep the native header transparent so UIKit can sample scrolling
						// content for its own material at the top edge.
						headerLargeTitle: true,
						headerTransparent: Platform.OS === "ios",
						headerShadowVisible: false,
						headerLargeTitleShadowVisible: false,
						headerStyle:
							Platform.OS === "ios"
								? { backgroundColor: "transparent" }
								: { backgroundColor: colors.bg },
						scrollEdgeEffects:
							Platform.OS === "ios"
								? {
										top: "automatic",
										bottom: "hidden",
										left: "hidden",
										right: "hidden",
									}
								: undefined,
						headerLargeTitleStyle: { color: colors.fg },
						headerTitleStyle: { color: colors.fg },
						headerTintColor: colors.fg,
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
							sheetAllowedDetents: [0.7, 0.92],
							sheetInitialDetentIndex: 0,
							sheetGrabberVisible: true,
							headerTintColor: colors.fg,
							headerTransparent: true,
							contentStyle: { backgroundColor: colors.bg },
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
							presentation: "card",
							headerLargeTitle: false,
							headerTransparent: false,
						}}
					/>
					<Stack.Screen
						name="connect/scan"
						options={{
							title: "Scan",
							headerLargeTitle: false,
							headerShown: false,
							presentation: "fullScreenModal",
						}}
					/>
					<Stack.Screen
						name="connect/pair"
						options={{
							title: "Pair with desktop",
							headerLargeTitle: false,
							presentation: "card",
						}}
					/>
					<Stack.Screen name="c/[conn]/index" options={{ title: "Sessions" }} />
					<Stack.Screen
						name="c/[conn]/session/[sessionId]"
						options={{ title: "Thread", headerLargeTitle: false }}
					/>
					<Stack.Screen
						name="c/[conn]/session/[sessionId]/files"
						options={{
							title: "Files",
							headerLargeTitle: false,
							presentation: "card",
						}}
					/>
					<Stack.Screen
						name="c/[conn]/session/[sessionId]/file"
						options={{
							title: "File",
							headerLargeTitle: false,
							presentation: "card",
						}}
					/>
					<Stack.Screen
						name="c/[conn]/session/[sessionId]/review"
						options={{
							title: "Review changes",
							headerLargeTitle: false,
							presentation: "card",
						}}
					/>
					<Stack.Screen
						name="c/[conn]/session/[sessionId]/tool/[itemId]"
						options={{
							title: "Tool details",
							headerLargeTitle: false,
							presentation: "modal",
						}}
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
