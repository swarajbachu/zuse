import {
	type ClientSession,
	makeRpcClientSession,
	withWireProtocolVersion,
} from "@zuse/client-runtime/connection";
import { wsClientProtocolLayer } from "@zuse/client-runtime/ws-protocol";
import { MemoizeRpcs, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import type { RpcClient, RpcGroup } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

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
