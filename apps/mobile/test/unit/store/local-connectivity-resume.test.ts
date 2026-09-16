import { beforeEach, expect, test, vi } from "vitest";
import { useLocalConnectivityRuntime } from "../../../src/store/local-connectivity-runtime";
import { recoverLocalRoute } from "../../../src/store/local-route-recovery";

const state = vi.hoisted(() => ({
	listener: null as ((state: string) => void) | null,
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
vi.mock("react-native", () => ({
	AppState: {
		addEventListener: (_: string, listener: (state: string) => void) => {
			state.listener = listener;
			return { remove: () => {} };
		},
	},
}));
vi.mock("../../../modules/local-connectivity", () => ({
	startLocalDiscovery: state.start,
	stopLocalDiscovery: state.stop,
	closeLocalProxy: vi.fn(async () => {}),
	openLocalProxy: vi.fn(),
	onNearbyServicesChanged: () => () => {},
	onLocalPathChanged: () => () => {},
	onLocalDiscoveryStateChanged: () => () => {},
}));
vi.mock("~/lib/nearby-pairing", () => ({ verifyPinnedLocalServer: vi.fn() }));
vi.mock("~/rpc/connection", () => ({
	applyConnectionOptions: vi.fn(),
	getConnectionSnapshot: () => ({ status: "error" }),
	retryConnectionNow: vi.fn(),
}));
vi.mock("~/store/connections", () => ({
	connectionsAtom: {},
	connectionsHydratedAtom: {},
	currentConnections: () => [],
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
});

test("resume actively rediscovers routes after native proxies were cancelled", async () => {
	useLocalConnectivityRuntime();
	expect(state.start).toHaveBeenCalledTimes(1);
	state.listener?.("background");
	state.listener?.("active");
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
	expect(state.stop).toHaveBeenCalledTimes(1);
});

test("manual route recovery restarts discovery when the service cache is empty", async () => {
	useLocalConnectivityRuntime();
	expect(recoverLocalRoute("paired:mac")).toBe(true);
	await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
	expect(state.stop).toHaveBeenCalledTimes(1);
});
