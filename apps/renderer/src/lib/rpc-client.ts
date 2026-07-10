import {
	makeRpcClientSession,
	withWireProtocolVersion,
} from "@zuse/client-runtime/connection";
import {
	type ConnectionSupervisorEntry,
	createConnectionSupervisor,
} from "@zuse/client-runtime/supervisor";
import { MemoizeRpcs, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	type RpcClient,
	type RpcGroup,
	RpcSerialization,
} from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { RpcBridge } from "./bridge.ts";
import { electronClientProtocolLayer } from "./electron-client-protocol.ts";
import { wsClientProtocolLayer } from "./ws-client-protocol.ts";

type MemoizeClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof MemoizeRpcs>,
	RpcClientError
>;

type RendererConnectionOptions =
	| {
			readonly key: "renderer";
			readonly kind: "electron";
			readonly bridge: RpcBridge;
	  }
	| {
			readonly key: "renderer";
			readonly kind: "websocket";
			readonly wsUrl: string;
	  };

function resolveWebSocketUrl(): string {
	const env = (
		import.meta as { readonly env?: Record<string, string | undefined> }
	).env;
	return env?.VITE_ZUSE_WS_URL?.trim() || `ws://${location.host}/rpc`;
}

export function resolveRendererRpcTransportForTest(): {
	readonly kind: "electron" | "websocket";
	readonly wsUrl?: string;
} {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	return bridge
		? { kind: "electron" }
		: { kind: "websocket", wsUrl: resolveWebSocketUrl() };
}

const connectionOptions = (): RendererConnectionOptions => {
	const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
	return bridge
		? { key: "renderer", kind: "electron", bridge: bridge.rpc }
		: { key: "renderer", kind: "websocket", wsUrl: resolveWebSocketUrl() };
};

let online = globalThis.navigator?.onLine ?? true;

const supervisor = createConnectionSupervisor<
	RendererConnectionOptions,
	MemoizeClient
>({
	keyOf: (options) => options.key,
	isOnline: () => online,
	schedule: (delayMs, reconnect) => {
		const timer = setTimeout(reconnect, delayMs);
		return () => clearTimeout(timer);
	},
	createClient: async (options) => {
		const protocolLayer =
			options.kind === "electron"
				? electronClientProtocolLayer(options.bridge).pipe(
						Layer.provide(RpcSerialization.layerJson),
					)
				: wsClientProtocolLayer(
						withWireProtocolVersion(options.wsUrl, WIRE_PROTOCOL_VERSION),
					);
		return makeRpcClientSession(protocolLayer, MemoizeRpcs, {
			protocolVersion: WIRE_PROTOCOL_VERSION,
			perform: (client, hello) => client["connect.handshake"](hello),
		});
	},
	isRetryableCommandError: isRpcClientError,
});

let rendererEntry: ConnectionSupervisorEntry<MemoizeClient> | null = null;

const getRendererEntry = (): ConnectionSupervisorEntry<MemoizeClient> => {
	const entry = supervisor.get(connectionOptions());
	if (rendererEntry === null) {
		rendererEntry = entry;
	}
	return entry;
};

function isRpcClientError(cause: unknown): boolean {
	return (
		typeof cause === "object" &&
		cause !== null &&
		"_tag" in cause &&
		cause._tag === "RpcClientError"
	);
}

export const getRpcClient = (): Promise<MemoizeClient> =>
	Effect.runPromise(getRendererEntry().getClient());

export const reportRendererRpcFailure = (cause: unknown): void => {
	getRendererEntry().reportFailure(cause);
};

export const dispatchRetryableRpcCommand = <A>(
	commandId: string,
	operation: () => Promise<A>,
): Promise<A> =>
	getRendererEntry().dispatchCommand(commandId, () => operation());

export const disposeRpcClient = async (): Promise<void> => {
	rendererEntry = null;
	await supervisor.dispose();
};

if (typeof window !== "undefined") {
	window.addEventListener("online", () => {
		online = true;
		supervisor.setOnline(true);
	});
	window.addEventListener("offline", () => {
		online = false;
		supervisor.setOnline(false);
	});
	window.addEventListener("pagehide", () => {
		void disposeRpcClient();
	});
}
