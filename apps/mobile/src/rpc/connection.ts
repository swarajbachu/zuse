import { RpcClient, RpcGroup } from "@effect/rpc";
import { MemoizeRpcs } from "@zuse/wire";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";

import { ConnectionFailed } from "./errors";
import {
  createConnectionSupervisor,
  type ConnectionSnapshot,
} from "./connection-supervisor";
import { connectEnvironment } from "./relay-client";
import { wsClientProtocolLayer, type WsProtocolOptions } from "./ws-protocol";

type MemoizeClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof MemoizeRpcs>>;

export type { ConnectionSnapshot } from "./connection-supervisor";

const runtimeKey = (options: WsProtocolOptions) =>
  options.key ??
  options.environmentId ??
  `${options.wsBaseUrl ?? `${options.host}:${options.port}`}`;

const makeRuntime = (options: WsProtocolOptions) => {
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

const prepareOptions = async (
  options: WsProtocolOptions
): Promise<WsProtocolOptions> => {
  if (options.environmentId === undefined || options.wsBaseUrl === undefined) {
    return options;
  }
  const grant = await connectEnvironment(options.environmentId);
  return {
    ...options,
    host: new URL(grant.endpoint.wsBaseUrl).hostname,
    port:
      Number(new URL(grant.endpoint.wsBaseUrl).port) ||
      (grant.endpoint.wsBaseUrl.startsWith("wss:") ? 443 : 80),
    wsBaseUrl: grant.endpoint.wsBaseUrl,
    token: grant.connectToken,
  };
};

const supervisor = createConnectionSupervisor({
  keyOf: runtimeKey,
  prepareOptions,
  createClient: async (options) => {
    const runtime = makeRuntime(options);
    return {
      client: await runtime.client,
      dispose: () => runtime.runtime.dispose(),
    };
  },
  isOnline: () => currentOnline,
  schedule: (delayMs, fn) => {
    const timer = setTimeout(fn, delayMs);
    return () => clearTimeout(timer);
  },
});

let currentOnline = true;

export const getConnectionClient = (
  options: WsProtocolOptions
): Effect.Effect<MemoizeClient, ConnectionFailed> =>
  supervisor.get(options).getClient();

export const disposeConnection = (options: WsProtocolOptions): Promise<void> => {
  return supervisor.get(options).remove();
};

export const reportConnectionFailure = (
  options: WsProtocolOptions,
  cause: unknown
): void => {
  supervisor.get(options).reportFailure(cause);
};

export const retryConnectionNow = (options: WsProtocolOptions): void => {
  supervisor.get(options).retryNow();
};

export const subscribeConnection = (
  options: WsProtocolOptions,
  listener: (snapshot: ConnectionSnapshot) => void
): (() => void) => supervisor.get(options).subscribe(listener);

export const setConnectionOnline = (online: boolean): void => {
  currentOnline = online;
  supervisor.setOnline(online);
};

export const getConnectionSnapshot = (
  options: WsProtocolOptions
): ConnectionSnapshot => supervisor.get(options).snapshot();
