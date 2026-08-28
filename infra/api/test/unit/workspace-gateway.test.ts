import type {
	WebSocket as CloudflareWebSocket,
	DurableObjectState,
} from "@cloudflare/workers-types";
import {
	decodeWorkspaceGatewayFrame,
	encodeWorkspaceGatewayFrame,
} from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { WorkspaceGateway } from "../../src/workspace-gateway.ts";
import {
	decodeGatewayMessage,
	LEGACY_WORKSPACE_GATEWAY_PROTOCOL,
	WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE,
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
				| typeof LEGACY_WORKSPACE_GATEWAY_PROTOCOL;
	  }
	| {
			readonly role: "client";
			readonly connectionId: string;
			readonly workspaceId: string;
			readonly generation: number;
			readonly gatewayEpoch: number;
			readonly protocol?:
				| typeof WORKSPACE_GATEWAY_PROTOCOL
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

	serializeAttachment(value: { readonly role: "detached" }): void {
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
	const state = {
		getWebSockets: (tag?: string) =>
			(tag === "runtime" ? runtimes : tag === "client" ? clients : []).map(
				asCloudflareSocket,
			),
		acceptWebSocket: () => undefined,
	} as unknown as DurableObjectState;
	return {
		gateway: new WorkspaceGateway(state),
		setRuntimes: (next: ReadonlyArray<FakeSocket>) => {
			runtimes = next;
		},
		setClients: (next: ReadonlyArray<FakeSocket>) => {
			clients = next;
		},
	};
};

describe("workspace gateway", () => {
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
		expect(decodeGatewayMessage(acceptedServer.sent[0] as string)).toEqual({
			type: "client.open",
			connectionId: "current",
		});

		await gateway.webSocketClose(asCloudflareSocket(oldRuntime));
		expect(currentClient.closes).toEqual([]);
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
