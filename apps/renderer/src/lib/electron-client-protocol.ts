import { type Cause, Effect, Layer, Queue, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import {
	RpcClientDefect,
	RpcClientError,
} from "effect/unstable/rpc/RpcClientError";
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
		Effect.fnUntraced(function* (writeResponse, clientIds) {
			const serialization = yield* RpcSerialization.RpcSerialization;
			const parser = serialization.makeUnsafe();
			const requestClientMap = new Map<string | number, number>();

			const broadcast = (response: FromServerEncoded) =>
				Effect.forEach(clientIds, (clientId) =>
					writeResponse(clientId, response),
				);

			const inbound = yield* Queue.make<unknown, Cause.Done>();
			const unsubscribe = bridge.onMessage((frame) => {
				Queue.offerUnsafe(inbound, frame);
			});
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					unsubscribe();
					Queue.endUnsafe(inbound);
				}),
			);

			yield* Stream.fromQueue(inbound).pipe(
				Stream.runForEach((frame) =>
					Effect.suspend(() => {
						const decoded = parser.decode(frame as Uint8Array | string);
						if (decoded.length === 0) return Effect.void;
						let i = 0;
						return Effect.whileLoop({
							while: () => i < decoded.length,
							body: () => {
								const response = decoded[i++] as FromServerEncoded;
								if ("requestId" in response) {
									const clientId = requestClientMap.get(response.requestId);
									if (clientId !== undefined) {
										if (response._tag === "Exit") {
											requestClientMap.delete(response.requestId);
										}
										return writeResponse(clientId, response);
									}
								}
								return broadcast(response);
							},
							step: () => undefined,
						});
					}),
				),
				Effect.forkScoped,
				Effect.interruptible,
			);

			return {
				send: (clientId, request) =>
					Effect.try({
						try: () => {
							if (request._tag === "Request") {
								requestClientMap.set(request.id, clientId);
							} else if (request._tag === "Interrupt") {
								requestClientMap.delete(request.requestId);
							}
							const encoded = parser.encode(request);
							if (encoded === undefined) return;
							bridge.send(encoded);
						},
						catch: (cause) =>
							new RpcClientError({
								reason: new RpcClientDefect({
									message: "Failed to send RPC frame over Electron IPC",
									cause,
								}),
							}),
					}),
				supportsAck: true,
				supportsTransferables: false,
			};
		}),
	);

export const electronClientProtocolLayer = (bridge: RpcBridge) =>
	Layer.effect(RpcClient.Protocol, makeElectronClientProtocol(bridge));
