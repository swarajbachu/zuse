import type {
	WebSocket as CloudflareWebSocket,
	DurableObjectState,
} from "@cloudflare/workers-types";
import {
	decodeWorkspaceGatewayFrame,
	encodeWorkspaceGatewayFrame,
} from "@zuse/contracts";
import {
	decodeGatewayMessage,
	encodeGatewayMessage,
	WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE,
	WORKSPACE_GATEWAY_PROTOCOL,
	WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
	WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
} from "./workspace-gateway-protocol.ts";

type GatewayFence = {
	readonly workspaceId: string;
	readonly generation: number;
	readonly gatewayEpoch: number;
};

type GatewaySocketAttachment =
	| ({ readonly role: "runtime" } & GatewayFence)
	| ({
			readonly role: "client";
			readonly connectionId: string;
	  } & GatewayFence);

type WebSocketPairValue = {
	readonly 0: CloudflareWebSocket;
	readonly 1: CloudflareWebSocket;
};

declare const WebSocketPair: {
	new (): WebSocketPairValue;
};

const closeSocket = (
	socket: CloudflareWebSocket,
	code: number,
	reason: string,
): void => {
	try {
		socket.close(code, reason);
	} catch {
		// Closing a socket that raced with a disconnect is harmless.
	}
};

const send = (
	socket: CloudflareWebSocket,
	value: string | ArrayBuffer,
): boolean => {
	try {
		socket.send(value);
		return true;
	} catch {
		closeSocket(
			socket,
			WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.code,
			WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.reason,
		);
		return false;
	}
};

const sendControl = (
	socket: CloudflareWebSocket,
	value: string | ArrayBuffer,
): boolean => {
	try {
		socket.send(value);
		return true;
	} catch {
		return false;
	}
};

