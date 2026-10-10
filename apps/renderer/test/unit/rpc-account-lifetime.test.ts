import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), protocol: vi.fn() }));
vi.mock("@zuse/client-runtime/connection", async (original) => ({
	...(await original<typeof import("@zuse/client-runtime/connection")>()),
	makeRpcClientSession: mocks.create,
}));
vi.mock("../../src/lib/ws-client-protocol.ts", () => ({
	wsClientProtocolLayer: mocks.protocol,
}));

import {
	observeRendererAccount,
	rendererAccountSnapshot,
} from "../../src/lib/renderer-account.ts";
import {
	acquireRendererRpcSession,
	environmentBelongsToWorkspace,
	getCloudWorkspaceScope,
	isCloudWorkspaceEnvironment,
	registerApiEnvironment,
	registerCloudWorkspace,
	registerWebSocketEnvironment,
	removeRendererEnvironment,
} from "../../src/lib/rpc-client.ts";

beforeEach(() => {
	observeRendererAccount(null);
	mocks.create.mockReset();
	mocks.protocol.mockReset();
});

it.each([
	undefined,
	{ kind: "organization" as const, organizationId: "org_a" },
])("preserves the cloud owner after a socket invalidates its ticket: %j", async (workspaceScope) => {
	observeRendererAccount("first");
	const ticket = {
		workspaceId: "recover-owner",
		workspaceScope,
		wsUrl: "wss://example.test/cloud",
		protocol: "zuse-workspace-v1",
		role: "client" as const,
		generation: 1,
		gatewayEpoch: 1,
		credential: "test-ticket",
		expiresAt: Date.now() + 60_000,
	};
	registerCloudWorkspace(
		ticket.workspaceId,
		ticket,
		async () => ticket,
		rendererAccountSnapshot(),
	);
	let close: (event: {
		code: number;
		reason: string;
		wasClean: boolean;
	}) => void = () => undefined;
	mocks.create.mockResolvedValue({
		client: {},
		dispose: async () => undefined,
	});
	mocks.protocol.mockImplementation((_url, options) => {
		close = options.onClose;
		return {};
	});
	const session = await acquireRendererRpcSession(ticket.workspaceId);
	close({ code: 1006, reason: "", wasClean: false });
	await session.dispose();
	expect(getCloudWorkspaceScope(ticket.workspaceId)).toEqual(
		workspaceScope ?? { kind: "personal" },
	);
	expect(
		environmentBelongsToWorkspace(
			ticket.workspaceId,
			workspaceScope ?? { kind: "personal" },
		),
	).toBe(true);
	expect(
		environmentBelongsToWorkspace(ticket.workspaceId, {
			kind: "organization",
			organizationId: "org_b",
		}),
	).toBe(false);
	expect(
		environmentBelongsToWorkspace(ticket.workspaceId, { kind: "personal" }),
	).toBe(workspaceScope === undefined);
	expect(
		environmentBelongsToWorkspace("local-device", {
			kind: "organization",
			organizationId: "org_a",
		}),
	).toBe(false);
	expect(() =>
		registerCloudWorkspace(
			ticket.workspaceId,
			{
				...ticket,
				workspaceScope: { kind: "organization", organizationId: "org_b" },
			},
			async () => ticket,
			rendererAccountSnapshot(),
		),
	).toThrow("ownership changed");
	observeRendererAccount(null);
	expect(getCloudWorkspaceScope(ticket.workspaceId)).toBeUndefined();
});

it("rejects late registrations using the initiating account, including A -> B -> A", async () => {
	observeRendererAccount("first");
	const account = rendererAccountSnapshot();
	observeRendererAccount("second");
	observeRendererAccount("first");
	expect(() =>
		registerApiEnvironment(
			"late-api",
			"wss://example.test/rpc",
			async () => "unused",
			account,
		),
	).toThrow("connection account changed");
	const ticket = {
		workspaceId: "late-cloud",
		wsUrl: "wss://example.test/cloud",
		protocol: "zuse-workspace-v1",
		role: "client" as const,
		generation: 1,
		gatewayEpoch: 1,
		credential: "test-ticket",
		expiresAt: Date.now() + 60_000,
	};
	expect(() =>
		registerCloudWorkspace(
			ticket.workspaceId,
			ticket,
			async () => ticket,
			account,
		),
	).toThrow("connection account changed");
	expect(isCloudWorkspaceEnvironment(ticket.workspaceId)).toBe(false);
	await expect(acquireRendererRpcSession("late-api")).rejects.toThrow(
		"not connected",
	);
});

it("rejects a refreshed ticket that changes an organization's owner", async () => {
	observeRendererAccount("first");
	const ticket = {
		workspaceId: "refresh-owner",
		workspaceScope: { kind: "organization" as const, organizationId: "org_a" },
		wsUrl: "wss://example.test/cloud",
		protocol: "zuse-workspace-v1",
		role: "client" as const,
		generation: 1,
		gatewayEpoch: 1,
		credential: "expired-ticket",
		expiresAt: 0,
	};
	registerCloudWorkspace(
		ticket.workspaceId,
		ticket,
		async () => ({ ...ticket, workspaceScope: undefined }),
		rendererAccountSnapshot(),
	);
	await expect(acquireRendererRpcSession(ticket.workspaceId)).rejects.toThrow(
		"ownership changed",
	);
	expect(getCloudWorkspaceScope(ticket.workspaceId)).toEqual(
		ticket.workspaceScope,
	);
	expect(mocks.create).not.toHaveBeenCalled();
});

