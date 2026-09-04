import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { AppState } from "react-native";
import { resetCloudRuntime } from "~/rpc/cloud-runtime";
import { disposeConnection } from "~/rpc/connection";
import { authAccountAtom } from "./auth";
import {
	cloudCatalogAtom,
	cloudConnectionsAtom,
	refreshCloudCatalog,
	setCloudCatalogAccount,
} from "./cloud-catalog";
import { resetMessagesRuntime } from "./messages";
import {
	mobileClientBus,
	registerMobileEnvironment,
} from "./mobile-client-bus";
import { appAtomRegistry } from "./registry";
import { resetSessionsRuntime } from "./sessions";

let accountTeardown: Promise<unknown> = Promise.resolve();

/** Account catalog ownership is independent of any screen or paired device. */
export function useCloudRuntimeLifecycle(): void {
	const account = useAtomValue(authAccountAtom);
	const accountId = account?.id ?? null;
	const connections = useAtomValue(cloudConnectionsAtom);
	const catalog = useAtomValue(cloudCatalogAtom);
	useEffect(() => {
		setCloudCatalogAccount(accountId);
		if (accountId === null) return;
		let active = AppState.currentState !== "background";
		const refresh = () => {
			if (active) void refreshCloudCatalog();
		};
		refresh();
		const timer = setInterval(refresh, 10_000);
		const subscription = AppState.addEventListener("change", (state) => {
			active = state === "active";
			refresh();
		});
		return () => {
			clearInterval(timer);
			subscription.remove();
			const previousConnections = appAtomRegistry.get(cloudConnectionsAtom);
			setCloudCatalogAccount(null);
			resetCloudRuntime();
			accountTeardown = Promise.allSettled([
				...previousConnections.map(disposeConnection),
				resetMessagesRuntime(),
				resetSessionsRuntime(),
			]);
		};
	}, [accountId]);
	useEffect(() => {
		if (account?.id !== catalog.accountId) return;
		let active = true;
		void accountTeardown.then(() => {
			if (
				!active ||
				appAtomRegistry.get(cloudCatalogAtom).accountId !== account?.id
			)
				return;
			for (const connection of connections) {
				const environmentId = registerMobileEnvironment(
					connection.key,
					connection,
				);
				void mobileClientBus()
					.flushDurableOutbox(environmentId)
					.catch(() => undefined);
			}
		});
		return () => {
			active = false;
		};
	}, [account?.id, catalog.accountId, connections]);
}
