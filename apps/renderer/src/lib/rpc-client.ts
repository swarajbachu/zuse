import { CommandDispatcher } from "@zuse/client-runtime/command-dispatch";
import { makeRpcClientSession } from "@zuse/client-runtime/connection";
import {
	type ConnectionSupervisorEntry,
	createConnectionSupervisor,
} from "@zuse/client-runtime/supervisor";
import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	RpcClient,
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
				: wsClientProtocolLayer(options.wsUrl);
		return makeRpcClientSession(protocolLayer, MemoizeRpcs);
	},
});

const commandDispatcher = new CommandDispatcher();
let rendererEntry: ConnectionSupervisorEntry<MemoizeClient> | null = null;
let observedGeneration = 0;

const getRendererEntry = (): ConnectionSupervisorEntry<MemoizeClient> => {
	const entry = supervisor.get(connectionOptions());
	if (rendererEntry === null) {
		rendererEntry = entry;
		entry.subscribe((snapshot) => {
			if (
				snapshot.status === "connected" &&
				observedGeneration > 0 &&
				snapshot.generation > observedGeneration
			) {
				commandDispatcher.redispatchPending();
			}
			observedGeneration = Math.max(observedGeneration, snapshot.generation);
		});
	}
	return entry;
};

const isRpcClientError = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	cause._tag === "RpcClientError";

export const getRpcClient = (): Promise<MemoizeClient> =>
	Effect.runPromise(getRendererEntry().getClient());

export const reportRendererRpcFailure = (cause: unknown): void => {
	getRendererEntry().reportFailure(cause);
};

export const dispatchRetryableRpcCommand = <A>(
	commandId: string,
	operation: () => Promise<A>,
): Promise<A> =>
	commandDispatcher.dispatch(
		commandId,
		async () => {
			try {
				return await operation();
			} catch (cause) {
				if (isRpcClientError(cause)) reportRendererRpcFailure(cause);
				throw cause;
			}
		},
		{ shouldRetry: isRpcClientError },
	);

export const disposeRpcClient = async (): Promise<void> => {
	commandDispatcher.failPending(new Error("renderer RPC runtime disposed"));
	rendererEntry = null;
	observedGeneration = 0;
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
