import { type NativeStackNavigationOptions, Stack } from "expo-router";
import { Platform } from "react-native";
import { SafeAreaView } from "react-native-screens/experimental";

import { useSplitExpanded } from "~/components/root-navigator";
import { useIsWideLayout, useReadableContentStyle } from "~/lib/form-factor";
import { SHEET_PRESENTATION, TRANSPARENT_HEADER } from "~/lib/native-header";
import { colors } from "~/theme";

/** The app's navigation stack; on iOS it fills the detail column of the root split view. */
export default function MainLayout() {
	// Wide windows center content in a readable column; headers stay full width.
	const readableContent = useReadableContentStyle();
	// iOS form sheets show system glass through a clear background.
	const sheetBackground = Platform.OS === "ios" ? "transparent" : colors.bg;
	const fullBleedContent = { backgroundColor: colors.bg };
	// Sheets have their own bounded width; window-derived padding squeezes them on iPad.
	const sheetContent = { backgroundColor: sheetBackground };
	const expanded = useSplitExpanded();
	const wideLayout = useIsWideLayout();
	const baseScreenOptions: NativeStackNavigationOptions = {
		headerLargeTitle: true,
		headerTransparent: TRANSPARENT_HEADER,
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
		contentStyle: readableContent,
	};
	const stack = (
		<Stack
			screenLayout={
				Platform.OS === "ios"
					? ({ children }) => (
							<SafeAreaView
								edges={{ left: true, right: true }}
								style={{ flex: 1 }}
							>
								{children}
							</SafeAreaView>
						)
					: undefined
			}
			screenOptions={({ navigation, route }) => {
				const routes: readonly { key: string; name: string }[] =
					navigation.getState().routes;
				const previous =
					routes[routes.findIndex((entry) => entry.key === route.key) - 1];
				// In the split view the stack's root is an empty placeholder, so a chat
				// opened from the sidebar has nothing meaningful to go back to. Other
				// screens (connection setup, New Chat) keep Back so they can be cancelled.
				const splitRoot =
					expanded &&
					previous?.name === "index" &&
					route.name === "c/[conn]/session/[sessionId]";
				return {
					...baseScreenOptions,
					...(splitRoot
						? { headerBackVisible: false, gestureEnabled: false }
						: {}),
				};
			}}
		>
			<Stack.Screen name="index" options={{ title: "Chats" }} />
			<Stack.Screen
				name="onboarding"
				options={{
					headerShown: false,
					presentation: "fullScreenModal",
					gestureEnabled: false,
				}}
			/>
			<Stack.Screen
				name="new-chat"
				options={{
					title: "New Chat",
					headerLargeTitle: false,
					presentation: "card",
					// Applies the readable column itself so header effects span the full width.
					contentStyle: fullBleedContent,
				}}
			/>
			<Stack.Screen
				name="settings"
				options={{
					title: "Settings",
					headerShown: false,
					presentation: SHEET_PRESENTATION,
					headerLargeTitle: false,
					sheetAllowedDetents: [0.92],
					sheetInitialDetentIndex: 0,
					sheetGrabberVisible: true,
					headerTintColor: colors.fg,
					headerTransparent: TRANSPARENT_HEADER,
					// The nested settings stack applies the readable column.
					contentStyle: fullBleedContent,
				}}
			/>
			<Stack.Screen
				name="archives"
				options={{ title: "Archived chats", headerLargeTitle: false }}
			/>
			<Stack.Screen
				name="usage"
				options={{ title: "Usage", headerLargeTitle: false }}
			/>
			<Stack.Screen
				name="developer-tools"
				options={{ title: "Developer tools", headerLargeTitle: false }}
			/>
			<Stack.Screen
				name="plan-viewer"
				options={{
					title: "Plan",
					presentation: "modal",
					contentStyle: fullBleedContent,
					headerLargeTitle: false,
				}}
			/>
			<Stack.Screen
				name="media-viewer"
				options={{
					contentStyle: fullBleedContent,
					headerShown: false,
					presentation: "fullScreenModal",
					animation: "fade",
				}}
			/>
			<Stack.Screen
				name="connect/nearby"
				options={{
					title: "Nearby computers",
					headerLargeTitle: false,
					presentation: "card",
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
					contentStyle: fullBleedContent,
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
				options={{
					title: "Thread",
					headerLargeTitle: false,
					// Applies the readable column itself so header effects span the full width.
					contentStyle: fullBleedContent,
				}}
			/>
			<Stack.Screen
				name="c/[conn]/chat/[chatId]/threads"
				options={{
					title: "Threads",
					headerLargeTitle: false,
					presentation: SHEET_PRESENTATION,
					sheetAllowedDetents: [0.42, 0.92],
					sheetInitialDetentIndex: 0,
					sheetGrabberVisible: true,
					contentStyle: sheetContent,
				}}
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
				name="c/[conn]/session/[sessionId]/terminal"
				options={{
					title: "Terminal",
					headerLargeTitle: false,
					headerTransparent: false,
					gestureEnabled: false,
					contentStyle: { backgroundColor: "#000000" },
				}}
			/>
			<Stack.Screen
				name="c/[conn]/session/[sessionId]/review"
				options={{
					title: "Review changes",
					headerLargeTitle: false,
					// Diffs need width; iPad form sheets are too small to read code in.
					presentation:
						Platform.OS === "ios" && wideLayout
							? "pageSheet"
							: SHEET_PRESENTATION,
					sheetAllowedDetents: [0.72, 1],
					sheetInitialDetentIndex: 0,
					sheetGrabberVisible: true,
					contentStyle: sheetContent,
				}}
			/>
			<Stack.Screen
				name="c/[conn]/session/[sessionId]/resolve-conflict"
				options={{
					title: "Resolve conflict",
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
					contentStyle: fullBleedContent,
				}}
			/>
			<Stack.Screen
				name="smoke"
				options={{ title: "Smoke", headerLargeTitle: false }}
			/>
		</Stack>
	);
	// Apply native safe areas inside each screen, where its rail and sheet insets live.
	return stack;
}
