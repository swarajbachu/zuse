import type {
	WebSocket as CloudflareWebSocket,
	DurableObjectState,
} from "@cloudflare/workers-types";
import {
	decodeGatewayMessage,
	encodeGatewayFrame,
	encodeGatewayMessage,
	WORKSPACE_GATEWAY_PROTOCOL,
} from "./workspace-gateway-protocol.ts";

type GatewaySocketAttachment =
	| { readonly role: "runtime" }
	| {
			readonly role: "client";
			readonly connectionId: string;
	  };

type PendingFrame = Readonly<{
	encoding: "text" | "base64";
	payload: string;
}>;

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
): void => {
	try {
		socket.send(value);
	} catch {
		closeSocket(socket, 1011, "gateway delivery failed");
	}
};

const pendingFrames = (value: unknown): ReadonlyArray<PendingFrame> =>
	Array.isArray(value)
		? value.flatMap((frame) => {
				if (typeof frame !== "object" || frame === null) return [];
				const candidate = frame as Record<string, unknown>;
				return (candidate.encoding === "text" ||
					candidate.encoding === "base64") &&
					typeof candidate.payload === "string"
					? [{ encoding: candidate.encoding, payload: candidate.payload }]
					: [];
			})
		: [];

const attachment = (
	socket: CloudflareWebSocket,
): GatewaySocketAttachment | null => {
	const value = socket.deserializeAttachment();
	if (value === null || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.role === "runtime") return { role: "runtime" };
	if (candidate.role === "client" && typeof candidate.connectionId === "string")
		return {
			role: "client",
			connectionId: candidate.connectionId,
		};
	return null;
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

	private pendingKey(connectionId: string): string {
		return `pending:${connectionId}`;
	}

	private async takePending(
		connectionId: string,
	): Promise<ReadonlyArray<PendingFrame>> {
		const key = this.pendingKey(connectionId);
		const frames = pendingFrames(await this.state.storage.get(key));
		if (frames.length > 0) await this.state.storage.delete(key);
		return frames;
	}

	private runtimeSockets(): ReadonlyArray<CloudflareWebSocket> {
		return this.state.getWebSockets("runtime");
	}

	private clientSockets(): ReadonlyArray<CloudflareWebSocket> {
		return this.state.getWebSockets("client");
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/notify") {
			const raw = await request.text();
			const message = decodeGatewayMessage(raw);
			if (
				message === null ||
				(message.type !== "command.available" &&
					message.type !== "event.available" &&
					message.type !== "workspace.status")
			)
				return new Response("invalid notification", { status: 400 });
			const encoded = encodeGatewayMessage(message);
			if (message.type === "command.available") {
				for (const socket of this.runtimeSockets()) send(socket, encoded);
			}
			return new Response(null, { status: 204 });
		}

		if (
			request.method !== "GET" ||
			request.headers.get("upgrade")?.toLowerCase() !== "websocket"
		)
			return new Response("websocket upgrade required", { status: 426 });

		const role = request.headers.get("x-zuse-gateway-role");
		const workspaceId = request.headers.get("x-zuse-gateway-workspace");
		if (workspaceId === null || (role !== "runtime" && role !== "client"))
			return new Response("unauthorized", { status: 401 });

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		if (role === "runtime") {
			for (const existing of this.runtimeSockets())
				closeSocket(existing, 4001, "runtime replaced");
			server.serializeAttachment({
				role: "runtime",
			} satisfies GatewaySocketAttachment);
			this.state.acceptWebSocket(server, ["runtime"]);
			for (const socket of this.clientSockets()) {
				const metadata = attachment(socket);
				if (metadata?.role === "client") {
					send(
						server,
						encodeGatewayMessage({
							type: "client.open",
							connectionId: metadata.connectionId,
						}),
					);
					for (const frame of await this.takePending(metadata.connectionId))
						send(
							server,
							encodeGatewayMessage({
								type: "client.frame",
								connectionId: metadata.connectionId,
								...frame,
							}),
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
		} satisfies GatewaySocketAttachment);
		this.state.acceptWebSocket(server, ["client"]);
		for (const runtime of this.runtimeSockets())
			send(
				runtime,
				encodeGatewayMessage({ type: "client.open", connectionId }),
			);
		return websocketResponse(client);
	}

	async webSocketMessage(
		socket: CloudflareWebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		const metadata = attachment(socket);
		if (metadata?.role === "client") {
			const frame = encodeGatewayFrame(message);
			const runtimes = this.runtimeSockets();
			if (runtimes.length === 0) {
				const key = this.pendingKey(metadata.connectionId);
				const queued = pendingFrames(await this.state.storage.get(key));
				const next = [...queued, frame].slice(-64);
				const size = next.reduce(
					(total, item) => total + item.payload.length,
					0,
				);
				if (size > 512 * 1_024) {
					closeSocket(socket, 1009, "gateway startup buffer exceeded");
					await this.state.storage.delete(key);
					return;
				}
				await this.state.storage.put(key, next);
				const connected = this.runtimeSockets();
				if (connected.length > 0) {
					for (const pending of await this.takePending(metadata.connectionId))
						for (const runtime of connected)
							send(
								runtime,
								encodeGatewayMessage({
									type: "client.frame",
									connectionId: metadata.connectionId,
									...pending,
								}),
							);
				}
				return;
			}
			for (const runtime of runtimes)
				send(
					runtime,
					encodeGatewayMessage({
						type: "client.frame",
						connectionId: metadata.connectionId,
						...frame,
					}),
				);
			return;
		}
		if (metadata?.role !== "runtime" || typeof message !== "string") return;
		const decoded = decodeGatewayMessage(message);
		if (decoded === null) return;
		if (decoded.type === "runtime.frame") {
			for (const client of this.clientSockets()) {
				const clientMetadata = attachment(client);
				if (
					clientMetadata?.role === "client" &&
					clientMetadata.connectionId === decoded.connectionId
				)
					send(
						client,
						decoded.encoding === "text"
							? decoded.payload
							: Uint8Array.from(Buffer.from(decoded.payload, "base64")).buffer,
					);
			}
			return;
		}
	}

	async webSocketClose(socket: CloudflareWebSocket): Promise<void> {
		const metadata = attachment(socket);
		if (metadata?.role === "client") {
			await this.state.storage.delete(this.pendingKey(metadata.connectionId));
			for (const runtime of this.runtimeSockets())
				send(
					runtime,
					encodeGatewayMessage({
						type: "client.close",
						connectionId: metadata.connectionId,
					}),
				);
			return;
		}
		if (metadata?.role === "runtime") {
			for (const client of this.clientSockets())
				closeSocket(client, 1012, "workspace runtime disconnected");
		}
	}

	webSocketError(socket: CloudflareWebSocket): void {
		closeSocket(socket, 1011, "gateway socket error");
	}
}
