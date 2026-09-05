import { describe, expect, it } from "vitest";

const locationValue = {
	host: "localhost:8787",
	pathname: "/",
	protocol: "http:",
};

Object.defineProperty(globalThis, "location", {
	value: locationValue,
	configurable: true,
});

const {
	acquireRendererRpcSession,
	canReuseCloudWorkspaceTicket,
	clearCloudWorkspaceRuntimeRecovery,
	connectionRequiresNetwork,
	environmentRequiresNetwork,
	cloudWorkspaceRequiresRuntimeRecovery,
	cloudWorkspaceRuntimeRecoveryCommandId,
	requestCloudWorkspaceRuntimeRecovery,
	isAuthCodedConnectionError,
	isIgnorableRendererFailure,
	isRpcClientTransportError,
	markCloudWorkspaceConnectionHealthy,
	refreshCloudWorkspaceConnectionWithRecovery,
	RENDERER_WEBSOCKET_OPEN_TIMEOUT,
	registerLocalEnvironment,
	registerWebSocketEnvironment,
	resolveRendererRpcTransportForTest,
	setActiveEnvironment,
	shouldReconnectRendererConnection,
	shouldRestartCloudWorkspaceConnection,
} = await import("../../src/lib/rpc-client.ts");

describe("renderer RPC transport selection", () => {
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

	it("queues one recovery command for an explicit missing provider runtime", () => {
		const workspaceId = "workspace-provider-missing";
		requestCloudWorkspaceRuntimeRecovery(workspaceId);
		const commandId = cloudWorkspaceRuntimeRecoveryCommandId(workspaceId);
		expect(commandId).toBeTypeOf("string");
		requestCloudWorkspaceRuntimeRecovery(workspaceId);
		expect(cloudWorkspaceRuntimeRecoveryCommandId(workspaceId)).toBe(commandId);
		clearCloudWorkspaceRuntimeRecovery(workspaceId);
	});

	it("marks a cloud runtime for recovery after the gateway proves it is absent", async () => {
		let close: (event: {
			code: number;
			reason: string;
			wasClean: boolean;
		}) => void = () => undefined;
		const hooks = {
			prepare: async (environmentId: string) => ({
				key: `workspace:${environmentId}`,
				create: async (onClose: typeof close) => {
					close = onClose;
					return { client: {} as never, dispose: async () => undefined };
				},
			}),
			invalidateCloudTicket: () => undefined,
		};
		const failures: string[] = [];
		const session = await acquireRendererRpcSession("workspace-recover", {
			hooks,
			onClose: (cause) => failures.push(cause.message),
		});

		close({
			code: 4100,
			reason: "workspace runtime unavailable",
			wasClean: true,
		});

		expect(cloudWorkspaceRequiresRuntimeRecovery("workspace-recover")).toBe(
			true,
		);
		const commandId =
			cloudWorkspaceRuntimeRecoveryCommandId("workspace-recover");
		expect(commandId).toBeTypeOf("string");
		close({
			code: 4100,
			reason: "workspace runtime unavailable",
			wasClean: true,
		});
		expect(cloudWorkspaceRuntimeRecoveryCommandId("workspace-recover")).toBe(
			commandId,
		);
		expect(failures).toEqual([
			"WebSocket closed (4100: workspace runtime unavailable).",
			"WebSocket closed (4100: workspace runtime unavailable).",
		]);
		const events: string[] = [];
		const ticket = await refreshCloudWorkspaceConnectionWithRecovery(
			"workspace-recover",
			async (recoveryId) => {
				events.push(`recover:${recoveryId}`);
			},
			async () => {
				events.push("connect");
				return {
					workspaceId: "workspace-recover",
					wsUrl: "wss://cloud.example/workspaces/workspace-recover",
					protocol: "zuse-workspace-v2",
					role: "client" as const,
					generation: 2,
					gatewayEpoch: 2,
					credential: "new-ticket",
					expiresAt: Date.now() + 60_000,
				};
			},
		);
		expect(events).toEqual([`recover:${commandId}`, "connect"]);
		expect(ticket.generation).toBe(2);
		expect(cloudWorkspaceRuntimeRecoveryCommandId("workspace-recover")).toBe(
			undefined,
		);
		await session.dispose();
	});

	it("allows a fresh command after a terminal runtime recovery failure", async () => {
		let close: (event: {
			code: number;
			reason: string;
			wasClean: boolean;
		}) => void = () => undefined;
		const workspaceId = "workspace-recovery-retry";
		const session = await acquireRendererRpcSession(workspaceId, {
			hooks: {
				prepare: async () => ({
					key: `workspace:${workspaceId}`,
					create: async (onClose: typeof close) => {
						close = onClose;
						return { client: {} as never, dispose: async () => undefined };
					},
				}),
				invalidateCloudTicket: () => undefined,
			},
			onClose: () => undefined,
		});
		close({
			code: 4100,
			reason: "workspace runtime unavailable",
			wasClean: true,
		});
		const failedCommand = cloudWorkspaceRuntimeRecoveryCommandId(workspaceId);
		expect(failedCommand).toBeTypeOf("string");
		await expect(
			refreshCloudWorkspaceConnectionWithRecovery(
				workspaceId,
				async () => {
					throw new Error("runtime-connection-timeout");
				},
				async () => {
					throw new Error("connect should not run");
				},
			),
		).rejects.toThrow("runtime-connection-timeout");
		expect(cloudWorkspaceRuntimeRecoveryCommandId(workspaceId)).toBeUndefined();

		close({
			code: 4100,
			reason: "workspace runtime unavailable",
			wasClean: true,
		});
		expect(cloudWorkspaceRuntimeRecoveryCommandId(workspaceId)).not.toBe(
			failedCommand,
		);
		await session.dispose();
	});

	it("recovers the first pre-handshake browser-abnormal gateway close", async () => {
		let close: (event: {
			code: number;
			reason: string;
			wasClean: boolean;
		}) => void = () => undefined;
		const workspaceId = "workspace-abnormal-close";
		const hooks = {
			prepare: async () => ({
				key: `workspace:${workspaceId}`,
				create: async (onClose: typeof close) => {
					close = onClose;
					return { client: {} as never, dispose: async () => undefined };
				},
			}),
			invalidateCloudTicket: () => undefined,
		};
		const first = await acquireRendererRpcSession(workspaceId, { hooks });
		close({ code: 1006, reason: "", wasClean: false });
		expect(cloudWorkspaceRequiresRuntimeRecovery(workspaceId)).toBe(true);
		clearCloudWorkspaceRuntimeRecovery(workspaceId);
		markCloudWorkspaceConnectionHealthy(workspaceId);
		close({ code: 1006, reason: "", wasClean: false });
		expect(cloudWorkspaceRequiresRuntimeRecovery(workspaceId)).toBe(false);
		close({ code: 1006, reason: "", wasClean: false });
		expect(cloudWorkspaceRequiresRuntimeRecovery(workspaceId)).toBe(true);
		await first.dispose();
	});
});
