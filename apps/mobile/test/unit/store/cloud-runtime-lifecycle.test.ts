import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCloudRuntimeLifecycle } from "../../../src/store/cloud-runtime-lifecycle";

const runtime = vi.hoisted(() => ({
	effects: [] as Array<() => undefined | (() => void)>,
	values: new Map<string, unknown>(),
	features: { organizationWorkspaces: true },
	state: "active",
	listener: undefined as ((state: string) => void) | undefined,
	remove: vi.fn(),
	catalog: vi.fn(),
	memberships: vi.fn(),
	setAccount: vi.fn(),
	ref: undefined as { current: unknown } | undefined,
	disposeConnection: vi.fn(),
}));
vi.mock("react", () => ({
	useRef: (current: unknown) => {
		runtime.ref ??= { current };
		return runtime.ref;
	},
	useEffect: (effect: () => undefined | (() => void)) => {
		runtime.effects.push(effect);
	},
}));
vi.mock("@effect/atom-react", () => ({
	useAtomValue: (key: string) => runtime.values.get(key),
}));
vi.mock("react-native", () => ({
	AppState: {
		get currentState() {
			return runtime.state;
		},
		addEventListener: (_event: string, listener: (state: string) => void) => {
			runtime.listener = listener;
			return { remove: runtime.remove };
		},
	},
}));
vi.mock("~/lib/release-features", () => ({
	mobileReleaseFeatures: runtime.features,
}));
vi.mock("~/rpc/cloud-runtime", () => ({ resetCloudRuntime: vi.fn() }));
vi.mock("~/rpc/connection", () => ({
	disposeConnection: runtime.disposeConnection,
}));
vi.mock("~/store/auth", () => ({ authAccountAtom: "account" }));
vi.mock("~/store/cloud-catalog", () => ({
	cloudCatalogAtom: "catalog",
	cloudConnectionsAtom: "connections",
	refreshCloudCatalog: runtime.catalog,
	refreshCloudOrganizations: runtime.memberships,
	setCloudCatalogAccount: runtime.setAccount,
}));
vi.mock("~/store/messages", () => ({ resetMessagesRuntime: vi.fn() }));
vi.mock("~/store/sessions", () => ({ resetSessionsRuntime: vi.fn() }));
vi.mock("~/store/mobile-client-bus", () => ({
	mobileClientBus: vi.fn(),
	registerMobileEnvironment: vi.fn(),
}));
vi.mock("~/store/registry", () => ({
	appAtomRegistry: { get: (key: string) => runtime.values.get(key) },
}));

let cleanup: undefined | (() => void);
const start = () => {
	useCloudRuntimeLifecycle();
	cleanup = runtime.effects[0]?.();
};

describe("account-wide mobile membership refresh", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.clearAllMocks();
		cleanup = undefined;
		runtime.effects = [];
		runtime.ref = undefined;
		runtime.disposeConnection.mockResolvedValue(undefined);
		runtime.state = "active";
		runtime.listener = undefined;
		runtime.features.organizationWorkspaces = true;
		runtime.catalog.mockResolvedValue(undefined);
		runtime.memberships.mockReset().mockResolvedValue([]);
		runtime.values.set("account", { id: "account-a" });
		runtime.values.set("catalog", {
			accountId: "account-a",
			chats: [],
			scope: { kind: "personal" },
		});
		runtime.values.set("connections", []);
	});
	afterEach(() => {
		cleanup?.();
		vi.useRealTimers();
	});
	test("refreshes memberships without mounting a workspace switcher", async () => {
		start();
		expect(runtime.memberships).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(runtime.memberships).toHaveBeenCalledOnce();
		expect(runtime.catalog).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(runtime.memberships).toHaveBeenCalledTimes(2);
	});
	test("pauses background polling and refreshes immediately on foreground", async () => {
		start();
		runtime.listener?.("background");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runtime.memberships).toHaveBeenCalledOnce();
		expect(runtime.catalog).toHaveBeenCalledOnce();
		runtime.listener?.("active");
		expect(runtime.memberships).toHaveBeenCalledTimes(2);
		expect(runtime.catalog).toHaveBeenCalledTimes(2);
	});
	test("keeps polling through a temporary membership outage", async () => {
		runtime.memberships.mockRejectedValueOnce(new Error("offline"));
		start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(runtime.memberships).toHaveBeenCalledTimes(2);
		expect(runtime.catalog).toHaveBeenCalledTimes(4);
	});
	test("does not query organizations before rollout", async () => {
		runtime.features.organizationWorkspaces = false;
		start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runtime.memberships).not.toHaveBeenCalled();
		expect(runtime.catalog).toHaveBeenCalledTimes(7);
	});
	test("cleans up the timer and foreground subscription", async () => {
		start();
		cleanup?.();
		cleanup = undefined;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runtime.memberships).toHaveBeenCalledOnce();
		expect(runtime.remove).toHaveBeenCalledOnce();
		expect(runtime.setAccount).toHaveBeenLastCalledWith(null);
	});
	test("does not schedule signed-out account polling", async () => {
		runtime.values.set("account", null);
		start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runtime.memberships).not.toHaveBeenCalled();
		expect(runtime.catalog).not.toHaveBeenCalled();
	});
	test("releases only cloud connections removed from the visible catalog", () => {
		const first = { key: "cloud:first", cloudWorkspaceId: "first" };
		const retained = { key: "cloud:retained", cloudWorkspaceId: "retained" };
		runtime.values.set("connections", [first, retained]);
		useCloudRuntimeLifecycle();
		runtime.effects.at(-1)?.();
		expect(runtime.disposeConnection).not.toHaveBeenCalled();
		runtime.effects = [];
		runtime.values.set("connections", [retained]);
		useCloudRuntimeLifecycle();
		runtime.effects.at(-1)?.();
		expect(runtime.disposeConnection).toHaveBeenCalledExactlyOnceWith(first);
		runtime.effects = [];
		useCloudRuntimeLifecycle();
		runtime.effects.at(-1)?.();
		expect(runtime.disposeConnection).toHaveBeenCalledTimes(1);
	});
});
