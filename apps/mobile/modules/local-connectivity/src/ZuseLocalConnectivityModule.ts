import { requireOptionalNativeModule } from "expo";

type EventSubscription = { remove(): void };

export type NearbyService = {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly domain: string;
	readonly interfaceName?: string;
	readonly trustRecordId?: string;
	readonly tlsCertificatePin: string;
};

export type LocalPathEvent = {
	readonly status: "satisfied" | "unsatisfied" | "requiresConnection";
	readonly usesWifi: boolean;
	readonly usesCellular: boolean;
	readonly generation: number;
};

export type LocalProxy = {
	readonly id: string;
	readonly host: "127.0.0.1";
	readonly port: number;
};

type LocalConnectivityNativeModule = {
	startDiscovery(): Promise<void>;
	stopDiscovery(): Promise<void>;
	openProxy(service: NearbyService): Promise<LocalProxy>;
	closeProxy(id: string): Promise<void>;
	proofForTrustRecord(
		recordId: string,
		challenge: string,
	): Promise<string | null>;
	addListener(
		event: "onServicesChanged",
		listener: (event: { readonly services: readonly NearbyService[] }) => void,
	): EventSubscription;
	addListener(
		event: "onPathChanged",
		listener: (event: LocalPathEvent) => void,
	): EventSubscription;
};

const Native = requireOptionalNativeModule<LocalConnectivityNativeModule>(
	"ZuseLocalConnectivity",
);

export const localConnectivityAvailable = Native !== null;

export const startLocalDiscovery = async (): Promise<void> => {
	await Native?.startDiscovery();
};

export const stopLocalDiscovery = async (): Promise<void> => {
	await Native?.stopDiscovery();
};

export const openLocalProxy = async (
	service: NearbyService,
): Promise<LocalProxy> => {
	if (Native === null) throw new Error("local_connectivity_unavailable");
	return Native.openProxy(service);
};

export const closeLocalProxy = async (id: string): Promise<void> => {
	await Native?.closeProxy(id);
};

let latestNearbyServices: readonly NearbyService[] = [];
const nearbyListeners = new Set<(services: readonly NearbyService[]) => void>();
Native?.addListener("onServicesChanged", (event) => {
	latestNearbyServices = event.services;
	for (const listener of nearbyListeners) listener(event.services);
});

export const proofForICloudTrustRecord = async (
	recordId: string,
	challenge: string,
): Promise<string | null> =>
	(await Native?.proofForTrustRecord(recordId, challenge)) ?? null;

export const onNearbyServicesChanged = (
	listener: (services: readonly NearbyService[]) => void,
): (() => void) => {
	nearbyListeners.add(listener);
	listener(latestNearbyServices);
	return () => nearbyListeners.delete(listener);
};

export const onLocalPathChanged = (
	listener: (event: LocalPathEvent) => void,
): (() => void) => {
	const subscription = Native?.addListener("onPathChanged", listener);
	return () => subscription?.remove();
};
