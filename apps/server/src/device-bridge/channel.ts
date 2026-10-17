import {
	BRIDGE_MAX_MESSAGE_BYTES,
	BridgeChannelRequest,
	DEVICE_BRIDGE_API_PATH,
} from "@zuse/contracts";
import { Schema } from "effect";

export interface BridgeChannelIdentity {
	accountId: string;
	deviceId: string;
	label: string;
	secret: string;
	token: string;
}
export interface DesktopBridgeChannelOptions {
	apiUrl: string;
	identity: () => Promise<BridgeChannelIdentity | null>;
	receive: (
		token: string,
		body: string,
		trust: { mintPublicKey: string; apiIssuer: string },
	) => Promise<unknown>;
}
export type BridgeChannelConnection = Pick<
	DesktopBridgeChannel,
	"snapshot" | "start" | "stop" | "restart"
>;

/** Outbound-only bridge. No environment RPC, pairing token, or tunnel dependency. */
export class DesktopBridgeChannel {
	private socket: WebSocket | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private failures = 0;
	private closed = false;
	private ready = false;
	private error: string | null = null;
	private currentAccount: string | null = null;
	constructor(private readonly deps: DesktopBridgeChannelOptions) {}

	snapshot() {
		return {
			connected: this.ready,
			error: this.error,
			accountId: this.currentAccount,
		};
	}
	start() {
		this.closed = false;
		this.restart();
	}
	stop() {
		this.closed = true;
		this.generation++;
		clearTimeout(this.timer);
		this.ready = false;
		this.currentAccount = null;
		this.socket?.close();
		this.socket = undefined;
	}
	restart() {
		if (this.closed) return;
		this.generation++;
		clearTimeout(this.timer);
		this.ready = false;
		this.currentAccount = null;
		this.socket?.close();
		this.socket = undefined;
		void this.connect(this.generation);
	}
	private retry(generation: number) {
		if (generation !== this.generation || this.closed) return;
		this.ready = false;
		this.timer = setTimeout(
			() => this.restart(),
			Math.min(1000 * 2 ** Math.min(this.failures++, 4), 16000),
		);
	}
	private async connect(generation: number) {
		try {
			const identity = await this.deps.identity();
			if (generation !== this.generation || this.closed) return;
			if (!identity) {
				this.error = null;
				return;
			}
			const response = await fetch(
				`${this.deps.apiUrl}${DEVICE_BRIDGE_API_PATH}/enroll`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${identity.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						deviceId: identity.deviceId,
						label: identity.label,
						secret: identity.secret,
					}),
					signal: AbortSignal.timeout(8000),
				},
			);
			if (generation !== this.generation) return;
			if (!response.ok) {
				this.error =
					response.status === 403
						? "Cloud device access was revoked. Enable it again on this computer."
						: response.status === 404 || response.status === 503
							? "Cloud device access is not available on this API deployment yet."
							: "Could not connect cloud device access.";
				if (response.status !== 403) this.retry(generation);
				return;
			}
			const trust = (await response.json()) as {
				mintPublicKey: string;
				apiIssuer: string;
			};
			if (
				typeof trust.mintPublicKey !== "string" ||
				typeof trust.apiIssuer !== "string"
			)
				throw new Error("Invalid bridge enrollment");
			if (generation !== this.generation) return;
			const url = new URL(
				`${this.deps.apiUrl}${DEVICE_BRIDGE_API_PATH}/connect`,
			);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("deviceId", identity.deviceId);
			const socket = new WebSocket(url, [
				"zuse-device-bridge-v1",
				`auth.${identity.token}`,
				`device.${identity.secret}`,
			]);
			this.socket = socket;
			let lastPong = Date.now();
			let activeRequests = 0;
			const deadline = setTimeout(() => socket.close(), 10000);
			const heartbeat = setInterval(() => {
				if (Date.now() - lastPong > 45000) {
					socket.close();
					return;
				}
				if (socket.readyState === WebSocket.OPEN) socket.send("ping");
			}, 15000);
			socket.onopen = () => {
				clearTimeout(deadline);
				if (generation !== this.generation) {
					socket.close();
					return;
				}
				this.currentAccount = identity.accountId;
				this.ready = true;
				this.error = null;
				this.failures = 0;
			};
			socket.onmessage = async (event) => {
				if (generation !== this.generation || !this.ready) return;
				if (event.data === "pong") {
					lastPong = Date.now();
					return;
				}
				if (
					typeof event.data !== "string" ||
					new TextEncoder().encode(event.data).length >
						BRIDGE_MAX_MESSAGE_BYTES ||
					activeRequests >= 16
				) {
					socket.close(1008, "Bridge capacity exceeded");
					return;
				}
				let request: typeof BridgeChannelRequest.Type;
				try {
					request = Schema.decodeUnknownSync(
						Schema.fromJsonString(BridgeChannelRequest),
					)(event.data);
				} catch {
					socket.close(1008, "Invalid request");
					return;
				}
				activeRequests++;
				let status = 200;
				let body: string;
				try {
					body = JSON.stringify(
						await this.deps.receive(request.token, request.body, trust),
					);
				} catch {
					status = 403;
					body = JSON.stringify({ error: "device_bridge_request_rejected" });
				} finally {
					activeRequests--;
				}
				if (
					generation === this.generation &&
					socket.readyState === WebSocket.OPEN
				)
					socket.send(
						JSON.stringify({ type: "response", id: request.id, status, body }),
					);
			};
			socket.onclose = () => {
				clearTimeout(deadline);
				clearInterval(heartbeat);
				this.retry(generation);
			};
			socket.onerror = () => {
				if (generation !== this.generation) return;
				this.error = "Cloud device connection interrupted. Reconnecting…";
				socket.close();
			};
		} catch {
			if (generation === this.generation) {
				this.error = "Could not connect cloud device access. Retrying…";
				this.retry(generation);
			}
		}
	}
}
