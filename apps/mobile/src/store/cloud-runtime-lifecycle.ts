import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { resetCloudRuntime } from "~/rpc/cloud-runtime";
import { disposeConnection } from "~/rpc/connection";
import { authAccountAtom } from "./auth";
import {
	cloudCatalogAtom,
	cloudConnectionsAtom,
	refreshCloudCatalog,
	refreshCloudOrganizations,
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
	const retainedConnections = useRef(connections);
	useEffect(() => {
		setCloudCatalogAccount(accountId);
		if (accountId === null) return;
		let active = AppState.currentState !== "background";
		let nextMembershipRefresh = 0;
		const refresh = (foreground = false) => {
			if (!active) return;
			void refreshCloudCatalog();
			if (
				mobileReleaseFeatures.organizationWorkspaces &&
				(foreground || Date.now() >= nextMembershipRefresh)
			) {
				nextMembershipRefresh = Date.now() + 30_000;
				void refreshCloudOrganizations().catch(() => undefined);
			}
		};
		refresh();
		const timer = setInterval(refresh, 10_000);
		const subscription = AppState.addEventListener("change", (state) => {
			active = state === "active";
			refresh(active);
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
		if (
			accountId !== null &&
			catalog.accountId === accountId &&
			appAtomRegistry.get(cloudCatalogAtom).scope === catalog.scope
		)
			void refreshCloudCatalog();
	}, [accountId, catalog.accountId, catalog.scope]);
	useEffect(() => {
		if (account?.id !== catalog.accountId) return;
		let active = true;
		void accountTeardown.then(() => {
			if (
				!active ||
				appAtomRegistry.get(cloudCatalogAtom).accountId !== account?.id ||
				appAtomRegistry.get(cloudCatalogAtom).scope !== catalog.scope
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
	}, [account?.id, catalog.accountId, catalog.scope, connections]);
	useEffect(() => {
		const visible = new Set(connections.map((connection) => connection.key));
		const removed = retainedConnections.current.filter(
			(connection) => !visible.has(connection.key),
		);
		retainedConnections.current = connections;
		for (const connection of removed)
			void disposeConnection(connection).catch(() => undefined);
	}, [connections]);
}
