import { useAtomValue } from "@effect/atom-react";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import {
	closeLocalProxy,
	type LocalProxy,
	type NearbyService,
	onLocalDiscoveryStateChanged,
	onLocalPathChanged,
	onNearbyServicesChanged,
	openLocalProxy,
	startLocalDiscovery,
	stopLocalDiscovery,
} from "../../modules/local-connectivity";
import {
	hasCurrentLocalRoute,
	openVerifiedLocalRoute,
} from "../lib/local-route";
import { verifyPinnedLocalServer } from "../lib/nearby-pairing";
import {
	applyConnectionOptions,
	getConnectionSnapshot,
	retryConnectionNow,
} from "../rpc/connection";
import {
	connectionsAtom,
	connectionsHydratedAtom,
	currentConnections,
	updateDiscoveredConnectionRoute,
} from "./connections";
import { appAtomRegistry } from "./registry";

type ActiveRoute = {
	readonly routeId: string;
	readonly proxy: LocalProxy;
};

/**
 * Keeps stable paired environments attached to disposable Bonjour routes.
 * A path change (Wi-Fi switch) invalidates everything at once: proxies are
 * closed, the service cache is dropped (services discovered on the old
 * network are unreachable by definition), and the native side restarts the
 * Bonjour browser. When a fresh route lands, routeGeneration is bumped and
 * the connection supervisor is woken directly — recovery does not depend on
 * a screen being mounted or on the retry budget not being exhausted.
 */
