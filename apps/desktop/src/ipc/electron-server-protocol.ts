import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { FromClientEncoded } from "effect/unstable/rpc/RpcMessage";
import { ipcMain, type WebContents } from "electron";
import { Effect, Exit, Layer, Mailbox, Stream } from "effect";

import { IPC_CHANNEL } from "@zuse/contracts";

/**
 * RpcServer.Protocol implementation for Electron IPC. Modeled on
 * `RpcServer.makeProtocolStdio` in `effect/unstable/rpc`: read incoming frames from a
 * source, decode via the configured serialization, hand each decoded message
 * to `writeRequest`. For sending, encode + push out via webContents.
 *
 * v1 is single-window: the protocol owns one webContents and uses clientId 0.
 * Multi-window in a later phase becomes "register the protocol per webContents
 * with a stable clientId per window."
 */
const SINGLE_WINDOW_CLIENT_ID = 0;

export const makeElectronServerProtocol = (webContents: WebContents) =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const parser = serialization.unsafeMake();
      const disconnects = yield* Mailbox.make<number>();

      // ---- inbound: ipcMain → writeRequest --------------------------------
      // The renderer pushes encoded RPC frames on IPC_CHANNEL. We can't run
      // Effects from a synchronous ipc handler, so we shovel into a Mailbox
      // and consume that as a Stream.
      const inbound = yield* Mailbox.make<unknown>();
      const handler = (event: Electron.IpcMainEvent, frame: unknown) => {
        if (event.sender.id !== webContents.id) return;
        inbound.unsafeOffer(frame);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => ipcMain.on(IPC_CHANNEL, handler)),
        () => Effect.sync(() => ipcMain.off(IPC_CHANNEL, handler)),
      );

      yield* Mailbox.toStream(inbound).pipe(
        Stream.runForEach((frame) =>
          Effect.suspend(() => {
            const decoded = parser.decode(frame as Uint8Array | string);
            if (decoded.length === 0) return Effect.void;
            let i = 0;
            return Effect.whileLoop({
              while: () => i < decoded.length,
              body: () =>
                writeRequest(
                  SINGLE_WINDOW_CLIENT_ID,
                  decoded[i++] as FromClientEncoded,
                ),
              step: () => undefined,
            });
          }),
        ),
        Effect.forkScoped,
        Effect.interruptible,
      );

      // ---- disconnects: webContents destroyed OR top-level reload ---------
      // The renderer's `RpcClient` request-id counter is module-level, so a
      // Cmd+R reload restarts it at 0. Any stream RPC from the previous page
      // (messages.stream, session.streamStatus, ...) is still alive in this
      // server's per-client fiber map because `webContents.destroyed` never
      // fired. When the new page's request IDs collide with those stale
      // streams, `RpcServer.handleRequest` blocks on `Fiber.await(oldFiber)`
      // and the new request hangs forever — sessions, file tree, etc. get
      // stuck in loading state after every reload.
      //
      // Offering `SINGLE_WINDOW_CLIENT_ID` to `disconnects` makes the
      // RpcServer interrupt every fiber for client 0 and drop the client
      // entry; the reloaded renderer's next request creates a fresh client.
      // `did-start-loading` fires for top-level loads (reload,
      // `location.href = ...`) but NOT for devtools, subframes, or
      // pushState/replaceState — exactly the "the renderer is throwing
      // away its world" signal we want. On the very first load there is
      // no client 0 yet, so the disconnect is a no-op.
      const offerDisconnect = () => {
        disconnects.unsafeOffer(SINGLE_WINDOW_CLIENT_ID);
      };
      const onDestroyed = () => {
        offerDisconnect();
        inbound.unsafeDone(Exit.void);
      };
      const onStartLoading = () => {
        offerDisconnect();
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          webContents.once("destroyed", onDestroyed);
          webContents.on("did-start-loading", onStartLoading);
        }),
        () =>
          Effect.sync(() => {
            if (!webContents.isDestroyed()) {
              webContents.off("destroyed", onDestroyed);
              webContents.off("did-start-loading", onStartLoading);
            }
          }),
      );

      return {
        disconnects,
        send: (_clientId, response) =>
          Effect.sync(() => {
            const encoded = parser.encode(response);
            if (encoded === undefined) return;
            if (webContents.isDestroyed()) return;
            webContents.send(IPC_CHANNEL, encoded);
          }),
        end: (_clientId) => Effect.void,
        clientIds: Effect.succeed(new Set([SINGLE_WINDOW_CLIENT_ID])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      };
    }),
  );

/**
 * Build a Layer providing `RpcServer.Protocol` bound to a specific webContents.
 * Compose with `RpcSerialization.layerJson` and the RpcServer + handlers.
 */
export const electronServerProtocolLayer = (webContents: WebContents) =>
  Layer.effect(RpcServer.Protocol, makeElectronServerProtocol(webContents));
