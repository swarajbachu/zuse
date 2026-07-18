import { Platform } from "react-native";

export const translucentNativeHeaderOptions =
	Platform.OS === "ios"
		? ({
				headerTransparent: true,
				headerBlurEffect: "systemUltraThinMaterial",
				headerShadowVisible: false,
				headerStyle: { backgroundColor: "transparent" },
			} as const)
		: {};
