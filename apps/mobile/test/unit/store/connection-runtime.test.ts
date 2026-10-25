import { beforeEach, expect, test, vi } from "vitest";
import type { ConnectionSnapshot } from "../../../src/rpc/connection";
import {
	retryConnection,
	watchConnection,
} from "../../../src/store/connection-runtime";
import { refreshConnectionLabel } from "../../../src/store/connections";
import { registerLocalRouteRecovery } from "../../../src/store/local-route-recovery";

const runtime = vi.hoisted(() => ({
	listener: null as ((state: string) => void) | null,
	snapshotListener: undefined as
		| ((snapshot: ConnectionSnapshot) => void)
		| undefined,
	setOnline: vi.fn(),
	setResourcesOnline: vi.fn(),
	retryTransport: vi.fn(),
	retryResources: vi.fn(),
}));

vi.mock("~/store/connections", () => ({
	refreshConnectionLabel: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
	AppState: {
		currentState: "active",
		addEventListener: (_event: string, listener: (state: string) => void) => {
			runtime.listener = listener;
		},
	},
}));
vi.mock("~/rpc/cloud-runtime", () => ({ cloudRuntimeReady: () => true }));
vi.mock("~/rpc/connection", () => ({
	getConnectionSnapshot: () => ({
		key: "desktop",
		status: "connected",
		generation: 1,
		attempt: 0,
		error: null,
	}),
	subscribeConnection: (
		_options: unknown,
		listener: (snapshot: ConnectionSnapshot) => void,
	) => {
		runtime.snapshotListener = listener;
		listener({
			key: "desktop",
			status: "connected",
			generation: 1,
			attempt: 0,
			error: null,
		});
		return () => {
			runtime.snapshotListener = undefined;
		};
	},
	setConnectionOnline: runtime.setOnline,
	retryConnectionNow: runtime.retryTransport,
}));
vi.mock("~/store/mobile-client-bus", () => ({
	retryMobileClientBusConnections: runtime.retryResources,
	setMobileClientBusOnline: runtime.setResourcesOnline,
}));

const options = { host: "localhost", port: 4000, token: null };

beforeEach(() => {
	vi.clearAllMocks();
	watchConnection("desktop", options);
});

test("background resume reconnects resources once and only after active", () => {
	runtime.listener?.("background");
	expect(runtime.setOnline).toHaveBeenLastCalledWith(false);
	expect(runtime.setResourcesOnline).toHaveBeenLastCalledWith(false);
	runtime.listener?.("inactive");
	expect(runtime.setOnline).toHaveBeenCalledTimes(1);
	expect(runtime.setResourcesOnline).toHaveBeenCalledTimes(1);
	expect(runtime.retryResources).not.toHaveBeenCalled();
	runtime.listener?.("active");
	expect(runtime.setOnline).toHaveBeenLastCalledWith(true);
	expect(runtime.setResourcesOnline).toHaveBeenLastCalledWith(true);
	expect(runtime.retryResources).toHaveBeenCalledTimes(1);
	runtime.listener?.("active");
	expect(runtime.retryResources).toHaveBeenCalledTimes(1);
});

test("temporary inactive state does not replace a healthy connection", () => {
	runtime.listener?.("inactive");
	runtime.listener?.("active");
	expect(runtime.setOnline).not.toHaveBeenCalled();
	expect(runtime.setResourcesOnline).not.toHaveBeenCalled();
	expect(runtime.retryResources).not.toHaveBeenCalled();
});

test("manual retry refreshes both the socket and retained resources", () => {
	retryConnection("desktop", options);
	expect(runtime.retryTransport).toHaveBeenCalledWith(options);
	expect(runtime.retryResources).toHaveBeenCalledWith("desktop");
});

test("manual retry rebuilds a pinned native proxy instead of dialing its stale port", () => {
	const recover = vi.fn();
	const remove = registerLocalRouteRecovery(recover);
	try {
		retryConnection("paired:mac", {
			...options,
			host: "127.0.0.1",
			serverKeyPin: "pin",
		});
		expect(recover).toHaveBeenCalledWith("paired:mac");
		expect(runtime.retryTransport).not.toHaveBeenCalled();
	} finally {
		remove();
	}
});

test("refreshes saved metadata once per connected generation including an already-connected mount", () => {
	expect(refreshConnectionLabel).toHaveBeenCalledExactlyOnceWith(
		"desktop",
		options,
		1,
	);
	const snapshot = { key: "desktop", generation: 1, attempt: 0, error: null };
	runtime.snapshotListener?.({ ...snapshot, status: "connected" });
	runtime.snapshotListener?.({ ...snapshot, status: "reconnecting" });
	expect(refreshConnectionLabel).toHaveBeenCalledTimes(1);
	runtime.snapshotListener?.({
		...snapshot,
		status: "connected",
		generation: 2,
	});
	expect(refreshConnectionLabel).toHaveBeenCalledTimes(2);
});
