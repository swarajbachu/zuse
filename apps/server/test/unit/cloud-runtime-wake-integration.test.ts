import { Deferred, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "vitest";
import {
	CloudRuntimeNetwork,
	CloudRuntimeWake,
} from "../../src/api/cloud-runtime-wake.ts";
import {
	CloudWorkspaceRuntimeError,
	makeCloudMailboxLeaseRequest,
	makeRuntimeCredentialRefresh,
	runCloudMailboxPolling,
	startCloudCodexAuth,
} from "../../src/api/cloud-workspace-runtime.ts";

it("renews an expired bearer once before concurrent gateway/mailbox recovery while retaining the runtime generation", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const events: string[] = [];
			const state = {
				credential: "expired",
				expiresAt: 0,
				generation: 4,
				gatewayEpoch: 2,
			};
			const refresh = yield* makeRuntimeCredentialRefresh({
				state,
				pending: () => false,
				renew: Effect.gen(function* () {
					events.push("renew");
					yield* Effect.yieldNow;
					state.credential = "fresh";
					state.expiresAt = Date.now() + 60_000;
				}),
			});
			yield* Effect.all(
				["gateway", "mailbox"].map((path) =>
					refresh.ensure.pipe(
						Effect.andThen(
							Effect.sync(() => {
								events.push(`${path}:${state.credential}`);
							}),
						),
					),
				),
				{ concurrency: "unbounded" },
			);
			expect(events).toEqual(["renew", "gateway:fresh", "mailbox:fresh"]);
			expect(state.generation).toBe(4);
		}),
	);
});

it("does not renew a valid cached identity unless a rotation receipt is pending", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let pending = false;
			let renewals = 0;
			const refresh = yield* makeRuntimeCredentialRefresh({
				state: {
					credential: "valid",
					expiresAt: Date.now() + 60_000,
					generation: 4,
					gatewayEpoch: 2,
				},
				pending: () => pending,
				renew: Effect.sync(() => {
					renewals++;
					pending = false;
				}),
			});
			yield* refresh.ensure;
			expect(renewals).toBe(0);
			pending = true;
			yield* refresh.ensure;
			expect(renewals).toBe(1);
		}),
	);
});

it("drains immediately at boot and on command notifications, retaining notifications received during a serialized apply", async () => {
	const network = new CloudRuntimeWake();
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const applied = yield* Deferred.make<void>();
				let polls = 0;
				let cancelledApply = false;
				const fiber = yield* runCloudMailboxPolling({
					poll: Effect.suspend(() => {
						polls++;
						return polls === 1
							? Deferred.await(applied).pipe(
									Effect.onInterrupt(() =>
										Effect.sync(() => {
											cancelledApply = true;
										}),
									),
								)
							: Effect.void;
					}),
					onRuntimeRejected: Effect.die("must not reject"),
				}).pipe(Effect.forkScoped({ startImmediately: true }));
				yield* Effect.yieldNow;
				expect(polls).toBe(1);
				network.nudgeMailbox();
				yield* Effect.yieldNow;
				expect(polls).toBe(1);
				expect(cancelledApply).toBe(false);
				yield* Deferred.succeed(applied, undefined);
				yield* TestClock.adjust(Duration.millis(1));
				expect(polls).toBe(2);
				yield* TestClock.adjust("29 seconds");
				expect(polls).toBe(2);
				network.nudgeMailbox();
				yield* TestClock.adjust(Duration.millis(1));
				expect(polls).toBe(3);
				yield* TestClock.adjust("30 seconds");
				expect(polls).toBe(4);
				yield* Fiber.interrupt(fiber);
			}).pipe(
				Effect.scoped,
				Effect.provideService(CloudRuntimeNetwork, network),
				Effect.provide(TestClock.layer()),
			),
		);
	} finally {
		await network.close();
	}
});

it("starts external provider auth concurrently with workspace setup and awaits it only for dependent recovery", async () => {
	let ready!: () => void;
	const initialization = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let recovered = false;
	let closed = false;
	await Effect.runPromise(
		Effect.gen(function* () {
			const done = yield* Deferred.make<void>();
			yield* startCloudCodexAuth(
				"workspace-1",
				{
					initialize: () => initialization,
					close: () => {
						closed = true;
					},
					getTokens: async () => ({
						accessToken: "test",
						chatgptAccountId: "account",
						chatgptPlanType: null,
						expiresAt: Date.now() + 60_000,
					}),
					onDeliveryFailure: () => {},
				},
				Effect.sync(() => {
					recovered = true;
				}).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
			);
			expect(recovered).toBe(false);
			ready();
			yield* Deferred.await(done);
			expect(recovered).toBe(true);
		}).pipe(Effect.scoped),
	);
	expect(closed).toBe(true);
});

it("reauthorizes after each mailbox notification without a polling delay and preserves the cursor across later cycles", async () => {
	const calls: number[] = [];
	let checks = 0;
	const lease = makeCloudMailboxLeaseRequest({
		ensureCredential: Effect.sync(() => {
			checks++;
		}),
		request: (cursor) =>
			Effect.sync(() => {
				calls.push(cursor);
				return calls.length === 1
					? { leases: [], waited: true, mailboxRevision: 9 }
					: { leases: [], mailboxRevision: 10 };
			}),
	});
	await Effect.runPromise(lease);
	expect(calls).toEqual([0, 9]);
	expect(checks).toBe(2);
	await Effect.runPromise(lease);
	expect(calls).toEqual([0, 9, 10]);
});

it("does not turn a wake notification into command authority when fresh authorization is fenced", async () => {
	let requests = 0;
	const failure = new CloudWorkspaceRuntimeError({
		reason: "workspace_runtime_fenced",
		httpStatus: 401,
	});
	const outcome = await Effect.runPromise(
		makeCloudMailboxLeaseRequest({
			ensureCredential: Effect.void,
			request: () =>
				Effect.suspend(() => {
					requests++;
					return requests === 1
						? Effect.succeed({ leases: [], waited: true, mailboxRevision: 1 })
						: Effect.fail(failure);
				}),
		}).pipe(Effect.result),
	);
	expect(outcome).toMatchObject({ _tag: "Failure", failure });
	expect(requests).toBe(2);
});