it("reports account closure once even when disposing also closes the socket", async () => {
	observeRendererAccount("first");
	let close!: (event: {
		code: number;
		reason: string;
		wasClean: boolean;
	}) => void;
	mocks.protocol.mockImplementation((_url, options) => {
		close = options.onClose;
	});
	const dispose = vi.fn(async () => {
		close({ code: 1000, reason: "disposed", wasClean: true });
	});
	mocks.create.mockResolvedValue({ client: {}, dispose });
	registerApiEnvironment(
		"close-once",
		"wss://example.test/rpc",
		async () => "unused",
		rendererAccountSnapshot(),
	);
	const onClose = vi.fn();
	await acquireRendererRpcSession("close-once", { onClose });
	observeRendererAccount(null);
	close({ code: 1000, reason: "late close", wasClean: true });
	expect(onClose).toHaveBeenCalledOnce();
	expect(dispose).toHaveBeenCalledOnce();
});

it("closes account sessions once while retaining a manually configured SSH session", async () => {
	observeRendererAccount("first");
	const disposeAccount = vi.fn(async () => undefined);
	const disposeSsh = vi.fn(async () => undefined);
	mocks.create
		.mockResolvedValueOnce({ client: {}, dispose: disposeAccount })
		.mockResolvedValueOnce({ client: {}, dispose: disposeSsh });
	registerApiEnvironment(
		"owned",
		"wss://example.test/rpc",
		async () => "unused",
		rendererAccountSnapshot(),
	);
	registerWebSocketEnvironment("manual", "wss://example.test/ssh");
	const onClose = vi.fn();
	const owned = await acquireRendererRpcSession("owned", { onClose });
	const manual = await acquireRendererRpcSession("manual");
	observeRendererAccount("first");
	expect(disposeAccount).not.toHaveBeenCalled();
	observeRendererAccount("second");
	expect(disposeAccount).toHaveBeenCalledOnce();
	expect(onClose).toHaveBeenCalledOnce();
	expect(disposeSsh).not.toHaveBeenCalled();
	await expect(acquireRendererRpcSession("owned")).rejects.toThrow(
		"not connected",
	);
	await owned.dispose();
	expect(disposeAccount).toHaveBeenCalledOnce();
	await manual.dispose();
	await removeRendererEnvironment("manual");
});

it("rejects a grant refresh that finishes after switching away and back", async () => {
	observeRendererAccount("first");
	const dispose = vi.fn(async () => undefined);
	mocks.create.mockResolvedValue({ client: {}, dispose });
	let resolve!: (url: string) => void;
	const refresh = vi.fn(
		() =>
			new Promise<string>((done) => {
				resolve = done;
			}),
	);
	registerApiEnvironment(
		"refreshing",
		"wss://example.test/rpc",
		refresh,
		rendererAccountSnapshot(),
	);
	const initial = await acquireRendererRpcSession("refreshing");
	await initial.dispose();
	const pending = acquireRendererRpcSession("refreshing");
	const rejected = expect(pending).rejects.toThrow(
		"connection account changed",
	);
	await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
	observeRendererAccount("second");
	observeRendererAccount("first");
	resolve("wss://example.test/stale");
	await rejected;
	expect(mocks.create).toHaveBeenCalledOnce();
});

it("disposes a handshake that completes after its account was removed", async () => {
	observeRendererAccount("first");
	const dispose = vi.fn(async () => undefined);
	let resolve!: (session: { client: object; dispose: typeof dispose }) => void;
	mocks.create.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	registerApiEnvironment(
		"opening",
		"wss://example.test/rpc",
		async () => "unused",
		rendererAccountSnapshot(),
	);
	const pending = acquireRendererRpcSession("opening");
	const rejected = expect(pending).rejects.toThrow(
		"connection account changed",
	);
	await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
	observeRendererAccount(null);
	resolve({ client: {}, dispose });
	await rejected;
	expect(dispose).toHaveBeenCalledOnce();
});

it("removes cloud tickets without letting a delayed old refresh replace a new registration", async () => {
	observeRendererAccount("first");
	const ticket = {
		workspaceId: "cloud-owned",
		wsUrl: "wss://example.test/cloud",
		protocol: "zuse-workspace-v1",
		role: "client" as const,
		generation: 1,
		gatewayEpoch: 1,
		credential: "expired-test-ticket",
		expiresAt: 0,
	};
	let resolve!: (value: typeof ticket) => void;
	const refresh = vi.fn(
		() =>
			new Promise<typeof ticket>((done) => {
				resolve = done;
			}),
	);
	registerCloudWorkspace(
		ticket.workspaceId,
		ticket,
		refresh,
		rendererAccountSnapshot(),
	);
	const pending = acquireRendererRpcSession(ticket.workspaceId);
	const rejected = expect(pending).rejects.toThrow(
		"connection account changed",
	);
	await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
	observeRendererAccount("second");
	expect(isCloudWorkspaceEnvironment(ticket.workspaceId)).toBe(false);
	const currentRefresh = vi.fn(async () => ({
		...ticket,
		credential: "current-test-ticket",
	}));
	registerCloudWorkspace(
		ticket.workspaceId,
		ticket,
		currentRefresh,
		rendererAccountSnapshot(),
	);
	resolve({ ...ticket, expiresAt: Date.now() + 60_000 });
	await rejected;
	const dispose = vi.fn(async () => undefined);
	mocks.create.mockResolvedValue({ client: {}, dispose });
	const current = await acquireRendererRpcSession(ticket.workspaceId);
	expect(currentRefresh).toHaveBeenCalledOnce();
	expect(mocks.create).toHaveBeenCalledOnce();
	observeRendererAccount(null);
	expect(dispose).toHaveBeenCalledOnce();
	await current.dispose();
});
