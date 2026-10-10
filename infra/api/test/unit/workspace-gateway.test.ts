import type {
	WebSocket as CloudflareWebSocket,
	DurableObjectState,
} from "@cloudflare/workers-types";
import {
	decodeWorkspaceGatewayFrame,
	encodeWorkspaceGatewayFrame,
} from "@zuse/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkspaceGateway } from "../../src/workspace-gateway.ts";
import {
	decodeGatewayMessage,
	LEGACY_WORKSPACE_GATEWAY_PROTOCOL,
	WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE,
	WORKSPACE_GATEWAY_PENDING_PROTOCOL,
	WORKSPACE_GATEWAY_PROTOCOL,
	WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
	WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
} from "../../src/workspace-gateway-protocol.ts";

type Attachment =
	| {
			readonly role: "runtime";
			readonly workspaceId: string;
			readonly generation: number;
			readonly gatewayEpoch: number;
			readonly protocol?:
				| typeof WORKSPACE_GATEWAY_PROTOCOL
				| typeof WORKSPACE_GATEWAY_PENDING_PROTOCOL
				| typeof LEGACY_WORKSPACE_GATEWAY_PROTOCOL;
	  }
	| {
			readonly role: "client";
			readonly wasReady?: boolean;
			readonly pendingUntil?: number;
			readonly connectionId: string;
			readonly actorId?: string;
			readonly permission?: "view" | "edit";
			readonly workspaceId: string;
			readonly generation: number;
			readonly gatewayEpoch: number;
			readonly protocol?:
				| typeof WORKSPACE_GATEWAY_PROTOCOL
				| typeof WORKSPACE_GATEWAY_PENDING_PROTOCOL
				| typeof LEGACY_WORKSPACE_GATEWAY_PROTOCOL;
	  };

const fence = {
	workspaceId: "workspace-1",
	generation: 3,
	gatewayEpoch: 4,
} as const;

class FakeSocket {
	readonly sent: Array<string | ArrayBuffer> = [];
	readonly closes: Array<{ readonly code: number; readonly reason: string }> =
		[];

	constructor(
		private metadata: Attachment | { readonly role: "detached" },
		private readonly failSend = false,
	) {}

	deserializeAttachment(): Attachment | { readonly role: "detached" } {
		return this.metadata;
	}

	serializeAttachment(value: Attachment | { readonly role: "detached" }): void {
		this.metadata = value;
	}

	send(value: string | ArrayBuffer): void {
		if (this.failSend) throw new Error("socket backpressure");
		this.sent.push(value);
	}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
	}
}

const asCloudflareSocket = (socket: FakeSocket): CloudflareWebSocket =>
	socket as unknown as CloudflareWebSocket;

const makeGateway = (input?: {
	readonly runtimes?: ReadonlyArray<FakeSocket>;
	readonly clients?: ReadonlyArray<FakeSocket>;
}) => {
	let runtimes = input?.runtimes ?? [];
	let clients = input?.clients ?? [];
	let alarmAt: number | null = null;
	const state = {
		getWebSockets: (tag?: string) =>
			(tag === "runtime" ? runtimes : tag === "client" ? clients : []).map(
				asCloudflareSocket,
			),
		acceptWebSocket: (socket: FakeSocket, tags: string[]) => {
			if (tags.includes("runtime")) runtimes = [...runtimes, socket];
			if (tags.includes("client")) clients = [...clients, socket];
		},
		storage: {
			getAlarm: async () => alarmAt,
			setAlarm: async (time: number) => {
				alarmAt = time;
			},
		},
	} as unknown as DurableObjectState;
	return {
		gateway: new WorkspaceGateway(state),
		reconstruct: () => new WorkspaceGateway(state),
		alarmAt: () => alarmAt,
		setRuntimes: (next: ReadonlyArray<FakeSocket>) => {
			runtimes = next;
		},
		setClients: (next: ReadonlyArray<FakeSocket>) => {
			clients = next;
		},
	};
};

