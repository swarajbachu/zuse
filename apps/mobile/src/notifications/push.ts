import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { Platform } from "react-native";
import { apiBaseUrl } from "../auth/config.ts";
import type { WorkosAccount } from "../auth/workos.ts";
import { captureMobileAnalytics } from "../lib/analytics.ts";
import {
	clearDeviceIdentity,
	existingDeviceId,
	getOrCreateDeviceId,
} from "../lib/device-identity.ts";
import { registerDevice, revokeMobileDevice } from "../rpc/api-client.ts";
import {
	logConnectionDiagnostic,
	logConnectionProblem,
} from "../rpc/connection-diagnostics";
import { registerPushTokenForAccount } from "./registration.ts";
import { notificationRoute } from "./route";

export class PushRegistrationTimeout extends Error {}

const withPushTimeout = async <T>(
	operation: Promise<T>,
	message: string,
): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new PushRegistrationTimeout(message)),
					25_000,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

export const clearPushRegistration = (): Promise<void> => clearDeviceIdentity();

const getExpoPushToken = async (): Promise<string | null> => {
	const current = await Notifications.getPermissionsAsync();
	const finalStatus =
		current.status === "granted"
			? current.status
			: (await Notifications.requestPermissionsAsync()).status;
	captureMobileAnalytics("notification permission decided", {
		decision: finalStatus === "granted" ? "granted" : "denied",
	});
	if (finalStatus !== "granted") return null;
	logConnectionDiagnostic("push.native_token.start");
	const devicePushToken = await withPushTimeout(
		Notifications.getDevicePushTokenAsync(),
		"Apple or Google did not return a device token. Check your network and try again.",
	);
	logConnectionDiagnostic("push.native_token.ok");
	const token = await withPushTimeout(
		Notifications.getExpoPushTokenAsync({ devicePushToken }),
		"The push notification service did not respond. Please try again.",
	);
	logConnectionDiagnostic("push.expo_token.ok");
	return token.data;
};

export const registerCurrentDeviceForPush = async (
	account: WorkosAccount | null,
): Promise<boolean> => {
	try {
		return await registerPushTokenForAccount(account, {
			apiUrl: apiBaseUrl,
			platform:
				Platform.OS === "android"
					? "android"
					: Platform.OS === "ios"
						? "ios"
						: "web",
			getDeviceId: getOrCreateDeviceId,
			getPushToken: getExpoPushToken,
			registerDevice: (input) =>
				withPushTimeout(
					registerDevice(input),
					"Zuse could not finish registering this device. Please try again.",
				),
		});
	} catch (error) {
		logConnectionProblem("push.registration.fail", { error });
		throw error;
	}
};

export const installNotificationResponseHandler = (): (() => void) => {
	Notifications.setNotificationHandler({
		handleNotification: async () => ({
			shouldShowBanner: true,
			shouldShowList: true,
			shouldPlaySound: true,
			shouldSetBadge: false,
		}),
	});
	const openResponse = (
		response: Notifications.NotificationResponse | null,
	) => {
		const target = response?.notification.request.content.data?.target;
		const route = notificationRoute(target);
		if (route === null) return;
		captureMobileAnalytics("notification opened", {
			notification_kind: "attention_required",
		});
		router.replace(route);
		void Notifications.clearLastNotificationResponseAsync();
	};
	void Notifications.getLastNotificationResponseAsync().then(openResponse);
	const subscription =
		Notifications.addNotificationResponseReceivedListener(openResponse);
	return () => subscription.remove();
};

/** Preserve identity/auth on failure so logout can retry server revocation. */
export const revokeCurrentDevicePush = async (): Promise<void> => {
	const deviceId = await existingDeviceId();
	if (deviceId === null) return;
	await revokeMobileDevice(deviceId);
	await Notifications.unregisterForNotificationsAsync();
	await Notifications.dismissAllNotificationsAsync();
	await clearDeviceIdentity();
};
