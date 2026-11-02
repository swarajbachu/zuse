import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { type Duration, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import {
	cloudGatewaySocket,
	needsCloudGatewayReadiness,
} from "./cloud-gateway-socket.ts";
import { withWireProtocolVersion } from "./connection.ts";

export type WsProtocolOptions = {
	readonly key?: string;
	readonly environmentId?: string;
	/** Account cloud workspace: mint a gateway ticket, never a device grant. */
	readonly cloudWorkspaceId?: string;
	readonly host: string;
	readonly port: number;
	readonly token?: string | null;
	readonly wsBaseUrl?: string | null;
	/** Changes whenever discovery replaces the disposable local route. */
	readonly routeGeneration?: number;
	readonly pathType?: "lan" | "apple-peer";
	/** Pinned Ed25519 identity used to authenticate a rediscovered local route. */
	readonly serverPublicKey?: string;
	readonly serverKeyPin?: string;
	/** Refresh a short-lived same-account grant while keeping the local route. */
	readonly refreshAccountGrant?: boolean;
};

export type WsProtocolLayerOptions = {
	readonly openTimeout?: Duration.Input;
	/** Selected from authenticated runtime metadata; local connections remain current. */
	readonly protocolVersion?: number;
	/** Adapt retained runtime replies before current RPC schema validation. */
	readonly transformResponse?: (value: unknown) => unknown;
	readonly makeWebSocket?: (
		url: string,
		protocols?: string | Array<string>,
	) => globalThis.WebSocket;
	readonly onClose?: (event: WebSocketCloseInfo) => void;
	readonly protocols?: readonly string[];
	/**
	 * A connection supervisor owns reconnects: the socket fails once and
	 * stays failed instead of silently redialing the same URL underneath it.
	 */
	readonly supervised?: boolean;
};

/**
 * Pings go out every 5 seconds. A busy server or a radio waking from sleep can
 * stay quiet for a few seconds, so only 15 seconds without any frame counts
 * as a dead socket.
 */
export const WS_PING_TIMEOUT: Duration.Input = "15 seconds";

export type WebSocketCloseInfo = {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;
};

type WebSocketConstructor = NonNullable<
	WsProtocolLayerOptions["makeWebSocket"]
>;

export const observeWebSocketConstructor =
	(
		makeWebSocket: WebSocketConstructor,
		onClose: (event: WebSocketCloseInfo) => void,
	): WebSocketConstructor =>
	(url, protocols) => {
		const socket = makeWebSocket(url, protocols);
		socket.addEventListener(
			"close",
			(event) => {
				const close = event as unknown as WebSocketCloseInfo;
				onClose({
					code: close.code,
					reason: close.reason,
					wasClean: close.wasClean,
				});
			},
			{ once: true },
		);
		return socket;
	};

export const connectionKey = (host: string, port: number): string =>
	`${host.trim()}:${port}`;

export const wsUrl = ({ host, port }: WsProtocolOptions): string =>
	`ws://${host.trim()}:${port}`;

export const authenticatedWsUrl = (options: WsProtocolOptions): string => {
	const base = options.wsBaseUrl?.trim();
	const url = new URL(base && base.length > 0 ? base : wsUrl(options));
	if (options.token?.trim()) {
		url.searchParams.set("token", options.token.trim());
	}
	return withWireProtocolVersion(url.toString(), WIRE_PROTOCOL_VERSION);
};

export const responseSerializationLayer = (
	transformResponse?: (value: unknown) => unknown,
): Layer.Layer<RpcSerialization.RpcSerialization> =>
	transformResponse === undefined
		? RpcSerialization.layerJson
		: Layer.succeed(RpcSerialization.RpcSerialization, {
				...RpcSerialization.json,
				makeUnsafe: () => {
					const parser = RpcSerialization.json.makeUnsafe();
					return {
						encode: parser.encode,
						decode: (data) => parser.decode(data).map(transformResponse),
					};
				},
			});

export const wsClientProtocolLayer = (
	endpoint: string | WsProtocolOptions,
	options?: WsProtocolLayerOptions,
): Layer.Layer<RpcClient.Protocol> => {
	const protocols = options?.protocols;
	const baseConstructor: WebSocketConstructor = (url, values) => {
		const negotiated = protocols === undefined ? values : [...protocols];
		const socket = (
			options?.makeWebSocket ??
			((target, offered) => new globalThis.WebSocket(target, offered))
		)(url, negotiated);
		return needsCloudGatewayReadiness(negotiated)
			? cloudGatewaySocket(socket)
			: socket;
	};
	const makeWebSocket =
		options?.onClose === undefined
			? baseConstructor
			: observeWebSocketConstructor(baseConstructor, options.onClose);
	const url =
		typeof endpoint === "string" ? endpoint : authenticatedWsUrl(endpoint);
	return Layer.effect(
		RpcClient.Protocol,
		RpcClient.makeProtocolSocket({
			pingTimeout: WS_PING_TIMEOUT,
			...(options?.supervised === true
				? { retryPolicy: Schedule.recurs(0) }
				: {}),
		}),
	).pipe(
		Layer.provide(
			Socket.layerWebSocket(
				options?.protocolVersion === undefined
					? url
					: withWireProtocolVersion(url, options.protocolVersion),
				{ openTimeout: options?.openTimeout },
			),
		),
		Layer.provide(Layer.succeed(Socket.WebSocketConstructor, makeWebSocket)),
		Layer.provide(responseSerializationLayer(options?.transformResponse)),
	);
};
