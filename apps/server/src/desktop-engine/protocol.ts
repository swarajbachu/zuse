import { type Cause, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { FromClientEncoded } from "effect/unstable/rpc/RpcMessage";
import { ConnectionIdentity } from "../lan-auth/services/connection-identity.ts";
import type { EngineChannel } from "./channel.ts";
import type { EngineHost } from "./host.ts";
import { listenLocalEngine } from "./listener.ts";

/** Desktop attachment is a transport scope; provider execution belongs to the enclosing runtime. */
export const localEngineProtocolLayer = (options: {
	readonly token: string;
	readonly host: EngineHost;
	readonly onListening: (port: number) => Promise<void>;
	readonly prepareShutdown?: () => Promise<boolean>;
	readonly shutdown?: () => void;
}) =>
	Layer.effect(
		RpcServer.Protocol,
		RpcServer.Protocol.make(
			Effect.fnUntraced(function* (writeRequest) {
				const serialization = yield* RpcSerialization.RpcSerialization;
				const disconnects = yield* Queue.make<number>();
				const clients = new Map<number, EngineChannel>();
				const closingWorkers = new Set<Promise<void>>();
				const outgoing = serialization.makeUnsafe();
				const workers = new Map<
					number,
					{
						queue: Queue.Queue<string, Cause.Done>;
						fiber: Fiber.Fiber<void, never>;
						pendingBytes: number;
					}
				>();
				const listener = yield* Effect.acquireRelease(
					Effect.tryPromise(() =>
						listenLocalEngine({
							...options,
							clients,
							onRpc: (clientId, payload) => {
								let worker = workers.get(clientId);
								if (worker === undefined) {
									const parser = serialization.makeUnsafe();
									const queue = Effect.runSync(
										Queue.make<string, Cause.Done>({ capacity: 128 }),
									);
									const fiber = Effect.runFork(
										Stream.fromQueue(queue).pipe(
											Stream.runForEach((value) =>
												Effect.gen(function* () {
													const current = workers.get(clientId);
													if (current !== undefined)
														current.pendingBytes -= Buffer.byteLength(value);
													if (!clients.has(clientId)) return;
													const decoded = yield* Effect.try(() =>
														parser.decode(value),
													);
													for (const request of decoded)
														yield* writeRequest(
															clientId,
															request as FromClientEncoded,
														).pipe(
															Effect.provideService(ConnectionIdentity, {
																kind: "local",
															}),
														);
												}),
											),
											Effect.catchCause(() =>
												Effect.sync(() => clients.get(clientId)?.close()),
											),
										),
									);
									worker = { queue, fiber, pendingBytes: 0 };
									workers.set(clientId, worker);
								}
								const bytes = Buffer.byteLength(payload);
								if (
									worker.pendingBytes + bytes > 64 * 1024 * 1024 ||
									!Queue.offerUnsafe(worker.queue, payload)
								)
									return false;
								worker.pendingBytes += bytes;
								return true;
							},
							onDisconnect: (clientId) => {
								Queue.offerUnsafe(disconnects, clientId);
								const worker = workers.get(clientId);
								workers.delete(clientId);
								if (worker !== undefined) {
									Queue.endUnsafe(worker.queue);
									const closing = Effect.runPromise(
										Fiber.interrupt(worker.fiber),
									);
									closingWorkers.add(closing);
									void closing.finally(() => closingWorkers.delete(closing));
								}
							},
						}),
					).pipe(Effect.orDie),
					(listener) =>
						Effect.promise(async () => {
							await listener.close();
							await Promise.all(
								[...workers.values()].map((worker) =>
									Effect.runPromise(Fiber.interrupt(worker.fiber)),
								),
							);
							workers.clear();
							await Promise.all(closingWorkers);
						}),
				);
				yield* Effect.promise(() => options.onListening(listener.port));
				return {
					disconnects,
					send: (clientId, response) =>
						Effect.sync(() => {
							const encoded = outgoing.encode(response);
							if (encoded !== undefined)
								clients.get(clientId)?.send({
									_tag: "Rpc",
									payload:
										typeof encoded === "string"
											? encoded
											: Buffer.from(encoded).toString("utf8"),
								});
						}),
					end: (clientId) => Effect.sync(() => clients.get(clientId)?.close()),
					clientIds: Effect.sync(() => new Set(clients.keys())),
					initialMessage: Effect.succeedNone,
					supportsAck: true,
					supportsTransferables: false,
					supportsSpanPropagation: false,
				};
			}),
		),
	).pipe(Layer.provide(RpcSerialization.layerJson));
