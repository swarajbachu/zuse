import { beforeEach, expect, test, vi } from "vitest";
import {
	retryConnection,
	watchConnection,
} from "../../../src/store/connection-runtime";
import { registerLocalRouteRecovery } from "../../../src/store/local-route-recovery";

const runtime = vi.hoisted(() => ({
	listener: null as ((state: string) => void) | null,
	setOnline: vi.fn(),
	retryTransport: vi.fn(),
	retryResources: vi.fn(),
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
	getConnectionSnapshot: () => ({ status: "connected" }),
	subscribeConnection: () => () => undefined,
	setConnectionOnline: runtime.setOnline,
	retryConnectionNow: runtime.retryTransport,
}));
vi.mock("~/store/mobile-client-bus", () => ({
	retryMobileClientBusConnections: runtime.retryResources,
}));

const options = { host: "localhost", port: 4000, token: null };

beforeEach(() => {
	vi.clearAllMocks();
	watchConnection("desktop", options);
});

test("background resume reconnects resources once and only after active", () => {
	runtime.listener?.("background");
	expect(runtime.setOnline).toHaveBeenLastCalledWith(false);
	runtime.listener?.("inactive");
	expect(runtime.setOnline).toHaveBeenCalledTimes(1);
	expect(runtime.retryResources).not.toHaveBeenCalled();
	runtime.listener?.("active");
	expect(runtime.setOnline).toHaveBeenLastCalledWith(true);
	expect(runtime.retryResources).toHaveBeenCalledTimes(1);
	runtime.listener?.("active");
	expect(runtime.retryResources).toHaveBeenCalledTimes(1);
});

test("temporary inactive state does not replace a healthy connection", () => {
	runtime.listener?.("inactive");
	runtime.listener?.("active");
	expect(runtime.setOnline).not.toHaveBeenCalled();
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