const upgrade = async (
	gateway: WorkspaceGateway,
	metadata: Attachment,
): Promise<FakeSocket> => {
	const server = new FakeSocket(metadata);
	const peer = new FakeSocket(metadata);
	vi.stubGlobal(
		"WebSocketPair",
		class {
			readonly 0 = peer;
			readonly 1 = server;
		},
	);
	vi.stubGlobal(
		"Response",
		class {
			readonly status: number;
			constructor(_body: unknown, init: ResponseInit = {}) {
				this.status = init.status ?? 200;
			}
		},
	);
	try {
		const response = await gateway.fetch(
			new Request("https://gateway.internal/attach", {
				headers: {
					upgrade: "websocket",
					"x-zuse-gateway-role": metadata.role,
					"x-zuse-gateway-protocol":
						metadata.protocol ?? WORKSPACE_GATEWAY_PROTOCOL,
					"x-zuse-gateway-workspace": metadata.workspaceId,
					"x-zuse-gateway-generation": String(metadata.generation),
					"x-zuse-gateway-epoch": String(metadata.gatewayEpoch),
					...(metadata.role === "client"
						? {
								"x-zuse-gateway-connection": metadata.connectionId,
								...(metadata.actorId
									? { "x-zuse-gateway-actor": metadata.actorId }
									: {}),
								...(metadata.permission
									? { "x-zuse-gateway-permission": metadata.permission }
									: {}),
							}
						: {}),
				},
			}),
		);
		expect(response.status).toBe(101);
		return server;
	} finally {
		vi.unstubAllGlobals();
	}
};

