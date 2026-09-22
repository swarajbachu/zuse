import { fork } from "node:child_process";
import { once } from "node:events";
import {
	mkdtemp,
	open,
	readFile,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStoreLive } from "../../src/auth/layers/session-store.ts";
import type { SessionBundle } from "../../src/auth/layers/workos.ts";
import { SessionStore } from "../../src/auth/services/session-store.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

const originalAuthDir = process.env.ZUSE_AUTH_DIR;
const originalClientId = process.env.WORKOS_CLIENT_ID;
const TEST_CLIENT_ID = "client_test_integration";
const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	vi.mocked(open).mockReset();
	vi.mocked(unlink).mockReset();
	vi.mocked(unlink).mockImplementation(
		(
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			)
		).unlink,
	);
	vi.mocked(open).mockImplementation(
		(
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			)
		).open,
	);
	if (originalAuthDir === undefined) {
		delete process.env.ZUSE_AUTH_DIR;
	} else {
		process.env.ZUSE_AUTH_DIR = originalAuthDir;
	}
	if (originalClientId === undefined) {
		delete process.env.WORKOS_CLIENT_ID;
	} else {
		process.env.WORKOS_CLIENT_ID = originalClientId;
	}
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const makeTempAuthDir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "zuse-auth-"));
	tempDirs.push(dir);
	process.env.ZUSE_AUTH_DIR = dir;
	process.env.WORKOS_CLIENT_ID = TEST_CLIENT_ID;
	return dir;
};

const authPath = (dir: string): string =>
	join(dir, `auth-${TEST_CLIENT_ID}.json`);

const lockPath = (dir: string): string =>
	join(dir, `auth-${TEST_CLIENT_ID}.lock`);

const makeBundle = (overrides: Partial<SessionBundle> = {}): SessionBundle => ({
	accessToken: "access",
	refreshToken: "refresh",
	expiresAt: Date.now() + 60_000,
	refreshedAt: Date.now(),
	organizationId: null,
	user: {
		id: "user_123",
		email: "user@example.com",
		firstName: null,
		lastName: null,
		profilePictureUrl: null,
	},
	...overrides,
});

const withStore = async <A>(
	fn: (svc: typeof SessionStore.Service) => Effect.Effect<A, unknown>,
): Promise<A> => {
	const runtime = ManagedRuntime.make(SessionStoreLive);
	try {
		return await runtime.runPromise(Effect.flatMap(SessionStore, fn));
	} finally {
		await runtime.dispose();
	}
};

