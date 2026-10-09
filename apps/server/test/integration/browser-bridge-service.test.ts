import { BrowserCommandResult, type SessionId } from "@zuse/contracts";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { BrowserBridgeServiceLive } from "../../src/provider/layers/browser-bridge-service.ts";
import { BrowserBridgeService } from "../../src/provider/services/browser-bridge-service.ts";

const TestLayer = BrowserBridgeServiceLive;

describe("BrowserBridgeService", () => {
	it("fails immediately when no browser renderer is connected", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const bridge = yield* BrowserBridgeService;
				const startedAt = Date.now();
				const result = yield* bridge.send(
					"session-browser-bridge" as SessionId,
					{ _tag: "Status" },
				);

				expect(result).toMatchObject({
					ok: false,
					error: expect.stringContaining("unavailable"),
				});
				expect(Date.now() - startedAt).toBeLessThan(500);
				expect(yield* bridge.diagnostics).toMatchObject({
					connectedRendererCount: 0,
					pendingCommandCount: 0,
					unavailableCount: 1,
				});
			}).pipe(Effect.provide(TestLayer)),
		);
	});

	it("tracks connected renderers, pending commands, and completed responses", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bridge = yield* BrowserBridgeService;
					const sessionId = "session-browser-bridge" as SessionId;
					const events = bridge.commands();
					yield* Stream.runForEach(events, (request) =>
						bridge.respond(
							BrowserCommandResult.make({
								id: request.id,
								ok: true,
								detail: "loaded",
								channel: request.channel,
							}),
						),
					).pipe(Effect.forkScoped);

					yield* Effect.sleep("10 millis");
					expect(yield* bridge.diagnostics).toMatchObject({
						connectedRendererCount: 1,
						pendingCommandCount: 0,
					});

					const result = yield* bridge.send(sessionId, {
						_tag: "Navigate",
						url: "http://localhost:3000",
					});
					expect(result.ok).toBe(true);

					expect(yield* bridge.diagnostics).toMatchObject({
						connectedRendererCount: 1,
						pendingCommandCount: 0,
						issuedCommandCount: 1,
						timeoutCount: 0,
						overloadCount: 0,
					});
				}),
			).pipe(Effect.provide(TestLayer)),
		);
	});

	it("preserves a command across a brief renderer reconnect", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bridge = yield* BrowserBridgeService;
					const sessionId = "session-browser-reconnect" as SessionId;
					const firstRequest = yield* Deferred.make<string>();
					const first = yield* Stream.runForEach(bridge.commands(), (request) =>
						Deferred.succeed(firstRequest, request.id).pipe(
							Effect.andThen(Effect.never),
						),
					).pipe(Effect.forkScoped);
					yield* Effect.sleep("10 millis");
					const sending = yield* bridge
						.send(sessionId, { _tag: "Status" })
						.pipe(Effect.forkScoped);
					yield* Deferred.await(firstRequest);
					yield* Fiber.interrupt(first);
					yield* Stream.runForEach(bridge.commands(), (request) =>
						bridge.respond(
							BrowserCommandResult.make({
								id: request.id,
								ok: true,
								detail: "reconnected",
								channel: request.channel,
							}),
						),
					).pipe(Effect.forkScoped);

					expect((yield* Fiber.join(sending)).ok).toBe(true);
					expect(yield* bridge.diagnostics).toMatchObject({
						disconnectCount: 1,
						unavailableCount: 0,
						pendingCommandCount: 0,
					});
				}),
			).pipe(Effect.provide(TestLayer)),
		);
	});

	it("rejects responses that do not echo the owning subscriber's channel", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bridge = yield* BrowserBridgeService;
					const sessionId = "session-channel-pin" as SessionId;
					const seen = yield* Deferred.make<{
						readonly id: string;
						readonly channel: string | undefined;
					}>();
					yield* Stream.runForEach(bridge.commands(), (request) =>
						Deferred.succeed(seen, {
							id: request.id,
							channel: request.channel,
						}),
					).pipe(Effect.forkScoped);
					yield* Effect.sleep("10 millis");

					const sending = yield* bridge
						.send(sessionId, { _tag: "Status" })
						.pipe(Effect.forkScoped);
					const request = yield* Deferred.await(seen);
					expect(request.channel).toBeDefined();

					// A respond with no channel — or a foreign channel — must not
					// resolve the pending command.
					for (const channel of [undefined, "bch_forged"]) {
						const error = yield* bridge
							.respond(
								BrowserCommandResult.make({
									id: request.id,
									ok: true,
									...(channel === undefined ? {} : { channel }),
								}),
							)
							.pipe(Effect.flip);
						expect(error._tag).toBe("BrowserCommandNotFoundError");
					}

					// The owning subscriber's echo still resolves it.
					yield* bridge.respond(
						BrowserCommandResult.make({
							id: request.id,
							ok: true,
							detail: "ok",
							channel: request.channel,
						}),
					);
					expect((yield* Fiber.join(sending)).ok).toBe(true);
				}),
			).pipe(Effect.provide(TestLayer)),
		);
	});

	it("counts stale renderer responses without leaking command details", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bridge = yield* BrowserBridgeService;
					const error = yield* bridge
						.respond(
							BrowserCommandResult.make({
								id: "missing-command",
								ok: false,
								error: "stale",
							}),
						)
						.pipe(Effect.flip);

					expect(error._tag).toBe("BrowserCommandNotFoundError");
					expect(yield* bridge.diagnostics).toMatchObject({
						pendingCommandCount: 0,
						missingResponseCount: 1,
					});
				}),
			).pipe(Effect.provide(TestLayer)),
		);
	});
});
