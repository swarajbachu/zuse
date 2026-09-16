import { PtyId, PtyOpenToken, PtyOwnerId } from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node-pty", () => ({ spawn: spawnMock }));

import {
	PTY_EXITED_RETENTION_PER_OWNER,
	PtyServiceLive,
} from "../../src/pty/layers/pty-service.ts";
import { PtyService } from "../../src/pty/services/pty-service.ts";

type ExitPayload = { readonly exitCode: number; readonly signal: number };
type ImmediateChildEvents = Readonly<{
	data?: string;
	exit?: ExitPayload;
}>;

const owner = (value: string): PtyOwnerId => PtyOwnerId.make(value);

function makeFakePty(immediate: ImmediateChildEvents = {}) {
	let dataListener: (data: string) => void = () => undefined;
	let exitListener: (event: ExitPayload) => void = () => undefined;
	return {
		process: "zsh",
		pid: 123,
		cols: 80,
		rows: 24,
		onData(listener: (data: string) => void) {
			dataListener = listener;
			if (immediate.data !== undefined) listener(immediate.data);
			return { dispose: () => undefined };
		},
		onExit(listener: (event: ExitPayload) => void) {
			exitListener = listener;
			if (immediate.exit !== undefined) listener(immediate.exit);
			return { dispose: () => undefined };
		},
		write: vi.fn(),
		resize: vi.fn(),
		clear: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		kill: vi.fn(),
		emitData(data: string) {
			dataListener(data);
		},
		emitExit(exitCode: number, signal = 0) {
			exitListener({ exitCode, signal });
		},
	};
}

