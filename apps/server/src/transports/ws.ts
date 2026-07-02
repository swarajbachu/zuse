import { NodeSocketServer } from "@effect/platform-node";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Layer } from "effect";

/**
 * `RpcServer.Protocol` over a WebSocket — the headless counterpart to
 * `electronServerProtocolLayer`. Unlike the Electron transport we don't
 * hand-roll the protocol: `@effect/rpc`'s socket-server protocol does the
 * framing, assigns each connection a distinct `clientId`, and fires the
 * disconnect on socket close — so the per-client fiber cleanup the Electron
 * code fakes (the `did-start-loading` / `destroyed` dance) is automatic here.
 *
 * Same JSON framing as the Electron path (`RpcSerialization.layerJson`) so the
 * wire contract is byte-identical across transports. A bind failure (port in
 * use, bad host) is unrecoverable for a server whose only job is to listen, so
 * we `Layer.orDie` it: the resulting `Layer<RpcServer.Protocol>` has no error
 * channel and slots straight into `MainLayerDeps.serverProtocol`.
 */
export const wsServerProtocolLayer = (opts: {
  readonly port: number;
  readonly host?: string;
}): Layer.Layer<RpcServer.Protocol> =>
  RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(
      NodeSocketServer.layerWebSocket({
        port: opts.port,
        host: opts.host ?? "127.0.0.1",
      }),
    ),
    Layer.provide(RpcSerialization.layerJson),
    Layer.orDie,
  );
