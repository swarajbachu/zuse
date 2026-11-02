import { beforeEach, expect, test, vi } from "vitest";
import type {
	LocalPathEvent,
	NearbyService,
} from "../../../modules/local-connectivity";
import type { ConnectionRecord } from "../../../src/lib/connection-records";
import { useLocalConnectivityRuntime } from "../../../src/store/local-connectivity-runtime";
import { recoverLocalRoute } from "../../../src/store/local-route-recovery";

const state = vi.hoisted(() => ({
	connections: [] as ConnectionRecord[],
	close: vi.fn(async () => {}),
	open: vi.fn(async (service: NearbyService) => ({
		id: service.routeId,
		host: "localhost",
		port: 1234,
	})),
	pathListener: null as ((event: LocalPathEvent) => void) | null,
	servicesListener: null as
		| ((services: readonly NearbyService[]) => void)
		| null,
	cleanups: [] as (() => void)[],
	start: vi.fn(async () => {}),
	stop: vi.fn(async () => {}),
}));
vi.mock("react", () => ({
	useRef: (current: unknown) => ({ current }),
	useEffect: (effect: () => (() => void) | undefined) => {
		const cleanup = effect();
		if (cleanup) state.cleanups.push(cleanup);
	},
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../modules/local-connectivity", () => ({
	startLocalDiscovery: state.start,
	stopLocalDiscovery: state.stop,
	closeLocalProxy: state.close,
	openLocalProxy: state.open,
	onNearbyServicesChanged: (
		listener: (services: readonly NearbyService[]) => void,
	) => {
		state.servicesListener = listener;
		return () => {};
	},
	onLocalPathChanged: (listener: (event: LocalPathEvent) => void) => {
		state.pathListener = listener;
		return () => {};
	},
	onLocalDiscoveryStateChanged: () => () => {},
}));
vi.mock("~/lib/nearby-pairing", () => ({ verifyPinnedLocalServer: vi.fn() }));
vi.mock("~/rpc/connection", () => ({
	applyConnectionOptions: vi.fn(),
	getConnectionSnapshot: () => ({ status: "connected" }),
	retryConnectionNow: vi.fn(),
}));
vi.mock("~/store/connections", () => ({
	connectionsAtom: {},
	connectionsHydratedAtom: {},
	currentConnections: () => state.connections,
	restorePairedConnectionRoutes: vi.fn(async () => []),
	updateDiscoveredConnectionRoute: vi.fn(),
}));
vi.mock("~/store/registry", () => ({
	appAtomRegistry: { subscribe: () => () => {} },
}));
vi.mock("~/store/mobile-client-bus", () => ({
	retryMobileClientBusConnections: vi.fn(),
}));

beforeEach(() => {
	for (const cleanup of state.cleanups.splice(0)) cleanup();
	vi.clearAllMocks();
	state.connections = [];
});

const path = (usesWifi: boolean): LocalPathEvent =>
	({
		status: "satisfied",
		usesWifi,
		usesCellular: !usesWifi,
		generation: 1,
	}) as LocalPathEvent;

test("repeated reports of the same network keep live routes", async () => {
	state.connections = [
		{
			key: "paired:mac",
			source: "paired",
			nearbyServiceName: "mac",
		} as ConnectionRecord,
	];
	useLocalConnectivityRuntime();
	state.servicesListener?.([{ name: "mac", routeId: "mac" } as NearbyService]);
	await vi.waitFor(() => expect(state.open).toHaveBeenCalledTimes(1));
	state.pathListener?.(path(true));
	state.pathListener?.(path(true));
	await Promise.resolve();
	expect(state.close).not.toHaveBeenCalled();
	expect(state.stop).not.toHaveBeenCalled();

	state.pathListener?.(path(false));
	await vi.waitFor(() => expect(state.close).toHaveBeenCalledWith("mac"));
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
});

test("manual route recovery restarts discovery when the service cache is empty", async () => {
	useLocalConnectivityRuntime();
	expect(recoverLocalRoute("paired:mac")).toBe(true);
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
	expect(state.stop).toHaveBeenCalledTimes(1);
});

test("switching Android Wi-Fi networks replaces the old route", async () => {
	state.connections = [
		{
			key: "paired:mac",
			source: "paired",
			nearbyServiceName: "mac",
		} as ConnectionRecord,
	];
	useLocalConnectivityRuntime();
	state.servicesListener?.([{ name: "mac", routeId: "mac" } as NearbyService]);
	await vi.waitFor(() => expect(state.open).toHaveBeenCalledTimes(1));
	state.pathListener?.({ ...path(true), networkId: "100" });
	state.pathListener?.({ ...path(true), networkId: "100", generation: 2 });
	await Promise.resolve();
	expect(state.close).not.toHaveBeenCalled();
	state.pathListener?.({ ...path(true), networkId: "101", generation: 3 });
	await vi.waitFor(() => expect(state.close).toHaveBeenCalledWith("mac"));
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
});

test("manual retry rediscovers the Mac even when stale services remain cached", async () => {
	useLocalConnectivityRuntime();
	state.servicesListener?.([
		{ name: "Old Mac", routeId: "stale-route" } as NearbyService,
	]);
	expect(recoverLocalRoute("paired:mac")).toBe(true);
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
	expect(state.stop).toHaveBeenCalledTimes(1);
});

test("retry closes only the requested computer proxy", async () => {
	state.connections = ["a", "b"].map(
		(id) =>
			({
				key: `paired:${id}`,
				source: "paired",
				nearbyServiceName: id,
			}) as ConnectionRecord,
	);
	useLocalConnectivityRuntime();
	state.servicesListener?.(
		["a", "b"].map((name) => ({ name, routeId: name }) as NearbyService),
	);
	await vi.waitFor(() => expect(state.open).toHaveBeenCalledTimes(2));
	expect(recoverLocalRoute("paired:a")).toBe(true);
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
	expect(state.close).toHaveBeenCalledWith("a");
	expect(state.close).not.toHaveBeenCalledWith("b");
	state.servicesListener?.([{ name: "a", routeId: "a-new" } as NearbyService]);
	await vi.waitFor(() => expect(state.open).toHaveBeenCalledTimes(3));
	expect(state.close).not.toHaveBeenCalledWith("b");
});
