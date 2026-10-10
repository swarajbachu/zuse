import { RpcAccessDeniedError } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

const locationValue = {
	host: "localhost:8787",
	pathname: "/",
	protocol: "http:",
};

it("renews expired grants without reconnecting on workspace permission denial", () => {
	const expired = new RpcAccessDeniedError({ code: "credential-expired" });
	expect(isRpcClientTransportError(expired)).toBe(true);
	expect(isAuthCodedConnectionError(expired)).toBe(false);
	expect(
		isRpcClientTransportError(
			new RpcAccessDeniedError({ code: "access-denied" }),
		),
	).toBe(false);
});

Object.defineProperty(globalThis, "location", {
	value: locationValue,
	configurable: true,
});

const {
	acquireRendererRpcSession,
	canReuseCloudWorkspaceTicket,
	connectionRequiresNetwork,
	environmentRequiresNetwork,
	isAuthCodedConnectionError,
	isIgnorableRendererFailure,
	isRpcClientTransportError,
	RENDERER_WEBSOCKET_OPEN_TIMEOUT,
	rendererWebSocketOpenTimeout,
	registerLocalEnvironment,
	registerWebSocketEnvironment,
	resolveRendererRpcTransportForTest,
	setActiveEnvironment,
	shouldReconnectRendererConnection,
	shouldRestartCloudWorkspaceConnection,
} = await import("../../src/lib/rpc-client.ts");

