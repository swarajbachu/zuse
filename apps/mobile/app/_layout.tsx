import "../global.css";
import "~/polyfills";

import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono";
import { useFonts } from "expo-font";
import * as Linking from "expo-linking";
import { router, usePathname } from "expo-router";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "expo-router/react-navigation";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Dimensions, Platform, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Uniwind, useUniwind } from "uniwind";

import { CrashReportOverlay } from "~/components/crash-report-overlay";
import { RootNavigator } from "~/components/root-navigator";
import { TextPromptHost } from "~/components/text-prompt-host";
import { useMobileAnalytics } from "~/hooks/use-mobile-analytics";
import { noteMobileInteraction } from "~/lib/analytics";
import { installCrashReporting } from "~/lib/crash-reporting";
import { shouldLockPortrait } from "~/lib/form-factor";
import { isLegacyPairingUrl } from "~/lib/pairing";
import { installNotificationResponseHandler } from "~/notifications/push";
import { usePushRegistration } from "~/notifications/use-push-registration";
import { useCloudRuntimeLifecycle } from "~/store/cloud-runtime-lifecycle";
import { useLocalConnectivityRuntime } from "~/store/local-connectivity-runtime";
import { AppAtomProvider } from "~/store/registry";

Uniwind.setTheme("system");

function ConnectivityRuntimeBridge() {
	useLocalConnectivityRuntime();
	useCloudRuntimeLifecycle();
	usePushRegistration();
	const pathname = usePathname();
	useMobileAnalytics(pathname);
	// Re-evaluated on resize so folding or unfolding an iPhone Duo updates rotation.
	const { width, height } = useWindowDimensions();
	useEffect(() => {
		void width;
		void height;
		// iOS follows system rotation; compact Android screens keep portrait.
		const lock = shouldLockPortrait(Dimensions.get("screen"))
			? ScreenOrientation.lockAsync(
					pathname.endsWith("/terminal")
						? ScreenOrientation.OrientationLock.ALL
						: ScreenOrientation.OrientationLock.PORTRAIT_UP,
				)
			: ScreenOrientation.unlockAsync();
		void lock.catch(() => undefined);
	}, [pathname, width, height]);
	return null;
}

export default function RootLayout() {
	const { theme } = useUniwind();
	const isDark = theme === "dark";
	const [fontsLoaded, fontError] = useFonts({
		GeistMono_400Regular,
	});
	const incomingUrl = Linking.useLinkingURL();

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

	if (fontError) {
		throw fontError;
	}

	if (!fontsLoaded) {
		return <View className="flex-1 bg-background" />;
	}

	return (
		<AppAtomProvider>
			<GestureHandlerRootView
				style={{ flex: 1 }}
				onTouchStart={noteMobileInteraction}
			>
				<KeyboardProvider statusBarTranslucent>
					<ConnectivityRuntimeBridge />
					<ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
						<StatusBar style="auto" />
						<RootNavigator />
						<CrashReportOverlay />
						{Platform.OS === "ios" ? null : <TextPromptHost />}
					</ThemeProvider>
				</KeyboardProvider>
			</GestureHandlerRootView>
		</AppAtomProvider>
	);
}