describe("SessionStoreLive", () => {
	it("returns null when the session file is absent", async () => {
		await makeTempAuthDir();
		const value = await withStore((svc) => svc.read());
		expect(value).toBe(null);
	});

	it("writes atomically with 0600 permissions and reads the bundle", async () => {
		const dir = await makeTempAuthDir();
		const bundle = makeBundle({ refreshToken: "newer", refreshedAt: 2 });
		await withStore((svc) => svc.write(bundle));
		const path = authPath(dir);
		const mode = (await stat(path)).mode & 0o777;
		expect(mode).toBe(0o600);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			refreshToken: "newer",
			refreshedAt: 2,
		});
		const read = await withStore((svc) => svc.read());
		expect(read?.refreshToken).toBe("newer");
	});

	it("fails on corrupt JSON but treats wrong-shape JSON as signed out", async () => {
		const dir = await makeTempAuthDir();
		await writeFile(authPath(dir), "{", { mode: 0o600 });
		const corrupt = await withStore((svc) => svc.read().pipe(Effect.result));
		expect(corrupt._tag).toBe("Failure");

		await writeFile(authPath(dir), JSON.stringify({ nope: true }), {
			mode: 0o600,
		});
		const wrongShape = await withStore((svc) => svc.read());
		expect(wrongShape).toBe(null);
	});

	it("refuses to overwrite a newer bundle", async () => {
		await makeTempAuthDir();
		const newer = makeBundle({ refreshToken: "newer", refreshedAt: 10 });
		const older = makeBundle({ refreshToken: "older", refreshedAt: 1 });
		await withStore((svc) => svc.write(newer));
		const winner = await withStore((svc) => svc.write(older));
		expect(winner.refreshToken).toBe("newer");
		const stored = await withStore((svc) => svc.read());
		expect(stored?.refreshToken).toBe("newer");
	});

	it("serializes work under the lock and breaks stale locks", async () => {
		const dir = await makeTempAuthDir();
		await writeFile(
			lockPath(dir),
			JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }),
			{ mode: 0o600 },
		);
		let active = 0;
		let maxActive = 0;
		await Promise.all(
			Array.from({ length: 3 }, () =>
				withStore((svc) =>
					svc.withLock(
						Effect.gen(function* () {
							active += 1;
							maxActive = Math.max(maxActive, active);
							yield* Effect.sleep("20 millis");
							active -= 1;
						}),
					),
				),
			),
		);
		expect(maxActive).toBe(1);
	});
	it("does not admit another owner while lock metadata is being written", async () => {
		await makeTempAuthDir();
		const actual =
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			);
		const writing = Deferred.makeUnsafe<void>();
		const continueWriting = Deferred.makeUnsafe<void>();
		let delayed = false;
		vi.mocked(open).mockImplementation(async (...args) => {
			const handle = await actual.open(...args);
			if (/\.lock(?:\.tmp\.|$)/u.test(String(args[0])) && !delayed) {
				delayed = true;
				const write = handle.writeFile.bind(handle);
				vi.spyOn(handle, "writeFile").mockImplementation(
					async (...writeArgs) => {
						Effect.runSync(Deferred.succeed(writing, undefined));
						await Effect.runPromise(Deferred.await(continueWriting));
						return write(...writeArgs);
					},
				);
			}
			return handle;
		});
		let active = 0;
		let maxActive = 0;
		const work = () =>
			withStore((svc) =>
				svc.withLock(
					Effect.gen(function* () {
						active++;
						maxActive = Math.max(maxActive, active);
						yield* Effect.sleep("300 millis");
						active--;
					}),
				),
			);
		const first = work();
		await Effect.runPromise(Deferred.await(writing));
		const second = work();
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
		} finally {
			Effect.runSync(Deferred.succeed(continueWriting, undefined));
			await Promise.all([first, second]);
		}
		expect(maxActive).toBe(1);
	});
	it("serializes processes and recovers after the owner is killed", async () => {
		const dir = await makeTempAuthDir();
		const workers: ReturnType<typeof fork>[] = [];
		const start = () => {
			const child = fork(
				new URL("../fixtures/session-lock-worker.ts", import.meta.url),
				[],
				{
					execArgv: ["--import", "tsx"],
					stdio: ["ignore", "ignore", "pipe", "ipc"],
					env: {
						...process.env,
						ZUSE_AUTH_DIR: dir,
						WORKOS_CLIENT_ID: TEST_CLIENT_ID,
					},
				},
			);
			workers.push(child);
			let ready = false;
			let inside = false;
			child.on("message", (message) => {
				if (message === "ready") ready = true;
				if (message === "entered") {
					inside = true;
				}
			});
			return {
				child,
				ready: () => ready,
				inside: () => inside,
			};
		};
		try {
			const first = start();
			await vi.waitFor(() => expect(first.inside()).toBe(true), {
				timeout: 5_000,
			});
			const second = start();
			await vi.waitFor(() => expect(second.ready()).toBe(true), {
				timeout: 5_000,
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(second.inside()).toBe(false);
			const exited = once(first.child, "exit");
			first.child.kill("SIGKILL");
			await exited;
			await vi.waitFor(() => expect(second.inside()).toBe(true), {
				timeout: 5_000,
			});
			const secondExit = once(second.child, "exit");
			second.child.send("release");
			await secondExit;
			await withStore((store) => store.withLock(Effect.void));
			expect((await stat(`${lockPath(dir)}.sqlite`)).mode & 0o777).toBe(0o600);
		} finally {
			await Promise.all(
				workers.map(async (child) => {
					if (child.exitCode !== null || child.signalCode !== null) return;
					const exited = once(child, "exit");
					child.kill("SIGKILL");
					await exited;
				}),
			);
		}
	}, 15_000);

	it("releases ownership after failure and interruption", async () => {
		await makeTempAuthDir();
		await withStore((store) =>
			store.withLock(Effect.fail("expected")).pipe(Effect.result),
		);
		const entered = Deferred.makeUnsafe<void>();
		const runtime = ManagedRuntime.make(SessionStoreLive);
		try {
			const owner = runtime.runFork(
				Effect.flatMap(SessionStore, (store) =>
					store.withLock(
						Effect.gen(function* () {
							Effect.runSync(Deferred.succeed(entered, undefined));
							yield* Effect.never;
						}),
					),
				),
			);
			await Effect.runPromise(Deferred.await(entered));
			await Effect.runPromise(Fiber.interrupt(owner));
			await withStore((store) => store.withLock(Effect.void));
		} finally {
			await runtime.dispose();
		}
	});
	it("waits for a legacy owner to finish writing and release its lock", async () => {
		const dir = await makeTempAuthDir();
		await writeFile(lockPath(dir), "{");
		let entered = false;
		const operation = withStore((store) =>
			store.withLock(
				Effect.sync(() => {
					entered = true;
				}),
			),
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(entered).toBe(false);
			expect(await readFile(lockPath(dir), "utf8")).toBe("{");
			await writeFile(
				lockPath(dir),
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now(),
					token: "legacy",
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(entered).toBe(false);
		} finally {
			await rm(lockPath(dir), { force: true });
			await operation;
		}
		expect(entered).toBe(true);
	});

	it("retries transient release failures while ownership remains held", async () => {
		const dir = await makeTempAuthDir();
		const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
		vi.mocked(unlink).mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
		await withStore((store) => store.withLock(Effect.void));
		expect(
			vi.mocked(unlink).mock.calls.filter(([path]) => path === lockPath(dir)),
		).toHaveLength(3);
		await withStore((store) => store.withLock(Effect.void));
	});

	it("reports persistent release failure and closes the SQLite guard", async () => {
		const dir = await makeTempAuthDir();
		vi.mocked(unlink).mockRejectedValue(
			Object.assign(new Error("denied"), { code: "EACCES" }),
		);
		await expect(
			withStore((store) => store.withLock(Effect.void)),
		).rejects.toMatchObject({
			_tag: "SessionStoreError",
			reason: "Failed to release auth session lock.",
		});
		const actual =
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			);
		vi.mocked(unlink).mockImplementation(actual.unlink);
		await actual.unlink(lockPath(dir));
		await withStore((store) => store.withLock(Effect.void));
	});
});
