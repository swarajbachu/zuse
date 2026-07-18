import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const DEVICE_ID_KEY = "zuse.mobile.push.device_id.v1";
let pendingDeviceId: Promise<string> | null = null;
let pendingClear: Promise<void> | null = null;

const randomId = (): string => {
	const maybe = globalThis.crypto?.randomUUID;
	if (typeof maybe === "function") return maybe.call(globalThis.crypto);
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const getOrCreateDeviceId = async (): Promise<string> => {
	if (pendingClear !== null) {
		await pendingClear;
		return getOrCreateDeviceId();
	}
	if (pendingDeviceId !== null) return pendingDeviceId;
	const operation = (async () => {
		const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
		if (existing !== null) return existing;
		const next = `mobile_${randomId()}`;
		await SecureStore.setItemAsync(DEVICE_ID_KEY, next);
		return next;
	})();
	pendingDeviceId = operation;
	try {
		return await operation;
	} finally {
		if (pendingDeviceId === operation) pendingDeviceId = null;
	}
};

export const clearDeviceIdentity = async (): Promise<void> => {
	if (pendingClear !== null) return pendingClear;
	const operation = (async () => {
		await pendingDeviceId?.catch(() => {});
		await SecureStore.deleteItemAsync(DEVICE_ID_KEY);
	})();
	pendingClear = operation;
	try {
		await operation;
	} finally {
		if (pendingClear === operation) pendingClear = null;
	}
};

export const deviceLabel = (): string =>
	Platform.OS === "ios"
		? "iPhone"
		: Platform.OS === "android"
			? "Android phone"
			: "Mobile device";