describe("PtyService", () => {
	let fakePty: ReturnType<typeof makeFakePty>;
	let spawnedPtys: Array<ReturnType<typeof makeFakePty>>;

	beforeEach(() => {
		spawnedPtys = [];
		spawnMock.mockReset();
		spawnMock.mockImplementation(() => {
			fakePty = makeFakePty();
			spawnedPtys.push(fakePty);
			return fakePty;
		});
	});

	it("hands a subscriber gap-free output after the previous cursor", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId, processEpoch } = yield* service.open("/tmp", 80, 24);
					fakePty.emitData("first");

					const first = yield* service
						.subscribe(ptyId)
						.pipe(Stream.take(1), Stream.runCollect);
					expect([...first]).toEqual([
						{
							_tag: "data",
							processEpoch,
							sequence: 1,
							bytes: "first",
						},
					]);

					fakePty.emitData("second");
					const resumed = yield* service
						.subscribe(ptyId, 1)
						.pipe(Stream.take(1), Stream.runCollect);
					expect([...resumed]).toEqual([
						{
							_tag: "data",
							processEpoch,
							sequence: 2,
							bytes: "second",
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("orders live output emitted during replay handoff", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId, processEpoch } = yield* service.open("/tmp", 80, 24);
					fakePty.emitData("replayed");
					let emittedLive = false;

					const events = yield* service.subscribe(ptyId).pipe(
						Stream.tap((event) =>
							Effect.sync(() => {
								if (!emittedLive && event._tag === "data") {
									emittedLive = true;
									fakePty.emitData("live");
								}
							}),
						),
						Stream.take(3),
						Stream.runCollect,
					);

					expect([...events]).toEqual([
						{
							_tag: "data",
							processEpoch,
							sequence: 1,
							bytes: "replayed",
						},
						{ _tag: "cursor", processEpoch, sequence: 1 },
						{
							_tag: "data",
							processEpoch,
							sequence: 2,
							bytes: "live",
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("replays a clean exit to a late subscriber and then completes", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId, processEpoch } = yield* service.open("/tmp", 80, 24);
					fakePty.emitData("done");
					fakePty.emitExit(0);

					const events = yield* Stream.runCollect(service.subscribe(ptyId));
					expect([...events]).toEqual([
						{
							_tag: "data",
							processEpoch,
							sequence: 1,
							bytes: "done",
						},
						{
							_tag: "exit",
							processEpoch,
							sequence: 2,
							exitCode: 0,
							signal: 0,
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("captures a fast child's initial output and exit during open wiring", async () => {
		const fastChild = makeFakePty({
			data: "fast-open",
			exit: { exitCode: 0, signal: 0 },
		});
		spawnMock.mockImplementationOnce(() => {
			fakePty = fastChild;
			spawnedPtys.push(fastChild);
			return fastChild;
		});

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId, processEpoch } = yield* service.open("/tmp", 80, 24);
					const events = yield* Stream.runCollect(service.subscribe(ptyId));
					expect([...events]).toEqual([
						{
							_tag: "data",
							processEpoch,
							sequence: 1,
							bytes: "fast-open",
						},
						{
							_tag: "exit",
							processEpoch,
							sequence: 2,
							exitCode: 0,
							signal: 0,
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("ignores child callbacks after the first terminal exit", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId, processEpoch } = yield* service.open("/tmp", 80, 24);
					fakePty.emitData("before");
					fakePty.emitExit(0);
					fakePty.emitData("after-exit");
					fakePty.emitExit(99);

					const events = yield* Stream.runCollect(service.subscribe(ptyId));
					expect([...events]).toEqual([
						{
							_tag: "data",
							processEpoch,
							sequence: 1,
							bytes: "before",
						},
						{
							_tag: "exit",
							processEpoch,
							sequence: 2,
							exitCode: 0,
							signal: 0,
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("maps a node-pty write failure during an exit race to a typed not-found error", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId } = yield* service.open("/tmp", 80, 24);
					fakePty.write.mockImplementationOnce(() => {
						fakePty.emitExit(0);
						throw new Error("Cannot write to exited pty");
					});

					const failure = yield* service
						.write(ptyId, "late input")
						.pipe(Effect.flip);
					expect(failure._tag).toBe("PtyNotFoundError");
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("does not hide an unrelated node-pty write defect as a lifecycle race", async () => {
		await expect(
			Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const service = yield* PtyService;
						const { ptyId } = yield* service.open("/tmp", 80, 24);
						fakePty.write.mockImplementationOnce(() => {
							throw new Error("native invariant failed");
						});
						yield* service.write(ptyId, "input");
					}),
				).pipe(Effect.provide(PtyServiceLive)),
			),
		).rejects.toThrow("native invariant failed");
	});

	it("reports an unrecoverable replay gap once and completes", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId, processEpoch } = yield* service.open("/tmp", 80, 24);
					fakePty.emitData("a".repeat(600_000));
					fakePty.emitData("b".repeat(600_000));

					const events = yield* Stream.runCollect(service.subscribe(ptyId, 0));
					expect([...events]).toEqual([
						{
							_tag: "gap",
							processEpoch,
							requestedAfter: 0,
							earliestAvailable: 2,
							latestAvailable: 2,
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("fails an ahead-of-server cursor explicitly without poisoning later replay", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const { ptyId, processEpoch } = yield* service.open("/tmp", 80, 24);
					fakePty.emitData("first");

					const ahead = yield* Stream.runCollect(
						service.subscribe(ptyId, 99, processEpoch),
					);
					expect([...ahead]).toEqual([
						{
							_tag: "gap",
							processEpoch,
							requestedAfter: 99,
							earliestAvailable: 1,
							latestAvailable: 1,
						},
					]);

					fakePty.emitData("second");
					const valid = yield* service
						.subscribe(ptyId, 1, processEpoch)
						.pipe(Stream.take(1), Stream.runCollect);
					expect([...valid]).toEqual([
						{
							_tag: "data",
							processEpoch,
							sequence: 2,
							bytes: "second",
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("lists owned terminals and enforces the per-owner live limit", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownership = {
					ownerId: owner("mobile-device"),
					label: "Project shell",
					scope: "session" as const,
				};

				for (let index = 0; index < 4; index += 1) {
					yield* service.open("/tmp/project", 90, 30, undefined, ownership);
				}

				const catalog = yield* service.list(owner("mobile-device"));
				expect(catalog.liveLimit).toBe(4);
				const listed = catalog.terminals;
				expect(listed).toHaveLength(4);
				expect(listed[0]).toMatchObject({
					cwd: "/tmp/project",
					label: "Project shell",
					scope: "session",
					status: "running",
					cols: 90,
					rows: 30,
					latestOutputSequence: 0,
				});

				const error = yield* service
					.open("/tmp/project", 80, 24, undefined, ownership)
					.pipe(Effect.flip);
				expect(error._tag).toBe("PtyOwnerLimitError");

				const exitedPtyId = listed[0]?.ptyId;
				const exitedChild = spawnedPtys[0];
				if (exitedPtyId === undefined || exitedChild === undefined) {
					throw new Error("Expected first owned terminal");
				}
				exitedChild.emitExit(0);
				yield* service.open("/tmp/project", 80, 24, undefined, ownership);
				const restartAtLimit = yield* service
					.restart(exitedPtyId, ownership.ownerId)
					.pipe(Effect.flip);
				expect(restartAtLimit._tag).toBe("PtyOwnerLimitError");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("reconciles a repeated logical open without spawning a second process", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownership = {
					ownerId: owner("desktop-owner"),
					label: "Project shell",
					scope: "session" as const,
					openToken: PtyOpenToken.make("logical-terminal-1"),
				};

				const first = yield* service.open(
					"/tmp/project",
					80,
					24,
					undefined,
					ownership,
				);
				const repeated = yield* service.open(
					"/tmp/project",
					120,
					40,
					undefined,
					ownership,
				);

				expect(repeated).toEqual(first);
				expect(spawnedPtys).toHaveLength(1);
				expect(spawnedPtys[0]?.resize).toHaveBeenCalledWith(120, 40);
				const [summary] = (yield* service.list(ownership.ownerId)).terminals;
				expect(summary).toMatchObject({
					ptyId: first.ptyId,
					processEpoch: first.processEpoch,
					openToken: ownership.openToken,
					cols: 120,
					rows: 40,
				});
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("rejects same-token launch mismatches without leaking a process", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const openToken = PtyOpenToken.make("logical-terminal-conflict");
				const ownership = {
					ownerId: owner("desktop-owner"),
					label: "First label",
					scope: "session" as const,
					openToken,
				};
				const command = {
					cmd: "agent",
					args: ["--resume", "session-1"],
					env: { B: "2", A: "1" },
				};
				const first = yield* service.open(
					"/tmp/project",
					80,
					24,
					command,
					ownership,
				);

				// Label and environment record order are presentation/serialization
				// differences, not a different process identity.
				const equivalent = yield* service.open(
					"/tmp/project",
					80,
					24,
					{ ...command, env: { A: "1", B: "2" } },
					{ ...ownership, label: "Ignored retry label" },
				);
				expect(equivalent).toEqual(first);

				for (const attempt of [
					service.open("/tmp/other", 80, 24, command, ownership),
					service.open(
						"/tmp/project",
						80,
						24,
						{ ...command, args: ["--new"] },
						ownership,
					),
					service.open("/tmp/project", 80, 24, command, {
						...ownership,
						scope: "environment" as const,
					}),
				]) {
					const error = yield* attempt.pipe(Effect.flip);
					expect(error).toMatchObject({
						_tag: "PtyOpenConflictError",
						ownerId: ownership.ownerId,
						openToken,
						ptyId: first.ptyId,
						reason: "launch-mismatch",
					});
				}

				expect(spawnedPtys).toHaveLength(1);
				const listed = (yield* service.list(ownership.ownerId)).terminals;
				expect(listed).toHaveLength(1);
				expect(listed[0]?.label).toBe("First label");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("serializes concurrent opens for the same owner and token", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownership = {
					ownerId: owner("concurrent-owner"),
					openToken: PtyOpenToken.make("concurrent-logical-terminal"),
				};
				const results = yield* Effect.all(
					Array.from({ length: 8 }, () =>
						service.open("/tmp", 80, 24, undefined, ownership),
					),
					{ concurrency: "unbounded" },
				);

				expect(new Set(results.map((result) => result.ptyId))).toHaveLength(1);
				expect(
					new Set(results.map((result) => result.processEpoch)),
				).toHaveLength(1);
				expect(spawnedPtys).toHaveLength(1);
				expect((yield* service.list(ownership.ownerId)).terminals).toHaveLength(
					1,
				);
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("reconciles an existing token before applying the owner limit", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownerId = owner("owner-at-limit");
				const tokenOwnership = {
					ownerId,
					openToken: PtyOpenToken.make("terminal-at-limit"),
				};
				const first = yield* service.open(
					"/tmp/token",
					80,
					24,
					undefined,
					tokenOwnership,
				);
				for (let index = 0; index < 3; index += 1) {
					yield* service.open(`/tmp/legacy-${index}`, 80, 24, undefined, {
						ownerId,
					});
				}

				expect(
					yield* service.open("/tmp/token", 80, 24, undefined, tokenOwnership),
				).toEqual(first);
				const failure = yield* service
					.open("/tmp/new", 80, 24, undefined, { ownerId })
					.pipe(Effect.flip);
				expect(failure._tag).toBe("PtyOwnerLimitError");
				expect(spawnedPtys).toHaveLength(4);
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("scopes open-token reconciliation to one owner", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const openToken = PtyOpenToken.make("shared-client-token");
				const first = yield* service.open("/tmp", 80, 24, undefined, {
					ownerId: owner("owner-a"),
					openToken,
				});
				const second = yield* service.open("/tmp", 80, 24, undefined, {
					ownerId: owner("owner-b"),
					openToken,
				});

				expect(second.ptyId).not.toBe(first.ptyId);
				expect(spawnedPtys).toHaveLength(2);
				expect((yield* service.list(owner("owner-a"))).terminals).toHaveLength(
					1,
				);
				expect((yield* service.list(owner("owner-b"))).terminals).toHaveLength(
					1,
				);
				const mismatch = yield* service
					.write(first.ptyId, "blocked", owner("owner-b"))
					.pipe(Effect.flip);
				expect(mismatch._tag).toBe("PtyOwnerMismatchError");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("keeps an exited token binding through restart and releases it on close", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownership = {
					ownerId: owner("restart-owner"),
					openToken: PtyOpenToken.make("restart-logical-terminal"),
				};
				const first = yield* service.open("/tmp", 80, 24, undefined, ownership);
				spawnedPtys[0]?.emitExit(0);

				const afterExit = yield* service.open(
					"/tmp",
					100,
					30,
					undefined,
					ownership,
				);
				expect(afterExit).toEqual(first);
				expect(spawnedPtys).toHaveLength(1);

				const restarted = yield* service.restart(
					first.ptyId,
					ownership.ownerId,
				);
				expect(restarted.ptyId).toBe(first.ptyId);
				expect(restarted.processEpoch).not.toBe(first.processEpoch);
				expect(
					yield* service.open("/tmp", 100, 30, undefined, ownership),
				).toEqual(restarted);
				expect(spawnedPtys).toHaveLength(2);

				yield* service.close(first.ptyId, ownership.ownerId);
				const reopened = yield* service.open(
					"/tmp",
					80,
					24,
					undefined,
					ownership,
				);
				expect(reopened.ptyId).not.toBe(first.ptyId);
				expect(spawnedPtys).toHaveLength(3);
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("makes owner-qualified close safe to replay after a lost acknowledgement", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownerId = owner("lost-close-owner");
				const opened = yield* service.open("/tmp", 80, 24, undefined, {
					ownerId,
					openToken: PtyOpenToken.make("lost-close-terminal"),
				});

				// The first close may have reached the server even when its response did
				// not reach the client. Replaying the same owner-qualified intent succeeds.
				yield* service.close(opened.ptyId, ownerId);
				yield* service.close(opened.ptyId, ownerId);
				expect((yield* service.list(ownerId)).terminals).toEqual([]);
				expect(spawnedPtys[0]?.kill).toHaveBeenCalledOnce();

				const legacyReplay = yield* service
					.close(opened.ptyId)
					.pipe(Effect.flip);
				expect(legacyReplay._tag).toBe("PtyNotFoundError");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("atomically and idempotently closes every terminal for one owner", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const tokenOwned = yield* service.open("/tmp/a", 80, 24, undefined, {
					ownerId: owner("disposed-owner"),
					openToken: PtyOpenToken.make("disposed-logical-terminal"),
				});
				yield* service.open("/tmp/b", 80, 24, undefined, {
					ownerId: owner("disposed-owner"),
				});
				const retained = yield* service.open("/tmp/c", 80, 24, undefined, {
					ownerId: owner("retained-owner"),
					openToken: PtyOpenToken.make("retained-logical-terminal"),
				});

				expect(yield* service.closeOwned(owner("disposed-owner"))).toBe(2);
				expect(yield* service.closeOwned(owner("disposed-owner"))).toBe(0);
				expect(
					(yield* service.list(owner("disposed-owner"))).terminals,
				).toEqual([]);
				expect(
					(yield* service.list(owner("retained-owner"))).terminals,
				).toHaveLength(1);
				expect(spawnedPtys[0]?.kill).toHaveBeenCalledOnce();
				expect(spawnedPtys[1]?.kill).toHaveBeenCalledOnce();
				expect(spawnedPtys[2]?.kill).not.toHaveBeenCalled();

				// Retired callbacks cannot resurrect a catalog row or affect another owner.
				spawnedPtys[0]?.emitData("stale");
				spawnedPtys[0]?.emitExit(99);
				const closed = yield* service
					.write(tokenOwned.ptyId, "blocked", owner("disposed-owner"))
					.pipe(Effect.flip);
				expect(closed._tag).toBe("PtyNotFoundError");
				yield* service.write(
					retained.ptyId,
					"allowed",
					owner("retained-owner"),
				);
				expect(spawnedPtys[2]?.write).toHaveBeenCalledWith("allowed");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("keeps the owner limit atomic and isolates owned terminal access", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownership = {
					ownerId: owner("owner-a"),
					label: "Shell",
					scope: "environment" as const,
				};
				const attempts = yield* Effect.all(
					Array.from({ length: 5 }, () =>
						service.open("/tmp", 80, 24, undefined, ownership).pipe(
							Effect.match({
								onFailure: () => "failure" as const,
								onSuccess: () => "success" as const,
							}),
						),
					),
					{ concurrency: "unbounded" },
				);
				expect(attempts.filter((result) => result === "success")).toHaveLength(
					4,
				);
				expect(attempts.filter((result) => result === "failure")).toHaveLength(
					1,
				);

				const owned = (yield* service.list(owner("owner-a"))).terminals;
				const ptyId = owned[0]?.ptyId;
				if (ptyId === undefined) throw new Error("Expected owned terminal");
				const mismatch = yield* service
					.write(ptyId, "blocked", owner("owner-b"))
					.pipe(Effect.flip);
				expect(mismatch._tag).toBe("PtyOwnerMismatchError");
				yield* service.write(ptyId, "allowed", owner("owner-a"));
				expect(spawnedPtys[0]?.write).toHaveBeenCalledWith("allowed");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("restarts the same logical terminal with an ordered epoch transition", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const ownership = {
						ownerId: owner("owner-a"),
						label: "Shell",
						scope: "session" as const,
					};
					const { ptyId, processEpoch: firstEpoch } = yield* service.open(
						"/tmp/project",
						80,
						24,
						undefined,
						ownership,
					);
					const firstChild = spawnedPtys[0];
					if (firstChild === undefined) throw new Error("Expected first child");

					const collected = yield* service
						.subscribe(ptyId, undefined, undefined, ownership.ownerId)
						.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
					yield* Effect.yieldNow;
					firstChild.emitData("before");

					const restarted = yield* service.restart(ptyId, ownership.ownerId);
					const secondChild = spawnedPtys[1];
					if (secondChild === undefined)
						throw new Error("Expected second child");
					expect(secondChild).not.toBe(firstChild);
					expect(firstChild.kill).toHaveBeenCalledOnce();

					// Late callbacks from the retired child must neither corrupt the new
					// journal nor complete the subscriber.
					firstChild.emitData("stale");
					firstChild.emitExit(99);
					secondChild.emitData("after");

					const events = yield* Fiber.join(collected);
					expect([...events]).toEqual([
						{
							_tag: "cursor",
							processEpoch: expect.any(String),
							sequence: 0,
						},
						{
							_tag: "data",
							processEpoch: expect.any(String),
							sequence: 1,
							bytes: "before",
						},
						{
							_tag: "epoch",
							processEpoch: restarted.processEpoch,
							sequence: 0,
						},
						{
							_tag: "data",
							processEpoch: restarted.processEpoch,
							sequence: 1,
							bytes: "after",
						},
					]);

					const [summary] = (yield* service.list(ownership.ownerId)).terminals;
					expect(summary).toMatchObject({
						ptyId,
						processEpoch: restarted.processEpoch,
						latestOutputSequence: 1,
						status: "running",
					});

					const resumedFromOldEpoch = yield* service
						.subscribe(ptyId, 99, firstEpoch, ownership.ownerId)
						.pipe(Stream.take(3), Stream.runCollect);
					expect([...resumedFromOldEpoch]).toEqual([
						{
							_tag: "epoch",
							processEpoch: restarted.processEpoch,
							sequence: 0,
						},
						{
							_tag: "data",
							processEpoch: restarted.processEpoch,
							sequence: 1,
							bytes: "after",
						},
						{
							_tag: "cursor",
							processEpoch: restarted.processEpoch,
							sequence: 1,
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("captures a fast child's initial output and exit during restart wiring", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					const ownerId = owner("fast-restart-owner");
					const first = yield* service.open("/tmp", 80, 24, undefined, {
						ownerId,
					});
					const fastChild = makeFakePty({
						data: "fast-restart",
						exit: { exitCode: 0, signal: 0 },
					});
					spawnMock.mockImplementationOnce(() => {
						spawnedPtys.push(fastChild);
						return fastChild;
					});

					const collected = yield* service
						.subscribe(first.ptyId, undefined, undefined, ownerId)
						.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
					yield* Effect.yieldNow;
					const restarted = yield* service.restart(first.ptyId, ownerId);
					const events = yield* Fiber.join(collected);
					expect([...events]).toEqual([
						{
							_tag: "cursor",
							processEpoch: first.processEpoch,
							sequence: 0,
						},
						{
							_tag: "epoch",
							processEpoch: restarted.processEpoch,
							sequence: 0,
						},
						{
							_tag: "data",
							processEpoch: restarted.processEpoch,
							sequence: 1,
							bytes: "fast-restart",
						},
						{
							_tag: "exit",
							processEpoch: restarted.processEpoch,
							sequence: 2,
							exitCode: 0,
							signal: 0,
						},
					]);
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("replays an epoch-qualified restart without spawning twice after a lost acknowledgement", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownerId = owner("lost-restart-owner");
				const opened = yield* service.open("/tmp", 80, 24, undefined, {
					ownerId,
				});

				const restarted = yield* service.restart(
					opened.ptyId,
					ownerId,
					opened.processEpoch,
				);
				const replayed = yield* service.restart(
					opened.ptyId,
					ownerId,
					opened.processEpoch,
				);

				expect(replayed).toEqual(restarted);
				expect(restarted.processEpoch).not.toBe(opened.processEpoch);
				expect(spawnedPtys).toHaveLength(2);
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("bounds exited terminal catalogs while retaining the newest restart targets", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownerId = owner("bounded-exited-owner");
				const openedIds: PtyId[] = [];
				for (
					let index = 0;
					index < PTY_EXITED_RETENTION_PER_OWNER + 1;
					index += 1
				) {
					const opened = yield* service.open("/tmp", 80, 24, undefined, {
						ownerId,
					});
					openedIds.push(opened.ptyId);
					spawnedPtys.at(-1)?.emitExit(0);
				}

				const listed = (yield* service.list(ownerId)).terminals;
				expect(listed).toHaveLength(PTY_EXITED_RETENTION_PER_OWNER);
				expect(listed.map((summary) => summary.ptyId)).not.toContain(
					openedIds[0],
				);
				const retired = yield* service
					.restart(openedIds[0] ?? PtyId.make("missing"), ownerId)
					.pipe(Effect.flip);
				expect(retired._tag).toBe("PtyNotFoundError");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("leaves the running process and cursor untouched when restart spawn fails", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const { ptyId, processEpoch } = yield* service.open(
					"/tmp",
					80,
					24,
					undefined,
					{ ownerId: owner("owner-a") },
				);
				const child = spawnedPtys[0];
				if (child === undefined) throw new Error("Expected child");
				spawnMock.mockImplementationOnce(() => {
					throw new Error("spawn refused");
				});

				const failure = yield* service
					.restart(ptyId, owner("owner-a"))
					.pipe(Effect.flip);
				expect(failure).toMatchObject({
					_tag: "PtySpawnError",
					reason: "spawn refused",
				});
				expect(child.kill).not.toHaveBeenCalled();
				child.emitData("still-running");
				yield* service.write(ptyId, "input", owner("owner-a"));
				expect(child.write).toHaveBeenCalledWith("input");
				const [summary] = (yield* service.list(owner("owner-a"))).terminals;
				expect(summary).toMatchObject({
					processEpoch,
					latestOutputSequence: 1,
					status: "running",
				});
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("authorizes catalog rename and restart by platform-neutral owner", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const { ptyId } = yield* service.open("/tmp", 80, 24, undefined, {
					ownerId: owner("desktop-window-a"),
					label: "Original",
					scope: "environment",
				});

				const renameMismatch = yield* service
					.rename(ptyId, "Blocked", owner("desktop-window-b"))
					.pipe(Effect.flip);
				expect(renameMismatch._tag).toBe("PtyOwnerMismatchError");
				const restartMismatch = yield* service
					.restart(ptyId, owner("desktop-window-b"))
					.pipe(Effect.flip);
				expect(restartMismatch._tag).toBe("PtyOwnerMismatchError");

				yield* service.rename(
					ptyId,
					"  Project shell  ",
					owner("desktop-window-a"),
				);
				const [renamed] = (yield* service.list(owner("desktop-window-a")))
					.terminals;
				expect(renamed?.label).toBe("Project shell");
				expect(spawnedPtys).toHaveLength(1);
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("kills retained child processes when the service scope shuts down", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* PtyService;
					yield* service.open("/tmp", 80, 24, undefined, {
						ownerId: owner("shutdown-owner"),
					});
				}),
			).pipe(Effect.provide(PtyServiceLive)),
		);

		expect(spawnedPtys).toHaveLength(1);
		expect(spawnedPtys[0]?.kill).toHaveBeenCalledOnce();
	});
});
