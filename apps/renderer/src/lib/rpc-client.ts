import { RpcClient, RpcGroup, RpcSerialization } from "@effect/rpc";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";

import { MemoizeRpcs } from "@zuse/wire";

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
type MemoizeClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof MemoizeRpcs>>;

let runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> | null = null;
let cachedClient: Promise<MemoizeClient> | null = null;

function resolveWebSocketUrl() {
  return (
    import.meta.env.VITE_ZUSE_WS_URL?.trim() || `ws://${location.host}/rpc`
  );
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
    cachedClient = rt.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        return yield* RpcClient.make(MemoizeRpcs).pipe(Scope.extend(scope));
      }),
    );
  }
  return cachedClient;
}
