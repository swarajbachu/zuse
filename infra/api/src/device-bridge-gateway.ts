import type {
	DurableObjectState,
	WebSocket as WorkerSocket,
} from "@cloudflare/workers-types";
import {
	BRIDGE_MAX_MESSAGE_BYTES,
	BRIDGE_REQUEST_TIMEOUT_MS,
	BridgeChannelResponse,
	type BridgeDevice,
	BridgeEnrollment,
} from "@zuse/contracts";
import { Schema } from "effect";
import { readLimitedJsonBody } from "./http.ts";

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WorkerSocket } };
type Device = BridgeDevice & { secretHash: string };
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });
const digest = async (value: string) =>
	Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");

/** One account-scoped registry. Only authenticated API code can call this binding. */
export class DeviceBridgeGateway {
	private readonly pending = new Map<
		string,
		{ socket: WorkerSocket; finish: (response: Response) => void }
	>();
	constructor(private readonly state: DurableObjectState) {}
	private socket(deviceId: string) {
		return this.state.getWebSockets(deviceId).find((socket) => {
			const attachment = socket.deserializeAttachment() as {
				expiresAt: number;
				lastSeen: number;
			};
			return (
				socket.readyState === 1 &&
				attachment.expiresAt > Date.now() &&
				attachment.lastSeen + 45000 > Date.now()
			);
		});
	}
	private disconnect(deviceId: string) {
		for (const socket of this.state.getWebSockets(deviceId)) {
			socket.close(4001, "Device access changed");
			this.failPending(socket);
		}
	}
	private failPending(socket: WorkerSocket) {
		for (const pending of this.pending.values())
			if (pending.socket === socket)
				pending.finish(json({ error: "device_bridge_disconnected" }, 503));
	}
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const deviceId = url.searchParams.get("deviceId") ?? "";
		const key = `device:${deviceId}`;
		if (url.pathname === "/devices" && request.method === "GET") {
			const records = await this.state.storage.list<Device>({
				prefix: "device:",
			});
			return json(
				[...records.values()].map(({ secretHash: _, ...device }) => ({
					...device,
					connected: !device.revoked && Boolean(this.socket(device.deviceId)),
				})),
			);
		}
		if (url.pathname === "/enroll" && request.method === "POST") {
			let input: typeof BridgeEnrollment.Type;
			try {
				input = Schema.decodeUnknownSync(BridgeEnrollment)(
					await readLimitedJsonBody(request, 4096),
				);
			} catch {
				return json({ error: "invalid_device_enrollment" }, 400);
			}
			if (
				!/^[a-zA-Z0-9_-]{1,128}$/.test(input.deviceId) ||
				input.secret.length < 32 ||
				input.secret.length > 256 ||
				input.label.length > 200
			)
				return json({ error: "invalid_device_enrollment" }, 400);
			const enrollmentKey = `device:${input.deviceId}`;
			const secretHash = await digest(input.secret);
			return this.state.storage.transaction(async (txn) => {
				const existing = await txn.get<Device>(enrollmentKey);
				if (
					existing &&
					(existing.secretHash !== secretHash ||
						(existing.revoked && !input.restore))
				)
					return json({ error: "device_bridge_revoked" }, 403);
				const all = await txn.list({ prefix: "device:", limit: 101 });
				if (!existing && all.size >= 100)
					return json({ error: "device_limit" }, 409);
				await txn.put(enrollmentKey, {
					deviceId: input.deviceId,
					label: input.label,
					secretHash,
					revoked: false,
					connected: false,
					lastSeen: Date.now(),
				} satisfies Device);
				return json({ enrolled: true });
			});
		}
		// Finish asynchronous input work before reading authorization state. A revoke
		// must never be overwritten by a connection using a stale enrollment.
		const suppliedSecretHash =
			url.pathname === "/connect"
				? await digest(request.headers.get("x-zuse-device-secret") ?? "")
				: null;
		const payload = url.pathname === "/dispatch" ? await request.text() : "";
		const device = await this.state.storage.get<Device>(key);
		if (!device || device.revoked)
			return json({ error: "device_bridge_target_rejected" }, 403);
		if (url.pathname === "/revoke" && request.method === "POST") {
			await this.state.storage.put(key, {
				...device,
				revoked: true,
				connected: false,
			});
			this.disconnect(deviceId);
			return json({ revoked: true });
		}
		if (
			url.pathname === "/connect" &&
			request.headers.get("upgrade")?.toLowerCase() === "websocket"
		) {
			if (suppliedSecretHash !== device.secretHash)
				return json({ error: "invalid_device_credential" }, 403);
			this.disconnect(deviceId);
			const pair = new WebSocketPair();
			pair[1].serializeAttachment({
				deviceId,
				expiresAt: Date.now() + 5 * 60_000,
				lastSeen: Date.now(),
			});
			this.state.acceptWebSocket(pair[1], [deviceId]);
			await this.state.storage.put(key, { ...device, lastSeen: Date.now() });
			await this.state.storage.setAlarm(Date.now() + 30_000);
			return new Response(null, {
				status: 101,
				headers: { "sec-websocket-protocol": "zuse-device-bridge-v1" },
				webSocket: pair[0],
			} as ResponseInit);
		}
		if (url.pathname === "/dispatch" && request.method === "POST") {
			const socket = this.socket(deviceId);
			if (!socket) return json({ error: "device_bridge_desktop_offline" }, 503);
			if (
				new TextEncoder().encode(payload).length > BRIDGE_MAX_MESSAGE_BYTES ||
				this.pending.size >= 64
			)
				return json({ error: "device_bridge_busy" }, 429);
			const id = crypto.randomUUID();
			return new Promise<Response>((resolve) => {
				const timer = setTimeout(
					() => finish(json({ error: "device_bridge_request_timeout" }, 504)),
					BRIDGE_REQUEST_TIMEOUT_MS,
				);
				const finish = (response: Response) => {
					clearTimeout(timer);
					this.pending.delete(id);
					resolve(response);
				};
				this.pending.set(id, { socket, finish });
				try {
					socket.send(
						JSON.stringify({ ...JSON.parse(payload), type: "request", id }),
					);
				} catch {
					finish(json({ error: "device_bridge_disconnected" }, 503));
				}
			});
		}
		return json({ error: "not_found" }, 404);
	}
	async webSocketMessage(socket: WorkerSocket, message: string | ArrayBuffer) {
		if (
			typeof message !== "string" ||
			new TextEncoder().encode(message).length > BRIDGE_MAX_MESSAGE_BYTES
		) {
			socket.close(1009, "Message too large");
			this.failPending(socket);
			return;
		}
		const attachment = socket.deserializeAttachment() as {
			deviceId: string;
			expiresAt: number;
			lastSeen: number;
		};
		if (
			attachment.expiresAt < Date.now() ||
			this.socket(attachment.deviceId) !== socket
		) {
			socket.close(4001, "Reconnect required");
			this.failPending(socket);
			return;
		}
		if (message === "ping") {
			socket.serializeAttachment({ ...attachment, lastSeen: Date.now() });
			socket.send("pong");
			return;
		}
		try {
			const response = Schema.decodeUnknownSync(
				Schema.fromJsonString(BridgeChannelResponse),
			)(message);
			const pending = this.pending.get(response.id);
			if (
				pending?.socket === socket &&
				[200, 400, 403, 503].includes(response.status)
			)
				pending.finish(
					new Response(response.body, {
						status: response.status,
						headers: {
							"content-type": "application/json",
							"cache-control": "no-store",
						},
					}),
				);
		} catch {
			socket.close(1008, "Invalid bridge message");
			this.failPending(socket);
		}
	}
	webSocketClose(socket: WorkerSocket) {
		this.failPending(socket);
	}
	webSocketError(socket: WorkerSocket) {
		this.failPending(socket);
	}
	async alarm() {
		const sockets = this.state.getWebSockets();
		for (const socket of sockets) {
			const attachment = socket.deserializeAttachment() as {
				expiresAt: number;
				lastSeen: number;
			};
			if (
				attachment.expiresAt <= Date.now() ||
				attachment.lastSeen + 45000 <= Date.now()
			) {
				socket.close(4001, "Renew authentication");
				this.failPending(socket);
			}
		}
		if (sockets.length) await this.state.storage.setAlarm(Date.now() + 30_000);
	}
}
