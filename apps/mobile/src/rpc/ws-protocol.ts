import { withWireProtocolVersion } from "@zuse/client-runtime/connection";
import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Socket } from "effect/unstable/socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Layer } from "effect";

export type WsProtocolOptions = {
  /** Stable saved-connection key. Manual records use host:port; relay records use environmentId. */
  key?: string;
  /** Relay-linked environments refresh their connect token before reconnecting. */
  environmentId?: string;
  host: string;
  port: number;
  token?: string | null;
  /**
   * A full ws(s):// base URL, used for relay-connected environments reached via
   * a managed tunnel (e.g. `wss://env-x.relay.example`). When present it
   * takes precedence over host/port.
   */
  wsBaseUrl?: string | null;
};

export const connectionKey = (host: string, port: number): string =>
  `${host.trim()}:${port}`;

export const wsUrl = ({ host, port }: WsProtocolOptions): string =>
  `ws://${host.trim()}:${port}`;

export const authenticatedWsUrl = (options: WsProtocolOptions): string => {
  const base = options.wsBaseUrl?.trim();
  const url = new URL(base && base.length > 0 ? base : wsUrl(options));
  if (options.token?.trim())
    url.searchParams.set("token", options.token.trim());
  return withWireProtocolVersion(url.toString(), WIRE_PROTOCOL_VERSION);
};

export const wsClientProtocolLayer = (
  options: WsProtocolOptions,
): Layer.Layer<RpcClient.Protocol> =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(authenticatedWsUrl(options))),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  );
