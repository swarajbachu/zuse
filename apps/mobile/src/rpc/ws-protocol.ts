import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Layer } from "effect";

export type WsProtocolOptions = {
  host: string;
  port: number;
  token?: string | null;
};

export const connectionKey = (host: string, port: number): string =>
  `${host.trim()}:${port}`;

export const wsUrl = ({ host, port }: WsProtocolOptions): string =>
  `ws://${host.trim()}:${port}`;

export const authenticatedWsUrl = ({
  host,
  port,
  token
}: WsProtocolOptions): string => {
  const url = new URL(wsUrl({ host, port }));
  if (token?.trim()) url.searchParams.set("token", token.trim());
  return url.toString();
};

export const wsClientProtocolLayer = (
  options: WsProtocolOptions
): Layer.Layer<RpcClient.Protocol> =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(authenticatedWsUrl(options))),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson)
  );
