import { RpcClient, RpcGroup } from "@effect/rpc";
import { MemoizeRpcs } from "@zuse/wire";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";

import { ConnectionFailed } from "./errors";
import { wsClientProtocolLayer, type WsProtocolOptions } from "./ws-protocol";

type MemoizeClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof MemoizeRpcs>>;

type RuntimeEntry = {
  runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  client: Promise<MemoizeClient>;
};

const runtimes = new Map<string, RuntimeEntry>();

const runtimeKey = (options: WsProtocolOptions) =>
  `${options.wsBaseUrl ?? `${options.host}:${options.port}`}:${options.token ?? ""}`;

const makeEntry = (options: WsProtocolOptions): RuntimeEntry => {
  const protocolLayer = wsClientProtocolLayer(options).pipe(Layer.orDie);
  const runtime = ManagedRuntime.make(protocolLayer);
  const client = runtime.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* RpcClient.make(MemoizeRpcs).pipe(Scope.extend(scope));
    })
  );
  return { runtime, client };
};

export const getConnectionClient = (
  options: WsProtocolOptions
): Effect.Effect<MemoizeClient, ConnectionFailed> =>
  Effect.tryPromise({
    try: async () => {
      const key = runtimeKey(options);
      const entry = runtimes.get(key) ?? makeEntry(options);
      runtimes.set(key, entry);
      return await entry.client;
    },
    catch: (cause) =>
      new ConnectionFailed({
        message: cause instanceof Error ? cause.message : String(cause)
      })
  });

export const disposeConnection = (options: WsProtocolOptions): Promise<void> => {
  const key = runtimeKey(options);
  const entry = runtimes.get(key);
  runtimes.delete(key);
  return entry?.runtime.dispose() ?? Promise.resolve();
};

// TODO(Track C): re-key runtime entries by connect.describe environmentId once
// the connect.* RPCs are registered in MemoizeRpcs and pairing is available.
