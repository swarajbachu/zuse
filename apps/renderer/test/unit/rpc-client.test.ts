import { describe, expect, it } from "vitest";

const locationValue = { host: "localhost:8787" };

Object.defineProperty(globalThis, "location", {
	value: locationValue,
	configurable: true,
});

const {
	acquireRendererRpcSession,
	canReuseCloudWorkspaceTicket,
	clearCloudWorkspaceRuntimeRecovery,
	cloudWorkspaceRequiresRuntimeRecovery,
	isIgnorableRendererFailure,
	isRpcClientTransportError,
	RENDERER_WEBSOCKET_OPEN_TIMEOUT,
	resolveRendererRpcTransportForTest,
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
		});
	});

	it("keeps Electron IPC mode when the preload bridge is present", () => {
		Object.defineProperty(globalThis, "window", {
			value: { zuse: { rpc: {} } },
			configurable: true,
		});

		expect(resolveRendererRpcTransportForTest()).toEqual({ kind: "electron" });
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
		expect(failures).toEqual([
			"WebSocket closed (4100: workspace runtime unavailable).",
		]);
		clearCloudWorkspaceRuntimeRecovery("workspace-recover");
		await session.dispose();
	});
});