const attachment = (
	socket: CloudflareWebSocket,
): GatewaySocketAttachment | null => {
	const value = socket.deserializeAttachment();
	if (value === null || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const workspaceId = candidate.workspaceId;
	const generation = candidate.generation;
	const gatewayEpoch = candidate.gatewayEpoch;
	if (
		typeof workspaceId !== "string" ||
		typeof generation !== "number" ||
		typeof gatewayEpoch !== "number"
	)
		return null;
	const fence = { workspaceId, generation, gatewayEpoch };
	if (candidate.role === "runtime") return { role: "runtime", ...fence };
	if (candidate.role === "client" && typeof candidate.connectionId === "string")
		return {
			role: "client",
			connectionId: candidate.connectionId,
			...fence,
		};
	return null;
};

const readFence = (headers: Headers): GatewayFence | null => {
	const workspaceId = headers.get("x-zuse-gateway-workspace");
	const generation = Number(headers.get("x-zuse-gateway-generation"));
	const gatewayEpoch = Number(headers.get("x-zuse-gateway-epoch"));
	return workspaceId === null ||
		!Number.isSafeInteger(generation) ||
		generation < 1 ||
		!Number.isSafeInteger(gatewayEpoch) ||
		gatewayEpoch < 1
		? null
		: { workspaceId, generation, gatewayEpoch };
};

const sameFence = (left: GatewayFence, right: GatewayFence): boolean =>
	left.workspaceId === right.workspaceId &&
	left.generation === right.generation &&
	left.gatewayEpoch === right.gatewayEpoch;

const sameGateway = (left: GatewayFence, right: GatewayFence): boolean =>
	left.workspaceId === right.workspaceId &&
	left.gatewayEpoch === right.gatewayEpoch;

const detachSocket = (socket: CloudflareWebSocket): void => {
	try {
		// A replaced socket can remain visible to getWebSockets until its close
		// callback. Clearing its recognized role fences it immediately and also
		// makes that delayed callback a no-op after hibernation.
		socket.serializeAttachment({ role: "detached" });
	} catch {
		// The peer may have disappeared between enumeration and detachment.
	}
};

const websocketResponse = (client: CloudflareWebSocket): Response =>
	new Response(null, {
		status: 101,
		webSocket: client,
		headers: { "sec-websocket-protocol": WORKSPACE_GATEWAY_PROTOCOL },
	} as ResponseInit & { readonly webSocket: CloudflareWebSocket });

/**
 * One hibernatable Durable Object instance per cloud workspace. It owns no
 * durable product data: it only joins authenticated client sockets to the
 * workspace runtime and wakes when either side has traffic.
 */
export class WorkspaceGateway {
	constructor(private readonly state: DurableObjectState) {}

	private runtimeSockets(): ReadonlyArray<CloudflareWebSocket> {
		return this.state.getWebSockets("runtime");
	}

	private clientSockets(): ReadonlyArray<CloudflareWebSocket> {
		return this.state.getWebSockets("client");
	}

	async fetch(request: Request): Promise<Response> {
		if (
			request.method !== "GET" ||
			request.headers.get("upgrade")?.toLowerCase() !== "websocket"
		)
			return new Response("websocket upgrade required", { status: 426 });

		const role = request.headers.get("x-zuse-gateway-role");
		const fence = readFence(request.headers);
		if (fence === null || (role !== "runtime" && role !== "client"))
			return new Response("unauthorized", { status: 401 });

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		if (role === "runtime") {
			const existingRuntimes = this.runtimeSockets();
			const newerRuntimeExists = existingRuntimes.some((existing) => {
				const metadata = attachment(existing);
				return (
					metadata?.role === "runtime" &&
					sameGateway(metadata, fence) &&
					metadata.generation > fence.generation
				);
			});
			server.serializeAttachment({
				role: "runtime",
				...fence,
			} satisfies GatewaySocketAttachment);
			this.state.acceptWebSocket(server, ["runtime"]);
			if (newerRuntimeExists) {
				detachSocket(server);
				closeSocket(
					server,
					WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.code,
					WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.reason,
				);
				return websocketResponse(client);
			}
			for (const existing of existingRuntimes) {
				const metadata = attachment(existing);
				detachSocket(existing);
				closeSocket(
					existing,
					metadata !== null && sameFence(metadata, fence)
						? 4001
						: WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.code,
					metadata !== null && sameFence(metadata, fence)
						? "runtime replaced"
						: WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.reason,
				);
			}
			for (const socket of this.clientSockets()) {
				const metadata = attachment(socket);
				if (metadata?.role !== "client") continue;
				if (!sameFence(metadata, fence)) {
					closeSocket(
						socket,
						WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.code,
						WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.reason,
					);
					continue;
				}
				if (
					!send(
						server,
						encodeGatewayMessage({
							type: "client.open",
							connectionId: metadata.connectionId,
						}),
					)
				) {
					closeSocket(
						socket,
						WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.code,
						WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.reason,
					);
				}
			}
			return websocketResponse(client);
		}

		const connectionId = request.headers.get("x-zuse-gateway-connection");
		if (connectionId === null)
			return new Response("missing connection identity", { status: 400 });
		server.serializeAttachment({
			role: "client",
			connectionId,
			...fence,
		} satisfies GatewaySocketAttachment);
		this.state.acceptWebSocket(server, ["client"]);
		const runtimes = this.runtimeSockets();
		if (runtimes.length === 0) {
			closeSocket(
				server,
				WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.code,
				WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.reason,
			);
			return websocketResponse(client);
		}
		const currentRuntime = runtimes.find((runtime) => {
			const metadata = attachment(runtime);
			return metadata?.role === "runtime" && sameFence(metadata, fence);
		});
		if (currentRuntime === undefined) {
			closeSocket(
				server,
				WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.code,
				WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.reason,
			);
			return websocketResponse(client);
		}
		if (
			!send(
				currentRuntime,
				encodeGatewayMessage({ type: "client.open", connectionId }),
			)
		)
			closeSocket(
				server,
				WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.code,
				WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.reason,
			);
		return websocketResponse(client);
	}

	async webSocketMessage(
		socket: CloudflareWebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		const metadata = attachment(socket);
		if (metadata?.role === "client") {
			const runtimes = this.runtimeSockets();
			if (runtimes.length === 0) {
				closeSocket(
					socket,
					WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.code,
					WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.reason,
				);
				return;
			}
			const runtime = runtimes.find((candidate) => {
				const candidateMetadata = attachment(candidate);
				return (
					candidateMetadata?.role === "runtime" &&
					sameFence(candidateMetadata, metadata)
				);
			});
			if (runtime === undefined) {
				closeSocket(
					socket,
					WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.code,
					WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE.reason,
				);
				return;
			}
			let encoded: ArrayBuffer;
			try {
				encoded = encodeWorkspaceGatewayFrame({
					direction: "client",
					connectionId: metadata.connectionId,
					payload: message,
				});
			} catch {
				closeSocket(
					socket,
					WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.code,
					WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.reason,
				);
				return;
			}
			if (!send(runtime, encoded))
				closeSocket(
					socket,
					WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.code,
					WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.reason,
				);
			return;
		}
		if (metadata?.role !== "runtime") return;
		const decoded =
			typeof message === "string"
				? decodeGatewayMessage(message)
				: decodeWorkspaceGatewayFrame(message);
		if (decoded === null) return;
		if ("direction" in decoded && decoded.direction === "runtime") {
			let delivered = false;
			for (const client of this.clientSockets()) {
				const clientMetadata = attachment(client);
				if (
					clientMetadata?.role === "client" &&
					clientMetadata.connectionId === decoded.connectionId &&
					sameFence(clientMetadata, metadata)
				) {
					delivered = true;
					send(client, decoded.payload);
				}
			}
			if (
				!delivered &&
				!sendControl(
					socket,
					encodeGatewayMessage({
						type: "client.close",
						connectionId: decoded.connectionId,
					}),
				)
			)
				closeSocket(
					socket,
					WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.code,
					WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE.reason,
				);
			return;
		}
		if ("type" in decoded && decoded.type === "client.close") {
			for (const client of this.clientSockets()) {
				const clientMetadata = attachment(client);
				if (
					clientMetadata?.role === "client" &&
					clientMetadata.connectionId === decoded.connectionId &&
					sameFence(clientMetadata, metadata)
				) {
					closeSocket(
						client,
						WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.code,
						WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.reason,
					);
				}
			}
		}
	}

	async webSocketClose(socket: CloudflareWebSocket): Promise<void> {
		const metadata = attachment(socket);
		if (metadata?.role === "client") {
			for (const runtime of this.runtimeSockets()) {
				const runtimeMetadata = attachment(runtime);
				if (
					runtimeMetadata?.role === "runtime" &&
					sameFence(runtimeMetadata, metadata)
				)
					send(
						runtime,
						encodeGatewayMessage({
							type: "client.close",
							connectionId: metadata.connectionId,
						}),
					);
			}
			return;
		}
		if (metadata?.role === "runtime") {
			const replacementExists = this.runtimeSockets().some((runtime) => {
				const runtimeMetadata = attachment(runtime);
				return (
					runtimeMetadata?.role === "runtime" &&
					sameFence(runtimeMetadata, metadata)
				);
			});
			if (replacementExists) return;
			for (const client of this.clientSockets()) {
				const clientMetadata = attachment(client);
				if (
					clientMetadata?.role === "client" &&
					sameFence(clientMetadata, metadata)
				)
					closeSocket(
						client,
						WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.code,
						WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.reason,
					);
			}
		}
	}

	webSocketError(socket: CloudflareWebSocket): void {
		closeSocket(socket, 1011, "gateway socket error");
	}
}