const v3Client = {
	role: "client",
	connectionId: "waiting-client",
	actorId: "member-1",
	permission: "edit",
	protocol: WORKSPACE_GATEWAY_PENDING_PROTOCOL,
	...fence,
} as const;
const availability = (
	state: "pending" | "available",
	reset?: boolean,
): string =>
	JSON.stringify({
		_zuseGateway: "availability",
		state,
		...(reset === undefined ? {} : { reset }),
	});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("workspace gateway", () => {
	test("delivers a command nudge to the connected runtime", async () => {
		const runtime = new FakeSocket({ role: "runtime", ...fence });
		const { gateway } = makeGateway({ runtimes: [runtime] });
		const response = await gateway.fetch(
			new Request("https://gateway.internal/nudge", {
				method: "POST",
				headers: { "x-zuse-gateway-nudge": "command" },
			}),
		);
		expect(response.status).toBe(204);
		expect(runtime.sent).toEqual([JSON.stringify({ type: "runtime.command" })]);
	});

	test("reports 503 for a command nudge with no runtime attached", async () => {
		const { gateway } = makeGateway();
		const response = await gateway.fetch(
			new Request("https://gateway.internal/nudge", {
				method: "POST",
				headers: { "x-zuse-gateway-nudge": "command" },
			}),
		);
		expect(response.status).toBe(503);
	});

	test("never decodes runtime.command as an inbound peer message", () => {
		expect(
			decodeGatewayMessage(JSON.stringify({ type: "runtime.command" })),
		).toBeNull();
	});

	test("closes a client instead of buffering a frame when no runtime exists", async () => {
		const client = new FakeSocket({
			role: "client",
			connectionId: "client-1",
			...fence,
		});
		const { gateway } = makeGateway({ clients: [client] });

		await gateway.webSocketMessage(asCloudflareSocket(client), "rpc-frame");

		expect(client.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
		expect(client.sent).toEqual([]);
	});

	test("forwards client frames directly to the current runtime", async () => {
		const client = new FakeSocket({
			role: "client",
			connectionId: "client-1",
			...fence,
		});
		const runtime = new FakeSocket({ role: "runtime", ...fence });
		const { gateway } = makeGateway({ runtimes: [runtime], clients: [client] });

		await gateway.webSocketMessage(asCloudflareSocket(client), "rpc-frame");

		expect(client.closes).toEqual([]);
		expect(runtime.sent).toHaveLength(1);
		expect(decodeWorkspaceGatewayFrame(runtime.sent[0] as ArrayBuffer)).toEqual(
			{
				direction: "client",
				connectionId: "client-1",
				payload: "rpc-frame",
			},
		);
	});

	test("translates frames for a legacy runtime without downgrading clients", async () => {
		const client = new FakeSocket({
			role: "client",
			connectionId: "client-1",
			protocol: WORKSPACE_GATEWAY_PROTOCOL,
			...fence,
		});
		const runtime = new FakeSocket({
			role: "runtime",
			protocol: LEGACY_WORKSPACE_GATEWAY_PROTOCOL,
			...fence,
		});
		const { gateway } = makeGateway({ runtimes: [runtime], clients: [client] });

		await gateway.webSocketMessage(asCloudflareSocket(client), "request");
		expect(JSON.parse(runtime.sent[0] as string)).toEqual({
			type: "client.frame",
			connectionId: "client-1",
			encoding: "text",
			payload: "request",
		});

		await gateway.webSocketMessage(
			asCloudflareSocket(runtime),
			JSON.stringify({
				type: "runtime.frame",
				connectionId: "client-1",
				encoding: "text",
				payload: "response",
			}),
		);
		expect(client.sent).toEqual(["response"]);
	});

	test("closes a stale client when only another runtime generation exists", async () => {
		const client = new FakeSocket({
			role: "client",
			connectionId: "client-1",
			...fence,
		});
		const runtime = new FakeSocket({
			role: "runtime",
			...fence,
			generation: fence.generation + 1,
		});
		const { gateway } = makeGateway({ runtimes: [runtime], clients: [client] });

		await gateway.webSocketMessage(asCloudflareSocket(client), "rpc-frame");

		expect(client.closes).toEqual([WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE]);
		expect(runtime.sent).toEqual([]);
	});

	test("closes both sides with backpressure when runtime delivery throws", async () => {
		const client = new FakeSocket({
			role: "client",
			connectionId: "client-1",
			...fence,
		});
		const runtime = new FakeSocket({ role: "runtime", ...fence }, true);
		const { gateway } = makeGateway({ runtimes: [runtime], clients: [client] });

		await gateway.webSocketMessage(asCloudflareSocket(client), "rpc-frame");

		expect(runtime.closes).toEqual([WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE]);
		expect(client.closes).toEqual([WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE]);
	});

	test("notifies the runtime when it targets a detached client", async () => {
		const runtime = new FakeSocket({ role: "runtime", ...fence });
		const { gateway } = makeGateway({ runtimes: [runtime] });

		await gateway.webSocketMessage(
			asCloudflareSocket(runtime),
			encodeWorkspaceGatewayFrame({
				direction: "runtime",
				connectionId: "detached-client",
				payload: "late-frame",
			}),
		);

		expect(decodeGatewayMessage(runtime.sent[0] as string)).toEqual({
			type: "client.close",
			connectionId: "detached-client",
		});
	});

	test("lets the runtime reject a client whose local RPC peer failed", async () => {
		const client = new FakeSocket({
			role: "client",
			connectionId: "client-1",
			...fence,
		});
		const otherClient = new FakeSocket({
			role: "client",
			connectionId: "client-2",
			...fence,
		});
		const runtime = new FakeSocket({ role: "runtime", ...fence });
		const { gateway } = makeGateway({
			runtimes: [runtime],
			clients: [client, otherClient],
		});

		await gateway.webSocketMessage(
			asCloudflareSocket(runtime),
			JSON.stringify({ type: "client.close", connectionId: "client-1" }),
		);

		expect(client.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
		expect(otherClient.closes).toEqual([]);
	});

	test("keeps the runtime attached while a client quits and its replacement reconnects", async () => {
		const disconnected = new FakeSocket({
			role: "client",
			connectionId: "client-before-sleep",
			...fence,
		});
		const reconnected = new FakeSocket({
			role: "client",
			connectionId: "client-after-wake",
			...fence,
		});
		const runtime = new FakeSocket({ role: "runtime", ...fence });
		const gatewayState = makeGateway({
			runtimes: [runtime],
			clients: [disconnected],
		});

		await gatewayState.gateway.webSocketClose(asCloudflareSocket(disconnected));
		expect(decodeGatewayMessage(runtime.sent[0] as string)).toEqual({
			type: "client.close",
			connectionId: "client-before-sleep",
		});
		expect(runtime.closes).toEqual([]);

		gatewayState.setClients([reconnected]);
		await gatewayState.gateway.webSocketMessage(
			asCloudflareSocket(reconnected),
			"resume-from-durable-cursor",
		);
		expect(decodeWorkspaceGatewayFrame(runtime.sent[1] as ArrayBuffer)).toEqual(
			{
				direction: "client",
				connectionId: "client-after-wake",
				payload: "resume-from-durable-cursor",
			},
		);
		expect(reconnected.closes).toEqual([]);
	});

	test("replaces same-generation runtimes but rejects a late older generation", async () => {
		const currentRuntime = new FakeSocket({
			role: "runtime",
			...fence,
			generation: fence.generation + 1,
		});
		const { gateway } = makeGateway({ runtimes: [currentRuntime] });
		const acceptedServer = new FakeSocket({ role: "runtime", ...fence });
		const acceptedClient = new FakeSocket({ role: "runtime", ...fence });
		const globals = globalThis as unknown as {
			WebSocketPair?: unknown;
			Response: typeof Response;
		};
		const originalPair = globals.WebSocketPair;
		const originalResponse = globals.Response;
		Object.assign(globals, {
			WebSocketPair: class {
				readonly 0 = acceptedClient;
				readonly 1 = acceptedServer;
			},
			Response: class {
				readonly status: number;
				constructor(_body: unknown, init: ResponseInit = {}) {
					this.status = init.status ?? 200;
				}
			},
		});
		try {
			const response = await gateway.fetch(
				new Request("https://api.test/gateway", {
					headers: {
						upgrade: "websocket",
						"x-zuse-gateway-role": "runtime",
						"x-zuse-gateway-protocol": WORKSPACE_GATEWAY_PROTOCOL,
						"x-zuse-gateway-workspace": fence.workspaceId,
						"x-zuse-gateway-generation": String(fence.generation),
						"x-zuse-gateway-epoch": String(fence.gatewayEpoch),
					},
				}),
			);
			expect(response.status).toBe(101);
		} finally {
			Object.assign(globals, {
				WebSocketPair: originalPair,
				Response: originalResponse,
			});
		}
		expect(currentRuntime.closes).toEqual([]);
		expect(acceptedServer.closes).toEqual([
			WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
		]);
	});

	test("replacing a runtime detaches the old callback and evicts stale clients", async () => {
		const oldRuntime = new FakeSocket({ role: "runtime", ...fence });
		const currentClient = new FakeSocket({
			role: "client",
			connectionId: "current",
			actorId: "member-1",
			permission: "view",
			...fence,
		});
		const staleClient = new FakeSocket({
			role: "client",
			connectionId: "stale",
			...fence,
			generation: fence.generation - 1,
		});
		const { gateway } = makeGateway({
			runtimes: [oldRuntime],
			clients: [currentClient, staleClient],
		});
		const acceptedServer = new FakeSocket({ role: "runtime", ...fence });
		const acceptedClient = new FakeSocket({ role: "runtime", ...fence });
		const globals = globalThis as unknown as {
			WebSocketPair?: unknown;
			Response: typeof Response;
		};
		const originalPair = globals.WebSocketPair;
		const originalResponse = globals.Response;
		Object.assign(globals, {
			WebSocketPair: class {
				readonly 0 = acceptedClient;
				readonly 1 = acceptedServer;
			},
			Response: class {
				readonly status: number;
				constructor(_body: unknown, init: ResponseInit = {}) {
					this.status = init.status ?? 200;
				}
			},
		});
		try {
			await gateway.fetch(
				new Request("https://api.test/gateway", {
					headers: {
						upgrade: "websocket",
						"x-zuse-gateway-role": "runtime",
						"x-zuse-gateway-protocol": WORKSPACE_GATEWAY_PROTOCOL,
						"x-zuse-gateway-workspace": fence.workspaceId,
						"x-zuse-gateway-generation": String(fence.generation),
						"x-zuse-gateway-epoch": String(fence.gatewayEpoch),
					},
				}),
			);
		} finally {
			Object.assign(globals, {
				WebSocketPair: originalPair,
				Response: originalResponse,
			});
		}
		expect(oldRuntime.closes).toEqual([
			{ code: 4001, reason: "runtime replaced" },
		]);
		expect(staleClient.closes).toEqual([
			WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
		]);
		expect(acceptedServer.sent).toEqual([]);
		expect(currentClient.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);

		await gateway.webSocketClose(asCloudflareSocket(oldRuntime));
		expect(currentClient.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
	});

	test("does not evict clients when a replaced runtime finishes closing", async () => {
		const client = new FakeSocket({
			role: "client",
			connectionId: "client-1",
			...fence,
		});
		const oldRuntime = new FakeSocket({ role: "runtime", ...fence });
		const replacementRuntime = new FakeSocket({ role: "runtime", ...fence });
		const gatewayState = makeGateway({
			runtimes: [replacementRuntime],
			clients: [client],
		});

		await gatewayState.gateway.webSocketClose(asCloudflareSocket(oldRuntime));
		expect(client.closes).toEqual([]);

		gatewayState.setRuntimes([]);
		await gatewayState.gateway.webSocketClose(
			asCloudflareSocket(replacementRuntime),
		);
		expect(client.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
	});

	test("a runtime close only evicts clients with its fence", async () => {
		const matchingClient = new FakeSocket({
			role: "client",
			connectionId: "matching",
			...fence,
		});
		const newerClient = new FakeSocket({
			role: "client",
			connectionId: "newer",
			...fence,
			generation: fence.generation + 1,
		});
		const runtime = new FakeSocket({ role: "runtime", ...fence });
		const { gateway } = makeGateway({
			clients: [matchingClient, newerClient],
		});

		await gateway.webSocketClose(asCloudflareSocket(runtime));

		expect(matchingClient.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
		expect(newerClient.closes).toEqual([]);
	});
});

describe("pending gateway attachments", () => {
	test("a premature RPC is rejected and cannot be replayed when the runtime arrives", async () => {
		const owner = makeGateway();
		const client = await upgrade(owner.gateway, v3Client);
		await owner.gateway.webSocketMessage(
			asCloudflareSocket(client),
			"premature-write",
		);
		expect(client.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
		const runtime = await upgrade(owner.reconstruct(), {
			role: "runtime",
			...fence,
		});
		expect(runtime.sent).toEqual([]);
		expect(client.sent).toEqual([availability("pending")]);
	});

	test("persists the first wait and opens RPC only after a matching runtime attaches", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const owner = makeGateway();
		const client = await upgrade(owner.gateway, v3Client);
		expect(client.closes).toEqual([]);
		expect(client.sent).toEqual([availability("pending")]);
		expect(client.deserializeAttachment()).toMatchObject({
			wasReady: false,
			pendingUntil: 31_000,
		});
		expect(owner.alarmAt()).toBe(31_000);
		const restored = owner.reconstruct();
		const runtime = await upgrade(restored, { role: "runtime", ...fence });
		expect(
			runtime.sent.map((value) => decodeGatewayMessage(String(value))),
		).toEqual([
			{
				type: "client.open",
				connectionId: v3Client.connectionId,
				actorId: v3Client.actorId,
				permission: "edit",
			},
		]);
		expect(client.sent).toEqual([
			availability("pending"),
			availability("available", false),
		]);
		expect(client.deserializeAttachment()).toMatchObject({ wasReady: true });
		expect(client.deserializeAttachment()).not.toHaveProperty("pendingUntil");
		await restored.webSocketMessage(asCloudflareSocket(client), "first-rpc");
		expect(decodeWorkspaceGatewayFrame(runtime.sent[1] as ArrayBuffer)).toEqual(
			{
				direction: "client",
				connectionId: v3Client.connectionId,
				payload: "first-rpc",
			},
		);
	});

	test("reconstruction preserves deadlines and expires each client without extending its wait", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const owner = makeGateway();
		const first = await upgrade(owner.gateway, v3Client);
		now.mockReturnValue(2_000);
		const second = await upgrade(owner.gateway, {
			...v3Client,
			connectionId: "second",
		});
		expect(owner.alarmAt()).toBe(31_000);
		const restored = owner.reconstruct();
		now.mockReturnValue(31_000);
		await restored.alarm();
		expect(first.closes).toEqual([WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE]);
		expect(first.deserializeAttachment()).toEqual({ role: "detached" });
		expect(second.closes).toEqual([]);
		expect(owner.alarmAt()).toBe(32_000);
		now.mockReturnValue(32_000);
		await owner.reconstruct().alarm();
		expect(second.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
	});

	test("a late runtime cannot revive an expired pending client before the alarm runs", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const owner = makeGateway();
		const client = await upgrade(owner.gateway, v3Client);
		now.mockReturnValue(31_001);
		const runtime = await upgrade(owner.reconstruct(), {
			role: "runtime",
			...fence,
		});
		expect(client.closes).toEqual([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
		]);
		expect(runtime.sent).toEqual([]);
		expect(client.sent).toEqual([availability("pending")]);
	});

	test("reattachment resets an old RPC stream and fences racing old client frames", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const oldRuntime = new FakeSocket({ role: "runtime", ...fence });
		const owner = makeGateway({ runtimes: [oldRuntime] });
		const client = await upgrade(owner.gateway, v3Client);
		await owner.gateway.webSocketClose(asCloudflareSocket(oldRuntime));
		expect(client.sent).toEqual([
			availability("available", false),
			availability("pending"),
		]);
		const restored = owner.reconstruct();
		const runtime = await upgrade(restored, { role: "runtime", ...fence });
		expect(client.sent.at(-1)).toBe(availability("available", true));
		expect(runtime.sent).toEqual([]);
		await restored.webSocketMessage(asCloudflareSocket(client), "late-old-rpc");
		await restored.webSocketClose(asCloudflareSocket(client));
		expect(runtime.sent).toEqual([]);
		const fresh = await upgrade(restored, {
			...v3Client,
			connectionId: "fresh-rpc",
		});
		expect(fresh.sent).toEqual([availability("available", false)]);
		expect(decodeGatewayMessage(runtime.sent[0] as string)).toMatchObject({
			type: "client.open",
			connectionId: "fresh-rpc",
		});
	});

	test("a different runtime generation evicts pending clients without opening them", async () => {
		const owner = makeGateway();
		const client = await upgrade(owner.gateway, v3Client);
		const runtime = await upgrade(owner.reconstruct(), {
			role: "runtime",
			...fence,
			generation: fence.generation + 1,
		});
		expect(client.closes).toEqual([WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE]);
		expect(runtime.sent).toEqual([]);
	});

	test("a delayed older gateway epoch cannot evict the current runtime or clients", async () => {
		const current = { ...fence, gatewayEpoch: fence.gatewayEpoch + 1 };
		const runtime = new FakeSocket({ role: "runtime", ...current });
		const client = new FakeSocket({ ...v3Client, ...current, wasReady: true });
		const owner = makeGateway({ runtimes: [runtime], clients: [client] });
		const delayed = await upgrade(owner.gateway, {
			role: "runtime",
			...fence,
			generation: fence.generation + 1,
		});
		expect(delayed.closes).toEqual([WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE]);
		expect(runtime.closes).toEqual([]);
		expect(client.sent).toEqual([]);
		expect(client.closes).toEqual([]);
	});
});
