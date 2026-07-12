import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { withWireProtocolVersion } from "./connection.ts";

export type WsProtocolOptions = {
	readonly key?: string;
	readonly environmentId?: string;
	readonly host: string;
	readonly port: number;
	readonly token?: string | null;
	readonly wsBaseUrl?: string | null;
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

export const wsClientProtocolLayer = (
	endpoint: string | WsProtocolOptions,
): Layer.Layer<RpcClient.Protocol> =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(
			Socket.layerWebSocket(
				typeof endpoint === "string" ? endpoint : authenticatedWsUrl(endpoint),
			),
		),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerJson),
	);