describe("renderer RPC transport selection", () => {
	it("replaces a hosted connection when its account changes even at the same URL", () => {
		const options = {
			key: "environment:local",
			kind: "websocket" as const,
			wsUrl: "wss://host.example/rpc",
			account: { subject: "alice", epoch: 1 },
		};
		expect(shouldReconnectRendererConnection(options, { ...options })).toBe(
			false,
		);
		expect(
			shouldReconnectRendererConnection(options, {
				...options,
				account: { subject: "bob", epoch: 2 },
			}),
		).toBe(true);
	});
	it("does not poison a healthy connection when a suspended stream is interrupted", () => {
		const interruption = new Error("All fibers interrupted without error");
		expect(isIgnorableRendererFailure(interruption)).toBe(true);
		// A command interrupted with the transport scope has an ambiguous outcome.
		// Keep retry-safe commands in the outbox instead of presenting a final
		// provider rejection to the user.
		expect(isRpcClientTransportError(interruption)).toBe(true);
		expect(
			isRpcClientTransportError({
				_tag: "RpcClientError",
				reason: { _tag: "SocketError", message: "closed" },
			}),
		).toBe(true);
		expect(
			isRpcClientTransportError({
				_tag: "RpcClientError",
				reason: {
					_tag: "RpcClientDefect",
					message: "response schema mismatch",
				},
			}),
		).toBe(false);
		expect(
			isIgnorableRendererFailure(new Error("WebSocket closed (1006).")),
		).toBe(false);
	});

	it("bounds the WebSocket opening phase", () => {
		expect(RENDERER_WEBSOCKET_OPEN_TIMEOUT).toBe("3 seconds");
		expect(rendererWebSocketOpenTimeout("workspace:cloud-1")).toBe(
			"15 seconds",
		);
		expect(rendererWebSocketOpenTimeout("local")).toBe("3 seconds");
		expect(rendererWebSocketOpenTimeout("ws:remote-1")).toBe("3 seconds");
	});
	it("uses WebSocket mode when no Electron bridge is present", () => {
		Object.defineProperty(globalThis, "window", {
			value: {},
			configurable: true,
		});

		expect(resolveRendererRpcTransportForTest()).toEqual({
			kind: "websocket",
			wsUrl: "ws://localhost:8787/rpc",
			refreshesWsUrl: true,
		});
	});

	it("registers the served environment id for browser RPC calls", () => {
		Object.defineProperty(globalThis, "window", {
			value: {},
			configurable: true,
		});

		registerLocalEnvironment("env_browser");

		expect(() => setActiveEnvironment("env_browser")).not.toThrow();
	});

	it("keeps Electron IPC mode when the preload bridge is present", () => {
		Object.defineProperty(globalThis, "window", {
			value: { zuse: { rpc: {} } },
			configurable: true,
		});

		expect(resolveRendererRpcTransportForTest()).toEqual({ kind: "electron" });
	});

	it("treats only WebSocket transports as network-backed", () => {
		Object.defineProperty(globalThis, "window", {
			value: { zuse: { rpc: {} } },
			configurable: true,
		});

		expect(connectionRequiresNetwork({ kind: "electron" })).toBe(false);
		expect(connectionRequiresNetwork({ kind: "websocket" })).toBe(true);

		registerLocalEnvironment("env_local");
		registerWebSocketEnvironment("env_ssh", "ws://example.test/rpc");

		expect(environmentRequiresNetwork("local")).toBe(false);
		expect(environmentRequiresNetwork("env_local")).toBe(false);
		expect(environmentRequiresNetwork("env_ssh")).toBe(true);
		expect(environmentRequiresNetwork("env_unknown")).toBe(true);
	});

	it("classifies coded auth rejections that carry no message text", async () => {
		const { CloudWorkspaceOpError, ConnectAuthError } = await import(
			"@zuse/contracts"
		);
		expect(
			isAuthCodedConnectionError(
				new CloudWorkspaceOpError({ code: "not-allowed" }),
			),
		).toBe(true);
		expect(
			isAuthCodedConnectionError(
				new ConnectAuthError({ reason: "not-allowed" }),
			),
		).toBe(true);
		expect(
			isAuthCodedConnectionError(
				new CloudWorkspaceOpError({ code: "conflict" }),
			),
		).toBe(false);
		expect(isAuthCodedConnectionError(new Error("boom"))).toBe(false);
		expect(isAuthCodedConnectionError(null)).toBe(false);
	});

	it("restarts only terminal cloud connection failures", () => {
		expect(shouldRestartCloudWorkspaceConnection("connecting")).toBe(false);
		expect(shouldRestartCloudWorkspaceConnection("reconnecting")).toBe(false);
		expect(shouldRestartCloudWorkspaceConnection("error")).toBe(true);
		expect(shouldRestartCloudWorkspaceConnection("blockedAuth")).toBe(true);
		expect(shouldRestartCloudWorkspaceConnection("connected")).toBe(false);
	});

	it("reuses a short-lived gateway ticket only outside its safety margin", () => {
		const now = 1_000;
		const ticket = {
			workspaceId: "workspace-1",
			wsUrl: "wss://cloud.example/workspaces/workspace-1",
			protocol: "zuse-workspace-v1",
			role: "client" as const,
			generation: 1,
			gatewayEpoch: 1,
			credential: "ticket",
			expiresAt: now + 60_000,
		};
		expect(canReuseCloudWorkspaceTicket(ticket, now)).toBe(true);
		expect(
			canReuseCloudWorkspaceTicket({ ...ticket, expiresAt: now + 10_000 }, now),
		).toBe(false);
	});

	it("reconnects when a stable cloud gateway explicitly receives a new ticket", () => {
		const refresh = async () => ({
			workspaceId: "workspace-1",
			wsUrl: "wss://cloud.example/workspaces/workspace-1",
			protocol: "zuse-workspace-v1",
			role: "client" as const,
			generation: 1,
			gatewayEpoch: 1,
			credential: "new-ticket",
			expiresAt: Date.now() + 60_000,
		});
		expect(
			shouldReconnectRendererConnection(
				{
					key: "workspace:workspace-1",
					kind: "websocket",
					wsUrl: "wss://cloud.example/workspaces/workspace-1",
					protocols: ["zuse-workspace-v1", "expired-ticket"],
					refreshConnection: refresh,
				},
				{
					key: "workspace:workspace-1",
					kind: "websocket",
					wsUrl: "wss://cloud.example/workspaces/workspace-1",
					protocols: ["zuse-workspace-v1", "new-ticket"],
					refreshConnection: refresh,
				},
			),
		).toBe(true);
	});

	it("acquires a passive Bus session with refreshed credentials and no retry owner", async () => {
		const events: string[] = [];
		let close: (event: {
			code: number;
			reason: string;
			wasClean: boolean;
		}) => void = () => undefined;
		const hooks = {
			prepare: async (environmentId: string) => {
				events.push(`refresh:${environmentId}`);
				return {
					key: `workspace:${environmentId}`,
					create: async (onClose: typeof close) => {
						events.push("create");
						close = onClose;
						return {
							client: { id: "passive" } as never,
							dispose: async () => {
								events.push("dispose");
							},
						};
					},
				};
			},
			invalidateCloudTicket: (workspaceId: string) =>
				events.push(`invalidate:${workspaceId}`),
		};
		const session = await acquireRendererRpcSession("workspace-1", {
			onClose: (cause) => events.push(cause.message),
			hooks,
		});

		expect(session.client).toEqual({ id: "passive" });
		expect(events).toEqual(["refresh:workspace-1", "create"]);
		close({ code: 1006, reason: "", wasClean: false });
		expect(events).toEqual([
			"refresh:workspace-1",
			"create",
			"invalidate:workspace-1",
			"WebSocket closed (1006).",
		]);
		await session.dispose();
		await session.dispose();
		close({ code: 1006, reason: "", wasClean: false });
		expect(events).toEqual([
			"refresh:workspace-1",
			"create",
			"invalidate:workspace-1",
			"WebSocket closed (1006).",
			"dispose",
		]);

		const next = await acquireRendererRpcSession("workspace-1", { hooks });
		expect(events.slice(-2)).toEqual(["refresh:workspace-1", "create"]);
		await next.dispose();
	});

	it("discards a cloud ticket when the WebSocket upgrade is rejected", async () => {
		const events: string[] = [];
		const hooks = {
			prepare: async (environmentId: string) => ({
				key: `workspace:${environmentId}`,
				create: async () => {
					events.push("create-rejected");
					throw new Error("WebSocket rejected with HTTP 401");
				},
			}),
			invalidateCloudTicket: (workspaceId: string) =>
				events.push(`invalidate:${workspaceId}`),
		};

		await expect(
			acquireRendererRpcSession("workspace-expired", { hooks }),
		).rejects.toThrow("HTTP 401");
		expect(events).toEqual(["create-rejected", "invalidate:workspace-expired"]);
	});

	it.each([
		1006, 4100, 4001, 4009,
	])("invalidates disposable tickets and surfaces gateway close %s", async (code) => {
		let close: (event: {
			code: number;
			reason: string;
			wasClean: boolean;
		}) => void = () => undefined;
		const invalidations: string[] = [];
		const failures: string[] = [];
		const session = await acquireRendererRpcSession("workspace-detached", {
			hooks: {
				prepare: async () => ({
					key: "workspace:workspace-detached",
					create: async (onClose) => {
						close = onClose;
						return { client: {} as never, dispose: async () => undefined };
					},
				}),
				invalidateCloudTicket: (workspaceId) => invalidations.push(workspaceId),
			},
			onClose: (cause) => failures.push(cause.message),
		});
		close({ code, reason: "gateway unavailable", wasClean: false });
		expect(invalidations).toEqual(["workspace-detached"]);
		expect(failures).toEqual([
			`WebSocket closed (${code}: gateway unavailable).`,
		]);
		await session.dispose();
		close({ code, reason: "late close", wasClean: false });
		expect(invalidations).toHaveLength(1);
	});
});
