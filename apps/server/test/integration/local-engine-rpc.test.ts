import { randomBytes } from "node:crypto";
import {
	Deferred,
	Effect,
	Layer,
	ManagedRuntime,
	Schema,
	Stream,
} from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/unstable/rpc";
import { expect, it } from "vitest";
import type { EngineFrame } from "../../src/desktop-engine/channel.ts";
import { connectLocalEngine } from "../../src/desktop-engine/client.ts";
import { EngineHost } from "../../src/desktop-engine/host.ts";
import { localEngineProtocolLayer } from "../../src/desktop-engine/protocol.ts";
import { ConnectionIdentity } from "../../src/lan-auth/services/connection-identity.ts";

it("reattaches with reused RPC ids while engine-owned work continues", async () => {
	const token = randomBytes(32).toString("hex");
	let port = 0,
		completedWork = 0,
		subscriptions = 0;
	const barrier = Effect.runSync(Deferred.make<void>());
	const Rpcs = RpcGroup.make(
		Rpc.make("read", { payload: Schema.Struct({}), success: Schema.Number }),
		Rpc.make("watch", {
			payload: Schema.Struct({}),
			success: Schema.Number,
			stream: true,
		}),
	);
	const handlers = Rpcs.toLayer({
		read: () =>
			Effect.gen(function* () {
				const identity = yield* Effect.serviceOption(ConnectionIdentity);
				expect(identity).toMatchObject({
					_tag: "Some",
					value: { kind: "local" },
				});
				return completedWork;
			}),
		watch: () =>
			Stream.fromEffect(
				Effect.acquireRelease(
					Effect.sync(() => {
						subscriptions++;
						return 1;
					}),
					() =>
						Effect.sync(() => {
							subscriptions--;
						}),
				),
			).pipe(Stream.concat(Stream.never)),
	});
	const engine = Layer.effectDiscard(
		Deferred.await(barrier).pipe(
			Effect.andThen(
				Effect.sync(() => {
					completedWork++;
				}),
			),
			Effect.forkScoped,
		),
	);
	const runtime = ManagedRuntime.make(
		Layer.merge(
			engine,
			RpcServer.layer(Rpcs).pipe(
				Layer.provide(handlers),
				Layer.provide(
					localEngineProtocolLayer({
						token,
						host: new EngineHost(),
						onListening: async (value) => {
							port = value;
						},
					}),
				),
			),
		),
	);
	try {
		await runtime.runPromise(Effect.void);
		const firstFrames: EngineFrame[] = [];
		const first = await connectLocalEngine(
			{ version: 1, port, token },
			{
				receive: (frame) => {
					firstFrames.push(frame);
				},
			},
		);
		first.send({
			_tag: "Rpc",
			payload: JSON.stringify({
				_tag: "Request",
				id: "0",
				tag: "watch",
				payload: {},
				headers: [],
			}),
		});
		await expect.poll(() => subscriptions).toBe(1);
		first.close();
		await first.closed;
		await expect.poll(() => subscriptions).toBe(0);
		await runtime.runPromise(Deferred.succeed(barrier, undefined));
		await expect.poll(() => completedWork).toBe(1);
		const secondFrames: EngineFrame[] = [];
		const second = await connectLocalEngine(
			{ version: 1, port, token },
			{
				receive: (frame) => {
					secondFrames.push(frame);
				},
			},
		);
		second.send({
			_tag: "Rpc",
			payload: JSON.stringify({
				_tag: "Request",
				id: "0",
				tag: "read",
				payload: {},
				headers: [],
			}),
		});
		await expect
			.poll(() =>
				secondFrames
					.filter((frame) => frame._tag === "Rpc")
					.map((frame) => JSON.parse(frame.payload)),
			)
			.toContainEqual({
				_tag: "Exit",
				requestId: "0",
				exit: { _tag: "Success", value: 1 },
			});
		second.close();
		await second.closed;
	} finally {
		await runtime.dispose();
	}
});
