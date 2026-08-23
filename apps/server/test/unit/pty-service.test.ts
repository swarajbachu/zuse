import { Effect, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node-pty", () => ({ spawn: spawnMock }));

import { PtyServiceLive } from "../../src/pty/layers/pty-service.ts";
import { PtyService } from "../../src/pty/services/pty-service.ts";

type ExitPayload = { readonly exitCode: number; readonly signal: number };

function makeFakePty() {
  let dataListener: (data: string) => void = () => undefined;
  let exitListener: (event: ExitPayload) => void = () => undefined;
  return {
    process: "zsh",
    pid: 123,
    cols: 80,
    rows: 24,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: ExitPayload) => void) {
      exitListener = listener;
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

  beforeEach(() => {
    fakePty = makeFakePty();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakePty);
  });

  it("hands a subscriber gap-free output after the previous cursor", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* PtyService;
          const { ptyId } = yield* service.open("/tmp", 80, 24);
          fakePty.emitData("first");

          const first = yield* service
            .subscribe(ptyId)
            .pipe(Stream.take(1), Stream.runCollect);
          expect([...first]).toEqual([
            { _tag: "data", sequence: 1, bytes: "first" },
          ]);

          fakePty.emitData("second");
          const resumed = yield* service
            .subscribe(ptyId, 1)
            .pipe(Stream.take(1), Stream.runCollect);
          expect([...resumed]).toEqual([
            { _tag: "data", sequence: 2, bytes: "second" },
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
          const { ptyId } = yield* service.open("/tmp", 80, 24);
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
            { _tag: "data", sequence: 1, bytes: "replayed" },
            { _tag: "cursor", sequence: 1 },
            { _tag: "data", sequence: 2, bytes: "live" },
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
          const { ptyId } = yield* service.open("/tmp", 80, 24);
          fakePty.emitData("done");
          fakePty.emitExit(0);

          const events = yield* Stream.runCollect(service.subscribe(ptyId));
          expect([...events]).toEqual([
            { _tag: "data", sequence: 1, bytes: "done" },
            {
              _tag: "exit",
              sequence: 2,
              exitCode: 0,
              signal: 0,
            },
          ]);
        }),
      ).pipe(Effect.provide(PtyServiceLive)),
    );
  });

  it("reports an unrecoverable replay gap once and completes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* PtyService;
          const { ptyId } = yield* service.open("/tmp", 80, 24);
          fakePty.emitData("a".repeat(600_000));
          fakePty.emitData("b".repeat(600_000));

          const events = yield* Stream.runCollect(service.subscribe(ptyId, 0));
          expect([...events]).toEqual([
            {
              _tag: "gap",
              requestedAfter: 0,
              earliestAvailable: 2,
              latestAvailable: 2,
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
					ownerId: "mobile-device",
					label: "Project shell",
					scope: "session" as const,
				};

				for (let index = 0; index < 4; index += 1) {
					yield* service.open("/tmp/project", 90, 30, undefined, ownership);
				}

				const listed = yield* service.list("mobile-device");
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
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});

	it("keeps the owner limit atomic and isolates owned terminal access", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* PtyService;
				const ownership = {
					ownerId: "owner-a",
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

				const owned = yield* service.list("owner-a");
				const ptyId = owned[0]?.ptyId;
				if (ptyId === undefined) throw new Error("Expected owned terminal");
				const mismatch = yield* service
					.write(ptyId, "blocked", "owner-b")
					.pipe(Effect.flip);
				expect(mismatch._tag).toBe("PtyOwnerMismatchError");
				yield* service.write(ptyId, "allowed", "owner-a");
				expect(fakePty.write).toHaveBeenCalledWith("allowed");
			}).pipe(Effect.provide(PtyServiceLive)),
		);
	});
});
