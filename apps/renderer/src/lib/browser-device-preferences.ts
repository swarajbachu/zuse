import { DevicePreferences, KeybindingsFile } from "@zuse/contracts";
import { message } from "@zuse/i18n";
import { Schema } from "effect";
import { toastManager } from "../components/ui/toast.tsx";
import { createAtomStore } from "../state/atom-store.ts";

const STORAGE_KEY = "zuse.browser.device-preferences.v1";
const BrowserPreferences = Schema.Struct({
	...DevicePreferences.fields,
	keybindings: Schema.optional(KeybindingsFile.fields.rules),
	/**
	 * Experimental thread list sidebar. A layout choice for this app window
	 * only: the sidebar shows chats from every computer and the cloud, so the
	 * setting must not live in (or follow) any computer's settings file.
	 */
	experimentalThreadListSidebar: Schema.optional(Schema.Boolean),
});
const storage = () =>
	typeof window === "undefined" ? null : window.localStorage;
const read = (): typeof BrowserPreferences.Type => {
	try {
		return Schema.decodeUnknownSync(BrowserPreferences)(
			JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "{}"),
		);
	} catch {
		return {};
	}
};

/**
 * Preferences owned by this app install (local storage), independent of the
 * active computer and of account configuration.
 */
export const useBrowserDevicePreferences = createAtomStore<
	typeof BrowserPreferences.Type
>(() => read());

export const updateBrowserDevicePreferences = (
	patch: typeof BrowserPreferences.Type,
): void => {
	const next = {
		...useBrowserDevicePreferences.getState(),
		...Schema.decodeUnknownSync(BrowserPreferences)(patch),
	};
	const target = storage();
	if (target === null)
		throw new Error("Browser preference storage is unavailable.");
	target.setItem(STORAGE_KEY, JSON.stringify(next));
	useBrowserDevicePreferences.setState(next, true);
};

if (typeof window !== "undefined")
	window.addEventListener("storage", (event) => {
		if (
			event.storageArea === storage() &&
			(event.key === STORAGE_KEY || event.key === null)
		)
			useBrowserDevicePreferences.setState(read(), true);
	});

/** Whether this app shows the experimental thread list instead of the project tree. */
export const useThreadListSidebarEnabled = (): boolean =>
	useBrowserDevicePreferences(
		(preferences) => preferences.experimentalThreadListSidebar === true,
	);

/** Saves the toggle for this install; a failed write keeps the old value and says so. */
export const setThreadListSidebarEnabled = (enabled: boolean): void => {
	try {
		updateBrowserDevicePreferences({ experimentalThreadListSidebar: enabled });
	} catch {
		toastManager.add({
			type: "error",
			title: message("common:device_preferences_save_failed"),
		});
	}
};
