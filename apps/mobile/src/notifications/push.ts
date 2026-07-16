import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Linking, Platform } from "react-native";

import { relayBaseUrl } from "../auth/config.ts";
import type { WorkosAccount } from "../auth/workos.ts";
import { registerDevice } from "../rpc/relay-client.ts";
import { registerPushTokenForAccount } from "./registration.ts";

const DEVICE_ID_KEY = "zuse.mobile.push.device_id.v1";

export const clearPushRegistration = (): Promise<void> =>
	SecureStore.deleteItemAsync(DEVICE_ID_KEY);

const randomId = (): string => {
	const maybe = globalThis.crypto?.randomUUID;
	if (typeof maybe === "function") return maybe.call(globalThis.crypto);
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getOrCreateDeviceId = async (): Promise<string> => {
	const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
	if (existing !== null) return existing;
	const next = `mobile_${randomId()}`;
	await SecureStore.setItemAsync(DEVICE_ID_KEY, next);
	return next;
};

const getExpoPushToken = async (): Promise<string | null> => {
	const current = await Notifications.getPermissionsAsync();
	const finalStatus =
		current.status === "granted"
			? current.status
			: (await Notifications.requestPermissionsAsync()).status;
	if (finalStatus !== "granted") return null;
	return (await Notifications.getExpoPushTokenAsync()).data;
};

export const registerCurrentDeviceForPush = async (
	account: WorkosAccount | null,
): Promise<boolean> => {
	try {
		return await registerPushTokenForAccount(account, {
			relayUrl: relayBaseUrl,
			platform:
				Platform.OS === "android"
					? "android"
					: Platform.OS === "ios"
						? "ios"
						: "web",
			getDeviceId: getOrCreateDeviceId,
			getPushToken: getExpoPushToken,
			registerDevice,
		});
	} catch {
		return false;
	}
};

export const installNotificationResponseHandler = (): (() => void) => {
	const openResponse = (
		response: Notifications.NotificationResponse | null,
	) => {
		const target = response?.notification.request.content.data?.target;
		if (typeof target !== "string" || target.length === 0) return;
		void Linking.openURL(target).catch(() => {});
		void Notifications.clearLastNotificationResponseAsync();
	};
	void Notifications.getLastNotificationResponseAsync().then(openResponse);
	const subscription =
		Notifications.addNotificationResponseReceivedListener(openResponse);
	return () => subscription.remove();
};
