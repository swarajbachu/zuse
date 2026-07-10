import { Effect, Exit, Layer, Mailbox, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

import type { RpcBridge } from "./bridge.ts";

/**
 * RpcClient.Protocol implementation for Electron IPC. Mirror of the server
 * protocol — sends encoded request frames over the preload bridge, listens
 * for response frames coming back, hands each decoded response to
 * `writeResponse` so the framework can route it to the awaiting RPC.
 */
export const makeElectronClientProtocol = (bridge: RpcBridge) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const parser = serialization.makeUnsafe();

      const inbound = yield* Mailbox.make<unknown>();
      const unsubscribe = bridge.onMessage((frame) => {
        inbound.unsafeOffer(frame);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          inbound.unsafeDone(Exit.void);
        }),
      );

      yield* Mailbox.toStream(inbound).pipe(
        Stream.runForEach((frame) =>
          Effect.suspend(() => {
            const decoded = parser.decode(frame as Uint8Array | string);
            if (decoded.length === 0) return Effect.void;
            let i = 0;
            return Effect.whileLoop({
              while: () => i < decoded.length,
              body: () => writeResponse(decoded[i++] as FromServerEncoded),
              step: () => undefined,
            });
          }),
        ),
        Effect.forkScoped,
        Effect.interruptible,
      );

      return {
        send: (request) =>
          Effect.try({
            try: () => {
              const encoded = parser.encode(request);
              if (encoded === undefined) return;
              bridge.send(encoded);
            },
            catch: (cause) =>
              new RpcClientError({
                reason: "Protocol",
                message: "Failed to send RPC frame over Electron IPC",
                cause,
              }),
          }),
        supportsAck: true,
        supportsTransferables: false,
      };
    }),
  );

export const electronClientProtocolLayer = (bridge: RpcBridge) =>
  Layer.effect(RpcClient.Protocol, makeElectronClientProtocol(bridge));
