import {
	WORKSPACE_GATEWAY_PENDING_PROTOCOL,
	WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
	WorkspaceGatewayAvailability,
} from "@zuse/contracts";
import { Schema } from "effect";

type GatewayCloseEvent = Event & {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;
};

/**
 * A pending gateway is physically open, but is not an RPC transport yet. Delay
 * its logical open until the guest can receive a handshake. No mutation frames
 * are buffered or replayed. An existing RPC session is rebuilt after reattach.
 */
export const cloudGatewaySocket = (socket: WebSocket): WebSocket => {
	type Listener = NonNullable<Parameters<WebSocket["addEventListener"]>[1]>;
	type ListenerOptions = Parameters<WebSocket["addEventListener"]>[2];
	type Handler = (event: Event) => void;
	const listeners = new Map<Listener, { readonly once: boolean }>();
	const closeListeners = new Map<Listener, { readonly once: boolean }>();
	let opened: Event | undefined;
	let closed: GatewayCloseEvent | undefined;
	let available = false;
	let exposed = false;
	let retiring = false;
	const notifyOpen = () => {
		if (retiring || !available || opened === undefined || exposed) return;
		exposed = true;
		for (const [listener, options] of listeners) {
			if (options.once) listeners.delete(listener);
			if (typeof listener === "function") listener.call(socket, opened);
			else listener.handleEvent(opened);
		}
	};
	socket.addEventListener("open", (event) => {
		opened = event;
		notifyOpen();
	});
	const messageListeners = new Map<Listener, Handler>();
	const notifyClose = (event: GatewayCloseEvent) => {
		if (closed !== undefined) return;
		closed = event;
		listeners.clear();
		for (const [listener, options] of closeListeners) {
			if (options.once) closeListeners.delete(listener);
			if (typeof listener === "function") listener.call(socket, event);
			else listener.handleEvent(event);
		}
		closeListeners.clear();
		for (const wrapped of messageListeners.values())
			socket.removeEventListener("message", wrapped);
		messageListeners.clear();
	};
	const proxy = new Proxy(socket, {
		get(target, property) {
			if (property === "readyState")
				return closed !== undefined
					? 3
					: target.readyState === 1 && !exposed
						? 0
						: target.readyState;
			if (property === "addEventListener")
				return (
					type: string,
					listener: Listener | null,
					options?: ListenerOptions,
				) => {
					if (listener === null) return;
					if (type === "close") {
						if (!closeListeners.has(listener))
							closeListeners.set(listener, {
								once: typeof options === "object" && options.once === true,
							});
						return;
					}
					if (type === "open") {
						listeners.set(listener, {
							once: typeof options === "object" && options.once === true,
						});
						return;
					}
					if (type === "message") {
						if (messageListeners.has(listener)) return;
						const wrapped: Handler = (event) => {
							if (retiring || availability(event)) return;
							if (typeof listener === "function") listener.call(target, event);
							else listener.handleEvent(event);
						};
						messageListeners.set(listener, wrapped);
						target.addEventListener(type, wrapped, options);
						return;
					}
					target.addEventListener(type, listener, options);
				};
			if (property === "removeEventListener")
				return (
					type: string,
					listener: Listener | null,
					options?: ListenerOptions,
				) => {
					if (listener === null) return;
					if (type === "close") {
						closeListeners.delete(listener);
						return;
					}
					if (type === "open") {
						listeners.delete(listener);
						return;
					}
					const wrapped =
						type === "message" ? messageListeners.get(listener) : undefined;
					target.removeEventListener(type, wrapped ?? listener, options);
					if (wrapped !== undefined) messageListeners.delete(listener);
				};
			if (property === "send")
				return (data: Parameters<WebSocket["send"]>[0]) => {
					// Like native CLOSING sockets, do not write while the close event
					// is in flight. Effect rejects these RPCs through SocketCloseError.
					if (retiring) return;
					if (!available) throw new Error("workspace runtime pending");
					target.send(data);
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const decode = Schema.decodeUnknownSync(WorkspaceGatewayAvailability);
	const availability = (event: Event): boolean => {
		const data = "data" in event ? event.data : undefined;
		if (typeof data !== "string") return false;
		try {
			decode(JSON.parse(data));
			return true;
		} catch {
			return false;
		}
	};
	socket.addEventListener("message", (event) => {
		if (retiring) return;
		if (!availability(event)) return;
		const state = decode(JSON.parse(event.data));
		available = state.state === "available";
		if ((!available && exposed) || (available && state.reset === true)) {
			// RPC streams belong to the old runtime connection. Recreating them
			// uses the existing connection owner and durable subscription cursors.
			// Signal transport closure as soon as an established peer disappears:
			// throwing from send would be an Effect defect, not a retryable close.
			retiring = true;
			// Native close handshakes can take seconds. Retire this RPC transport
			// immediately so its owner can reconnect without waiting for TCP teardown.
			try {
				socket.close(
					WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.code,
					WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE.reason,
				);
			} finally {
				notifyClose(
					Object.assign(new Event("close"), {
						...WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
						wasClean: false,
					}),
				);
			}
			return;
		}
		notifyOpen();
	});
	socket.addEventListener("close", (event) =>
		notifyClose(event as GatewayCloseEvent),
	);
	return proxy;
};

export const needsCloudGatewayReadiness = (
	protocols?: string | readonly string[],
): boolean =>
	Array.isArray(protocols)
		? protocols.includes(WORKSPACE_GATEWAY_PENDING_PROTOCOL)
		: protocols === WORKSPACE_GATEWAY_PENDING_PROTOCOL;
