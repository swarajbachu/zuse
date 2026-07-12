import {
	type ClientSession,
	makeRpcClientSession,
	withWireProtocolVersion,
} from "@zuse/client-runtime/connection";
import { wsClientProtocolLayer } from "@zuse/client-runtime/ws-protocol";
import { MemoizeRpcs, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Layer } from "effect";
import {
	RpcClient,
	type RpcGroup,
	RpcSerialization,
} from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Socket } from "effect/unstable/socket";
import WebSocket from "ws";

export type SystemRpcClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof MemoizeRpcs>,
	RpcClientError
>;

export const connectSystemRpc = (
	endpoint: string,
): Promise<ClientSession<SystemRpcClient>> =>
	makeRpcClientSession(
		wsClientProtocolLayer(
			withWireProtocolVersion(endpoint, WIRE_PROTOCOL_VERSION),
		),
		MemoizeRpcs,
		{
			protocolVersion: WIRE_PROTOCOL_VERSION,
			perform: (client, hello) => client["connect.handshake"](hello),
		},
	);

export const connectDroppableSystemRpc = async (
	endpoint: string,
): Promise<ClientSession<SystemRpcClient> & { readonly drop: () => void }> => {
	let socket: WebSocket | undefined;
	const webSocketConstructor = Layer.succeed(Socket.WebSocketConstructor)(
		(url, protocols) => {
			socket = new WebSocket(
				url,
				protocols as string | Array<string> | undefined,
			);
			return socket as unknown as globalThis.WebSocket;
		},
	);
	const protocol = RpcClient.layerProtocolSocket().pipe(
		Layer.provide(
			Socket.layerWebSocket(
				withWireProtocolVersion(endpoint, WIRE_PROTOCOL_VERSION),
			),
		),
		Layer.provide(webSocketConstructor),
		Layer.provide(RpcSerialization.layerJson),
	);
	const session = await makeRpcClientSession(protocol, MemoizeRpcs, {
		protocolVersion: WIRE_PROTOCOL_VERSION,
		perform: (client, hello) => client["connect.handshake"](hello),
	});
	return {
		...session,
		drop: () => {
			if (socket === undefined) throw new Error("WebSocket was not acquired.");
			socket.terminate();
		},
	};
};
