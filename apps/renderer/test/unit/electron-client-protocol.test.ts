import { Deferred, Effect } from "effect";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import { describe, expect, it } from "vitest";

import { makeElectronResponseRouter } from "../../src/lib/electron-client-protocol.ts";

const chunk = (requestId: string, value = "output"): FromServerEncoded => ({
	_tag: "Chunk",
	requestId,
	values: [value],
});

const exit = (requestId: string): FromServerEncoded => ({
	_tag: "Exit",
	requestId,
	exit: { _tag: "Success", value: undefined },
});

describe("Electron RPC response routing", () => {
	it("lets an unrelated command receipt bypass a backpressured stream", async () => {
		const seen: string[] = [];

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const outputStarted = yield* Deferred.make<void>();
					const releaseOutput = yield* Deferred.make<void>();
					const commandDelivered = yield* Deferred.make<void>();
					const outputExitDelivered = yield* Deferred.make<void>();
					const router = yield* makeElectronResponseRouter(
						(_clientId, response) => {
							if (!("requestId" in response)) return Effect.void;
							return Effect.gen(function* () {
								seen.push(
									response._tag === "Chunk"
										? `${response.requestId}:${response._tag}:${response.values[0]}`
										: `${response.requestId}:${response._tag}`,
								);
								if (response._tag === "Chunk") {
									yield* Deferred.succeed(outputStarted, undefined);
									yield* Deferred.await(releaseOutput);
									return;
								}
								if (response.requestId === "command") {
									yield* Deferred.succeed(commandDelivered, undefined);
								} else {
									yield* Deferred.succeed(outputExitDelivered, undefined);
								}
							});
						},
					);

					yield* router.route(0, chunk("output", "first"));
					yield* Deferred.await(outputStarted);
					yield* router.route(0, chunk("output", "second"));
					yield* router.route(0, exit("output"));
					yield* router.route(0, exit("command"));
					yield* Deferred.await(commandDelivered);

					expect(seen).toEqual(["output:Chunk:first", "command:Exit"]);

					yield* Deferred.succeed(releaseOutput, undefined);
					yield* Deferred.await(outputExitDelivered);
					expect(seen).toEqual([
						"output:Chunk:first",
						"command:Exit",
						"output:Chunk:second",
						"output:Exit",
					]);
				}),
			),
		);
	});

	it("keeps a literal broadcast request id separate from broadcast frames", async () => {
		const seen: string[] = [];

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const requestStarted = yield* Deferred.make<void>();
					const releaseRequest = yield* Deferred.make<void>();
					const broadcastDelivered = yield* Deferred.make<void>();
					const router = yield* makeElectronResponseRouter(
						(_clientId, response) =>
							Effect.gen(function* () {
								if ("requestId" in response) {
									seen.push(`request:${response.requestId}`);
									yield* Deferred.succeed(requestStarted, undefined);
									yield* Deferred.await(releaseRequest);
									return;
								}
								seen.push("broadcast");
								yield* Deferred.succeed(broadcastDelivered, undefined);
							}),
					);

					yield* router.route(0, chunk("broadcast"));
					yield* Deferred.await(requestStarted);
					yield* router.route(0, { _tag: "Pong" });
					yield* Deferred.await(broadcastDelivered);

					expect(seen).toEqual(["request:broadcast", "broadcast"]);
					yield* Deferred.succeed(releaseRequest, undefined);
				}),
			),
		);
	});
});
