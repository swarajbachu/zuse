import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Fiber, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { afterEach, describe, expect, it } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { TelemetryStoreLive } from "../../src/observability/telemetry-store.ts";
import {
	commandMatchesManagedTunnel,
	ManagedTunnelRuntime,
	ManagedTunnelRuntimeLive,
	managedTunnelOwnershipPath,
	managedTunnelRunArgs,
	managedTunnelTokenPath,
	terminateManagedTunnelProcesses,
	writeManagedTunnelOwnership,
	writeManagedTunnelToken,
} from "../../src/relay/managed-tunnel-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

type SpawnRecord = {
	readonly args: ReadonlyArray<string>;
	running: boolean;
};

const makeRuntimeLayer = (userData: string, records: SpawnRecord[]) => {
	let nextPid = 1;
	const spawner = CommandExecutor.make((command) =>
		Effect.gen(function* () {
			if (command._tag !== "StandardCommand")
				return yield* Effect.die("unused");
			const connector = command.args.includes("run");
			const record = { args: command.args, running: connector };
			records.push(record);
			if (connector) {
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						record.running = false;
					}),
				);
			}
			return CommandExecutor.makeHandle({
				pid: CommandExecutor.ProcessId(nextPid++),
				exitCode: connector
					? Effect.never
					: Effect.succeed(CommandExecutor.ExitCode(0)),
				isRunning: Effect.sync(() => record.running),
				kill: () =>
					Effect.sync(() => {
						record.running = false;
					}),
				stdin: Sink.drain,
				stdout: Stream.empty,
				stderr: Stream.empty,
				all: Stream.empty,
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			});
		}),
	);
	const paths = Layer.succeed(AppPaths, { userData });
	const telemetry = TelemetryStoreLive.pipe(Layer.provide(paths));
	return ManagedTunnelRuntimeLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				paths,
				telemetry,
				Layer.succeed(CommandExecutor.ChildProcessSpawner, spawner),
			),
		),
	);
};