export function useLocalConnectivityRuntime(): void {
	const hydrated = useAtomValue(connectionsHydratedAtom);
	const activeRoutes = useRef(new Map<string, ActiveRoute>());
	const services = useRef<readonly NearbyService[]>([]);
	// Incremented on every path change/background; an in-flight reconcile that
	// crosses an epoch boundary discards its work instead of pinning a route
	// that belongs to the network that just went away.
	const pathEpoch = useRef(0);
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
					const epoch = pathEpoch.current;
					const paired = currentConnections().filter(
						(connection) =>
							connection.source === "paired" &&
							(connection.nearbyServiceName !== undefined ||
								(connection.serverPublicKey !== undefined &&
									connection.transportCertificatePin !== undefined)),
					);
					console.info("[zuse:nearby] reconcile.pass", {
						paired: paired.map((connection) => connection.key),
						services: services.current.length,
					});
					const pairedKeys = new Set(paired.map((connection) => connection.key));
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
						console.info("[zuse:nearby] reconcile.connection", {
							connectionKey: connection.key,
							candidates: candidates.map((candidate) => ({
								name: candidate.name,
								routeId: candidate.routeId,
								interface: candidate.interfaceName ?? null,
							})),
							currentRouteId: current?.routeId ?? null,
							pinned: connection.serverPublicKey !== undefined,
						});
						if (hasCurrentLocalRoute(current?.routeId, candidates)) {
							// Route is fine but the supervisor may have exhausted its
							// retry budget while the network settled — nudge it awake.
							if (getConnectionSnapshot(connection).status === "error") {
								console.info("[zuse:nearby] route.current.nudge_exhausted", {
									connectionKey: connection.key,
								});
								retryConnectionNow(connection);
							}
							continue;
						}
						let selected:
							| { readonly service: NearbyService; readonly proxy: LocalProxy }
							| undefined;
						for (const service of candidates) {
							try {
								const serverPublicKey = connection.serverPublicKey;
								const serverKeyPin = connection.serverKeyPin;
								const securedService = {
									...service,
									tlsCertificatePin:
										connection.transportCertificatePin ??
										service.tlsCertificatePin,
								};
								const proxy =
									serverPublicKey !== undefined && serverKeyPin !== undefined
										? await openVerifiedLocalRoute({
												service: securedService,
												open: openLocalProxy,
												close: (candidate) => closeLocalProxy(candidate.id),
												verify: (candidate) =>
													verifyPinnedLocalServer({
														host: candidate.host,
														port: candidate.port,
														publicKey: serverPublicKey,
														pin: serverKeyPin,
													}),
											})
										: await openLocalProxy(securedService);
								selected = { service, proxy };
								break;
							} catch (cause) {
								console.warn("[zuse:nearby] route.candidate.failed", {
									connectionKey: connection.key,
									service: service.name,
									interface: service.interfaceName ?? null,
									reason:
										cause instanceof Error ? cause.message : String(cause),
								});
							}
						}
						if (selected === undefined) {
							console.info("[zuse:nearby] route.unresolved", {
								connectionKey: connection.key,
								candidateCount: candidates.length,
							});
							continue;
						}
						if (pathEpoch.current !== epoch) {
							// The network changed while we were opening this proxy; it
							// points at the old path. Drop it and start the pass over.
							await closeLocalProxy(selected.proxy.id).catch(() => {});
							reconcileAgain.current = true;
							break;
						}
						const { service, proxy } = selected;
						activeRoutes.current.set(connection.key, {
							routeId: service.routeId,
							proxy,
						});
						console.info("[zuse:nearby] route.replaced", {
							connectionKey: connection.key,
							previousRouteId: current?.routeId ?? null,
							nextRouteId: service.routeId,
							proxyPort: proxy.port,
						});
						await updateDiscoveredConnectionRoute({
							key: connection.key,
							host: proxy.host,
							port: proxy.port,
							pathType: service.interfaceName?.startsWith("awdl")
								? "apple-peer"
								: "lan",
							nearbyServiceName: service.name,
							transportCertificatePin:
								connection.transportCertificatePin ??
								service.tlsCertificatePin,
						});
						// Wake the supervisor with the fresh route immediately (the
						// routeGeneration bump makes it reconnect, even from an
						// exhausted "error" state) instead of waiting for a mounted
						// screen to re-subscribe with the new record.
						const updated = currentConnections().find(
							(record) => record.key === connection.key,
						);
						if (updated !== undefined) applyConnectionOptions(updated);
						if (current !== undefined) await closeLocalProxy(current.proxy.id);
					}
				} while (reconcileAgain.current && !disposed);
			} finally {
				reconciling.current = false;
			}
		};

		const invalidateRoutes = async () => {
			pathEpoch.current += 1;
			// Services discovered on the previous network are unreachable; a
			// fresh browse (restarted below) will repopulate the cache.
			services.current = [];
			const current = [...activeRoutes.current.values()];
			activeRoutes.current.clear();
			await Promise.allSettled(
				current.map((route) => closeLocalProxy(route.proxy.id)),
			);
		};

		// Full teardown + restart of native discovery. The stop/start pair
		// re-creates the Bonjour browser on whatever network is current — this
		// is the JS-driven recovery path that works regardless of what the
		// native browser thinks its state is.
		let restartingDiscovery = false;
		// Starting discovery creates a fresh NWPathMonitor, and a new monitor
		// ALWAYS fires its current path immediately. Without suppression that
		// initial event looks like a network change and triggers another
		// restart — an infinite restart loop. Also rate-limit real restarts so
		// a flapping path can't thrash the radio.
		let suppressNextPathRestart = true; // initial startLocalDiscovery below
		let lastPathRestartAt = 0;
		const restartDiscovery = async () => {
			if (disposed || restartingDiscovery) return;
			console.info("[zuse:nearby] discovery.restart");
			restartingDiscovery = true;
			try {
				await invalidateRoutes();
				await stopLocalDiscovery().catch(() => {});
				suppressNextPathRestart = true;
				await startLocalDiscovery().catch(() => {});
			} finally {
				restartingDiscovery = false;
			}
			void reconcile();
		};

		void startLocalDiscovery();
		const removeServices = onNearbyServicesChanged((next) => {
			console.info("[zuse:nearby] services.changed", {
				count: next.length,
				names: next.map((service) => service.name),
			});
			services.current = next;
			if (
				next.length > 0 &&
				!requestedInitialPairing.current &&
				currentConnections().length === 0
			) {
				requestedInitialPairing.current = true;
				router.push("/connect/nearby");
			}
			void reconcile();
		});
		const removePath = onLocalPathChanged((event) => {
			console.info("[zuse:nearby] path.changed", {
				status: event.status,
				usesWifi: event.usesWifi,
				generation: event.generation,
			});
			if (suppressNextPathRestart) {
				// Initial fire of a monitor we just (re)started — not a change.
				suppressNextPathRestart = false;
				void reconcile();
				return;
			}
			const now = Date.now();
			if (now - lastPathRestartAt < 10_000) {
				void reconcile();
				return;
			}
			lastPathRestartAt = now;
			void restartDiscovery();
		});
		// A browser parked in "waiting"/"failed" (typical after a Wi-Fi switch)
		// never re-emits services on its own — restart it after a grace period
		// with backoff (3s → 24s) so a phone with no network doesn't churn;
		// the backoff resets as soon as discovery reports healthy again.
		let unhealthyRestartTimer: ReturnType<typeof setTimeout> | null = null;
		let unhealthyRestartCount = 0;
		const removeDiscoveryState = onLocalDiscoveryStateChanged((state) => {
			console.info("[zuse:nearby] discovery.state", state);
			if (state.state === "waiting" || state.state === "failed") {
				const delay = Math.min(24_000, 3_000 * 2 ** unhealthyRestartCount);
				unhealthyRestartTimer ??= setTimeout(() => {
					unhealthyRestartTimer = null;
					unhealthyRestartCount += 1;
					void restartDiscovery();
				}, delay);
				return;
			}
			if (state.state === "ready") {
				unhealthyRestartCount = 0;
				if (unhealthyRestartTimer !== null) {
					clearTimeout(unhealthyRestartTimer);
					unhealthyRestartTimer = null;
				}
			}
		});
		// Backgrounding cancels every native proxy; drop the JS mirror so a
		// foreground reconcile rebuilds routes instead of trusting dead ids.
		const appStateSubscription = AppState.addEventListener(
			"change",
			(state) => {
				if (state === "background") {
					pathEpoch.current += 1;
					services.current = [];
					activeRoutes.current.clear();
					return;
				}
				if (state === "active") void reconcile();
			},
		);
		const removeConnections = appAtomRegistry.subscribe(
			connectionsAtom,
			() => {
				void reconcile();
			},
			{ immediate: true },
		);
		void reconcile();

		return () => {
			disposed = true;
			removeServices();
			removePath();
			removeDiscoveryState();
			if (unhealthyRestartTimer !== null) clearTimeout(unhealthyRestartTimer);
			appStateSubscription.remove();
			removeConnections();
			for (const route of activeRoutes.current.values()) {
				void closeLocalProxy(route.proxy.id);
			}
			activeRoutes.current.clear();
			void stopLocalDiscovery();
		};
	}, [hydrated]);
}
