type HapticsModule = typeof import("expo-haptics");

let Haptics: HapticsModule | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	Haptics = require("expo-haptics") as HapticsModule;
} catch {
	Haptics = null;
}

/** Light tap — row selection, navigation. */
export const lightTap = () => {
	void Haptics?.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
};

/** Selection tick — a subtle state change, e.g. a computer coming online. */
export const selectionTap = () => {
	void Haptics?.selectionAsync().catch(() => {});
};

/** Success notification — a connection landed, an action completed. */
export const successTap = () => {
	void Haptics?.notificationAsync(
		Haptics.NotificationFeedbackType.Success,
	).catch(() => {});
};

/** Error notification — a connection or action failed. */
export const errorTap = () => {
	void Haptics?.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
		() => {},
	);
};