describe("managed tunnel runtime", () => {
	it("keeps the connector credential out of process arguments", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-tunnel-token-"));
		temporaryDirectories.push(userData);
		const token = "secret-connector-token";
		const tokenPath = managedTunnelTokenPath(userData);

		await writeManagedTunnelToken(tokenPath, token);

		expect(managedTunnelRunArgs(tokenPath)).toEqual([
			"tunnel",
			"--no-autoupdate",
			"run",
			"--token-file",
			tokenPath,
		]);
		expect(managedTunnelRunArgs(tokenPath)).not.toContain(token);
		expect(await readFile(tokenPath, "utf8")).toBe(token);
		expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(tokenPath))).mode & 0o777).toBe(0o700);
	});

	it("replaces an existing token without widening its permissions", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-tunnel-token-"));
		temporaryDirectories.push(userData);
		const tokenPath = managedTunnelTokenPath(userData);
		await mkdir(dirname(tokenPath), { recursive: true, mode: 0o755 });

		await writeManagedTunnelToken(tokenPath, "first-token");
		await writeManagedTunnelToken(tokenPath, "replacement-token");

		expect(await readFile(tokenPath, "utf8")).toBe("replacement-token");
		expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(tokenPath))).mode & 0o777).toBe(0o700);
	});

	it("matches only the exact Zuse token-file command", () => {
		const tokenPath =
			"/Users/me/Library/Application Support/Zuse/relay/cloudflared-token";
		expect(
			commandMatchesManagedTunnel(
				`/opt/homebrew/bin/cloudflared tunnel run --token-file ${tokenPath}`,
				tokenPath,
			),
		).toBe(true);
		expect(
			commandMatchesManagedTunnel(
				`/opt/homebrew/bin/cloudflared tunnel run --token-file ${tokenPath}-other`,
				tokenPath,
			),
		).toBe(false);
		expect(
			commandMatchesManagedTunnel(
				`other-daemon --token-file ${tokenPath}`,
				tokenPath,
			),
		).toBe(false);
	});

	it("uses graceful termination before a bounded forced kill", async () => {
		const running = new Set([41, 42]);
		const signals: Array<[number, NodeJS.Signals]> = [];
		await terminateManagedTunnelProcesses("/exact/token", {
			processIds: async () => [41, 42],
			isRunning: (pid) => running.has(pid),
			kill: (pid, signal) => {
				signals.push([pid, signal]);
				if (pid === 41 || signal === "SIGKILL") running.delete(pid);
			},
			graceMs: 0,
		});
		expect(signals).toEqual([
			[41, "SIGTERM"],
			[42, "SIGTERM"],
			[42, "SIGKILL"],
		]);
	});

	it("clears a stale ownership record when the runtime starts", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-tunnel-runtime-"));
		temporaryDirectories.push(userData);
		const ownershipPath = managedTunnelOwnershipPath(userData);
		await writeManagedTunnelOwnership(ownershipPath, {
			pid: 999_999,
			binary: "/usr/local/bin/cloudflared",
			tokenPath: managedTunnelTokenPath(userData),
			launchId: "stale-launch",
			startedAt: 1,
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* ManagedTunnelRuntime;
				}).pipe(Effect.provide(makeRuntimeLayer(userData, []))),
			),
		);
		await expect(access(ownershipPath)).rejects.toThrow();
	});

	it("serializes concurrent starts and removes the token on stop", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-tunnel-runtime-"));
		temporaryDirectories.push(userData);
		const records: SpawnRecord[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* ManagedTunnelRuntime;
					yield* Effect.all(
						[runtime.start("first-secret"), runtime.start("second-secret")],
						{ concurrency: 2 },
					);
					yield* Effect.sleep("10 millis");
					expect(records.filter((record) => record.running)).toHaveLength(1);
					const connectorArgs = records
						.filter((record) => record.args.includes("run"))
						.map((record) => record.args);
					expect(connectorArgs).toHaveLength(2);
					const ownership = JSON.parse(
						yield* Effect.promise(() =>
							readFile(managedTunnelOwnershipPath(userData), "utf8"),
						),
					) as { pid: number; tokenPath: string; launchId: string };
					expect(ownership.pid).toBeGreaterThan(0);
					expect(ownership.tokenPath).toBe(managedTunnelTokenPath(userData));
					expect(ownership.launchId).not.toBe("");
					expect(
						(yield* Effect.promise(() =>
							stat(managedTunnelOwnershipPath(userData)),
						)).mode & 0o777,
					).toBe(0o600);
					expect(JSON.stringify(connectorArgs)).not.toContain("first-secret");
					expect(JSON.stringify(connectorArgs)).not.toContain("second-secret");
					yield* runtime.stop();
					expect(records.filter((record) => record.running)).toHaveLength(0);
				}).pipe(Effect.provide(makeRuntimeLayer(userData, records))),
			),
		);

		await expect(access(managedTunnelTokenPath(userData))).rejects.toThrow();
		await expect(
			access(managedTunnelOwnershipPath(userData)),
		).rejects.toThrow();
		const logDirectory = join(userData, "logs");
		const diagnostics = (
			await Promise.all(
				(
					await readdir(logDirectory)
				).map((file) => readFile(join(logDirectory, file), "utf8")),
			)
		).join("\n");
		expect(diagnostics).not.toContain("first-secret");
		expect(diagnostics).not.toContain("second-secret");
	});

	it("surfaces explicit token cleanup failures after stopping the connector", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-tunnel-runtime-"));
		temporaryDirectories.push(userData);
		const records: SpawnRecord[] = [];
		const tokenPath = managedTunnelTokenPath(userData);
		const stopExit = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* ManagedTunnelRuntime;
					yield* runtime.start("connector-secret");
					yield* Effect.sleep("10 millis");
					yield* Effect.promise(async () => {
						await rm(tokenPath, { force: true });
						await mkdir(tokenPath);
						await writeFile(join(tokenPath, "block-cleanup"), "blocked");
					});
					const exit = yield* Effect.exit(runtime.stop());
					expect(records.filter((record) => record.running)).toHaveLength(0);
					yield* Effect.promise(() => rm(tokenPath, { recursive: true }));
					return exit;
				}).pipe(Effect.provide(makeRuntimeLayer(userData, records))),
			),
		);

		expect(stopExit._tag).toBe("Failure");
		expect(JSON.stringify(stopExit)).toContain(
			"cloudflared_token_cleanup_failed",
		);
	});

	it("does not orphan a connector when startup is cancelled", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-tunnel-runtime-"));
		temporaryDirectories.push(userData);
		const records: SpawnRecord[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* ManagedTunnelRuntime;
					const startups = yield* Effect.all(
						Array.from({ length: 20 }, (_, index) =>
							Effect.forkChild(runtime.start(`cancelled-secret-${index}`)),
						),
					);
					yield* Effect.yieldNow;
					yield* Effect.forEach(startups, Fiber.interrupt);
					yield* runtime.stop();
					yield* Effect.sleep("10 millis");
					expect(records.filter((record) => record.running)).toHaveLength(0);
				}).pipe(Effect.provide(makeRuntimeLayer(userData, records))),
			),
		);

		await expect(access(managedTunnelTokenPath(userData))).rejects.toThrow();
	});
});
