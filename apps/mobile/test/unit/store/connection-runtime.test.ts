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
	health: [] as { options: Record<string, unknown>; health: string }[],
	checkHealth: vi.fn(),
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
	checkConnectionsHealth: async (timeoutMs: number) => {
		runtime.checkHealth(timeoutMs);
		return runtime.health;
	},
	retryConnectionNow: runtime.retryTransport,
}));
vi.mock("~/store/mobile-client-bus", () => ({
	retryMobileClientBusConnections: runtime.retryResources,
}));

const options = { host: "localhost", port: 4000, token: null };

beforeEach(() => {
	vi.clearAllMocks();
	runtime.health = [];
	watchConnection("desktop", options);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("background keeps sockets open and resume probes them once", async () => {
	runtime.listener?.("background");
	runtime.listener?.("inactive");
	expect(runtime.checkHealth).not.toHaveBeenCalled();
	runtime.listener?.("active");
	expect(runtime.checkHealth).toHaveBeenCalledTimes(1);
	runtime.listener?.("active");
	expect(runtime.checkHealth).toHaveBeenCalledTimes(1);
	await flush();
	expect(runtime.retryTransport).not.toHaveBeenCalled();
	expect(runtime.retryResources).not.toHaveBeenCalled();
});

test("temporary inactive state does not probe a healthy connection", () => {
	runtime.listener?.("inactive");
	runtime.listener?.("active");
	expect(runtime.checkHealth).not.toHaveBeenCalled();
});

test("resume rebinds resources only for replaced sockets", async () => {
	runtime.health = [
		{ options: { ...options, key: "kept" }, health: "healthy" },
		{ options: { ...options, key: "dead" }, health: "replaced" },
	];
	runtime.listener?.("background");
	runtime.listener?.("active");
	await flush();
	expect(runtime.retryResources).toHaveBeenCalledTimes(1);
	expect(runtime.retryResources).toHaveBeenCalledWith("dead");
});

test("resume reopens a local proxy route that stopped answering", async () => {
	const recover = vi.fn();
	const remove = registerLocalRouteRecovery(recover);
	try {
		runtime.health = [
			{
				options: {
					...options,
					key: "paired:mac",
					host: "127.0.0.1",
					serverKeyPin: "pin",
				},
				health: "replaced",
			},
		];
		runtime.listener?.("background");
		runtime.listener?.("active");
		await flush();
		expect(recover).toHaveBeenCalledWith("paired:mac");
	} finally {
		remove();
	}
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
