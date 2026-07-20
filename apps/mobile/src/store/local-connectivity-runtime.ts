import { router } from "expo-router";
import { useEffect, useRef } from "react";
import {
	closeLocalProxy,
	type LocalProxy,
	type NearbyService,
	onLocalPathChanged,
	onNearbyServicesChanged,
	openLocalProxy,
	startLocalDiscovery,
	stopLocalDiscovery,
} from "../../modules/local-connectivity";
import { verifyPinnedLocalServer } from "../lib/nearby-pairing";
import { useConnectionsStore } from "./connections";

type ActiveRoute = {
	readonly serviceId: string;
	readonly proxy: LocalProxy;
};

/**
 * Keeps stable paired environments attached to disposable Bonjour routes.
 * A path change drops every proxy; the next discovery result replaces the
 * endpoint and increments routeGeneration, which wakes exhausted supervisors.
 */
export function useLocalConnectivityRuntime(): void {
	const hydrated = useConnectionsStore((state) => state.hydrated);
	const activeRoutes = useRef(new Map<string, ActiveRoute>());
	const services = useRef<readonly NearbyService[]>([]);
	const reconciling = useRef(false);
	const reconcileAgain = useRef(false);
	const requestedInitialPairing = useRef(false);

	useEffect(() => {
		if (!hydrated) return;
		let disposed = false;

		const reconcile = async () => {
			if (disposed) return;
			if (reconciling.current) {
				reconcileAgain.current = true;
				return;
			}
			reconciling.current = true;
			try {
				do {
					reconcileAgain.current = false;
					const paired = useConnectionsStore
						.getState()
						.connections.filter(
							(connection) =>
								connection.source === "paired" &&
								(connection.nearbyServiceName !== undefined ||
									(connection.serverPublicKey !== undefined &&
										connection.transportCertificatePin !== undefined)),
						);
					const pairedKeys = new Set(
						paired.map((connection) => connection.key),
					);
					for (const [key, route] of activeRoutes.current) {
						if (pairedKeys.has(key)) continue;
						activeRoutes.current.delete(key);
						await closeLocalProxy(route.proxy.id);
					}
					for (const connection of paired) {
						const candidates =
							connection.serverPublicKey !== undefined &&
							connection.serverKeyPin !== undefined
								? services.current
								: services.current.filter(
										(candidate) =>
											candidate.name === connection.nearbyServiceName,
									);
						const current = activeRoutes.current.get(connection.key);
						if (
							candidates.some((service) => current?.serviceId === service.id)
						) {
							continue;
						}
						let selected:
							| { readonly service: NearbyService; readonly proxy: LocalProxy }
							| undefined;
						for (const service of candidates) {
							let proxy: LocalProxy;
							try {
								proxy = await openLocalProxy({
									...service,
									tlsCertificatePin:
										connection.transportCertificatePin ??
										service.tlsCertificatePin,
								});
							} catch {
								continue;
							}
							try {
								if (
									connection.serverPublicKey !== undefined &&
									connection.serverKeyPin !== undefined
								) {
									await verifyPinnedLocalServer({
										host: proxy.host,
										port: proxy.port,
										publicKey: connection.serverPublicKey,
										pin: connection.serverKeyPin,
									});
								}
								selected = { service, proxy };
								break;
							} catch {
								await closeLocalProxy(proxy.id);
							}
						}
						if (selected === undefined) continue;
						const { service, proxy } = selected;
						activeRoutes.current.set(connection.key, {
							serviceId: service.id,
							proxy,
						});
						await useConnectionsStore.getState().updateDiscoveredRoute({
							key: connection.key,
							host: proxy.host,
							port: proxy.port,
							pathType: service.interfaceName?.startsWith("awdl")
								? "apple-peer"
								: "lan",
							nearbyServiceName: service.name,
							transportCertificatePin:
								connection.transportCertificatePin ?? service.tlsCertificatePin,
						});
						if (current !== undefined) await closeLocalProxy(current.proxy.id);
					}
				} while (reconcileAgain.current && !disposed);
			} finally {
				reconciling.current = false;
			}
		};

		void startLocalDiscovery();
		const removeServices = onNearbyServicesChanged((next) => {
			services.current = next;
			if (
				next.length > 0 &&
				!requestedInitialPairing.current &&
				useConnectionsStore.getState().connections.length === 0
			) {
				requestedInitialPairing.current = true;
				router.push("/connect/nearby");
			}
			void reconcile();
		});
		const removePath = onLocalPathChanged(() => {
			const current = [...activeRoutes.current.values()];
			activeRoutes.current.clear();
			for (const route of current) void closeLocalProxy(route.proxy.id);
			void reconcile();
		});
		const removeConnections = useConnectionsStore.subscribe(() => {
			void reconcile();
		});
		void reconcile();

		return () => {
			disposed = true;
			removeServices();
			removePath();
			removeConnections();
			for (const route of activeRoutes.current.values()) {
				void closeLocalProxy(route.proxy.id);
			}
			activeRoutes.current.clear();
			void stopLocalDiscovery();
		};
	}, [hydrated]);
}
