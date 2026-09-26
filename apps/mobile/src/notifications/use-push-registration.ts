import { useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState } from "react-native";
import { authAccountAtom } from "~/store/auth";
import { registerCurrentDeviceForPush } from "./push";

/** Resume registration after permission was granted in Settings or the app was rebuilt. */
export function usePushRegistration(): void {
	const account = useAtomValue(authAccountAtom);
	useEffect(() => {
		if (account === null) return;
		let active = true;
		let pending = false;
		const register = async () => {
			if (pending || !active) return;
			pending = true;
			try {
				const permission = await Notifications.getPermissionsAsync();
				if (active && permission.status === "granted")
					await registerCurrentDeviceForPush(account);
			} catch {
				/* The shared registration path records the failure; manual retry stays available. */
			} finally {
				pending = false;
			}
		};
		void register();
		const subscription = AppState.addEventListener("change", (state) => {
			if (state === "active") void register();
		});
		return () => {
			active = false;
			subscription.remove();
		};
	}, [account]);
}
