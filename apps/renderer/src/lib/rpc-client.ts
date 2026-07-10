import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";
import {
	RpcClient,
	type RpcGroup,
	RpcSerialization,
} from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import { electronClientProtocolLayer } from "./electron-client-protocol.ts";
import { wsClientProtocolLayer } from "./ws-client-protocol.ts";

/**
 * Lazy-initialized renderer-side RPC. The bridge call is deferred so this
 * module is safe to import in non-Electron contexts (Vite HMR, tests).
 *
 * The client itself needs a Scope that outlives any single RPC call — it owns
 * background fibers (response demux, error reconciliation). We hand the
 * client a long-lived scope that lives until the page unloads.
 */
type MemoizeClient = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof MemoizeRpcs>,
	RpcClientError
>;

let runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> | null =
	null;
let cachedClient: Promise<MemoizeClient> | null = null;

function resolveWebSocketUrl() {
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

function getRuntime() {
	if (runtime === null) {
		const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
		const protocolLayer = bridge
			? electronClientProtocolLayer(bridge.rpc).pipe(
					Layer.provide(RpcSerialization.layerJson),
				)
			: wsClientProtocolLayer(resolveWebSocketUrl());
		// Future reconnect policy belongs at this socket/protocol boundary. For
		// now failures surface to stream consumers and stores resume by cursor.
		runtime = ManagedRuntime.make(protocolLayer);
	}
	return runtime;
}

export function getRpcClient(): Promise<MemoizeClient> {
	if (cachedClient === null) {
		const rt = getRuntime();
		const next = rt.runPromise(
			RpcClient.make(MemoizeRpcs).pipe(
				Effect.provideService(Scope.Scope, rt.scope),
			),
		);
		let guarded: Promise<MemoizeClient>;
		guarded = next.catch((err) => {
			if (cachedClient === guarded) {
				cachedClient = null;
				runtime = null;
			}
			throw err;
		});
		cachedClient = guarded;
	}
	return cachedClient;
}
