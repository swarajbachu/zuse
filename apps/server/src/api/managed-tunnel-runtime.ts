import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	Context,
	Data,
	Effect,
	Fiber,
	Layer,
	Ref,
	Schedule,
	Semaphore,
} from "effect";
import {
	ChildProcess as Command,
	ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";

import { AppPaths } from "../app-paths.ts";
import { TelemetryStore } from "../observability/telemetry-store.ts";
import { appendApiDiagnostic } from "./api-diagnostics.ts";
import { ensurePinnedCloudflared } from "./cloudflared-install.ts";

/**
 * Runs the `cloudflared` connector that backs the environment's managed tunnel.
 * The api provisions the tunnel + hostname and hands back a connector token;
 * this service writes the token to a private file and launches `cloudflared`
 * with only that path in its process arguments
 * and keeps it alive (restart-on-exit) until the environment is unlinked or the
 * app shuts down. No chat bytes touch the api — the connector dials out to the
 * Cloudflare edge and traffic flows edge → connector → the local WS server.
 */
export class ManagedTunnelError extends Data.TaggedError("ManagedTunnelError")<{
	readonly reason: string;
}> {}

export class ManagedTunnelRuntime extends Context.Service<
	ManagedTunnelRuntime,
	{
		/** Launch (or relaunch) the connector for `connectorToken`. */
		readonly start: (
			connectorToken: string,
		) => Effect.Effect<void, ManagedTunnelError>;
		/** Stop the connector if running. */
		readonly stop: () => Effect.Effect<void, ManagedTunnelError>;
	}
>()("zuse/ManagedTunnelRuntime") {}

const CLOUDFLARED = "cloudflared";
const CLOUDFLARED_CANDIDATES = [
	CLOUDFLARED,
	"/opt/homebrew/bin/cloudflared",
	"/usr/local/bin/cloudflared",
] as const;
const execFileAsync = promisify(execFile);
const CONNECTOR_TERMINATE_GRACE_MS = 2_000;

export const managedTunnelTokenPath = (userData: string): string =>
	join(userData, "api", "cloudflared-token");

export const managedTunnelOwnershipPath = (userData: string): string =>
	join(userData, "api", "cloudflared-owner.json");

export interface ManagedTunnelOwnership {
	readonly pid: number;
	readonly binary: string;
	readonly tokenPath: string;
	readonly launchId: string;
	readonly startedAt: number;
}

export const managedTunnelRunArgs = (
	tokenPath: string,
): ReadonlyArray<string> => [
	"tunnel",
	"--no-autoupdate",
	"run",
	"--token-file",
	tokenPath,
];

export const writeManagedTunnelToken = async (
	tokenPath: string,
	connectorToken: string,
): Promise<void> => {
	const directory = dirname(tokenPath);
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(directory, 0o700);
	const temporaryPath = `${tokenPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporaryPath, connectorToken, {
			flag: "wx",
			mode: 0o600,
		});
		await fs.promises.rename(temporaryPath, tokenPath);
		await fs.promises.chmod(tokenPath, 0o600);
	} finally {
		await fs.promises.rm(temporaryPath, { force: true });
	}
};

const atomicWritePrivateJson = async (
	path: string,
	value: unknown,
): Promise<void> => {
	const directory = dirname(path);
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(directory, 0o700);
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporaryPath, JSON.stringify(value), {
			flag: "wx",
			mode: 0o600,
		});
		await fs.promises.rename(temporaryPath, path);
		await fs.promises.chmod(path, 0o600);
	} finally {
		await fs.promises.rm(temporaryPath, { force: true });
	}
};

export const commandMatchesManagedTunnel = (
	command: string,
	tokenPath: string,
): boolean => {
	const marker = "--token-file";
	const markerIndex = command.lastIndexOf(marker);
	if (markerIndex < 0) return false;
	const commandPrefix = command.slice(0, markerIndex).trim();
	if (!/(?:^|\/)cloudflared\s/u.test(`${commandPrefix} `)) return false;
	const argument = command.slice(markerIndex + marker.length).trim();
	return (
		argument === tokenPath ||
		argument === `'${tokenPath}'` ||
		argument === `"${tokenPath}"`
	);
};

export const managedTunnelProcessIds = async (
	tokenPath: string,
): Promise<ReadonlyArray<number>> => {
	const { stdout } = await execFileAsync(
		"ps",
		["-ww", "-axo", "pid=,command="],
		{
			maxBuffer: 10 * 1024 * 1024,
		},
	);
	return stdout
		.split("\n")
		.map((line) => /^(\s*\d+)\s+(.+)$/u.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.filter((match) => commandMatchesManagedTunnel(match[2] ?? "", tokenPath))
		.map((match) => Number.parseInt(match[1] ?? "", 10))
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
};

const processRunning = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === "EPERM";
	}
};

const waitForProcessExit = async (
	pid: number,
	timeoutMs: number,
	isRunning = processRunning,
) => {
	const deadline = Date.now() + timeoutMs;
	while (isRunning(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !isRunning(pid);
};

/** Terminate only connectors whose final token-file argument exactly matches. */
export const terminateManagedTunnelProcesses = async (
	tokenPath: string,
	options: {
		readonly processIds?: (tokenPath: string) => Promise<ReadonlyArray<number>>;
		readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
		readonly isRunning?: (pid: number) => boolean;
		readonly graceMs?: number;
	} = {},
): Promise<ReadonlyArray<number>> => {
	const pids = await (options.processIds ?? managedTunnelProcessIds)(tokenPath);
	const kill = options.kill ?? process.kill;
	const isRunning = options.isRunning ?? processRunning;
	for (const pid of pids) {
		try {
			kill(pid, "SIGTERM");
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
		}
	}
	await Promise.all(
		pids.map(async (pid) => {
			if (
				await waitForProcessExit(
					pid,
					options.graceMs ?? CONNECTOR_TERMINATE_GRACE_MS,
					isRunning,
				)
			)
				return;
			try {
				kill(pid, "SIGKILL");
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
			}
		}),
	);
	return pids;
};

export const writeManagedTunnelOwnership = async (
	path: string,
	ownership: ManagedTunnelOwnership,
): Promise<void> => atomicWritePrivateJson(path, ownership);

const clearManagedTunnelOwnership = async (
	path: string,
	launchId?: string,
): Promise<void> => {
	if (launchId !== undefined) {
		try {
			const current = JSON.parse(await fs.promises.readFile(path, "utf8")) as {
				launchId?: unknown;
			};
			if (current.launchId !== launchId) return;
		} catch {
			// A missing or invalid ownership file is already unowned.
		}
	}
	await fs.promises.rm(path, { force: true });
};

export const ManagedTunnelRuntimeLive: Layer.Layer<
	ManagedTunnelRuntime,
	never,
	CommandExecutor.ChildProcessSpawner | AppPaths | TelemetryStore
> = Layer.effect(
	ManagedTunnelRuntime,
	Effect.gen(function* () {
		const executor = yield* CommandExecutor.ChildProcessSpawner;
		const paths = yield* AppPaths;
		const telemetry = yield* TelemetryStore;
		const tokenPath = managedTunnelTokenPath(paths.userData);
		const ownershipPath = managedTunnelOwnershipPath(paths.userData);
		const fiberRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
		const binaryRef = yield* Ref.make<string | null>(null);
		const lifecycleLock = yield* Semaphore.make(1);
		const log = (event: string, fields?: Record<string, unknown>) =>
			appendApiDiagnostic(telemetry, event, fields);

		const isExecutable = (path: string): boolean => {
			try {
				fs.accessSync(path, fs.constants.X_OK);
				return true;
			} catch {
				return false;
			}
		};

		const resolveBinary = Effect.gen(function* () {
			const cached = yield* Ref.get(binaryRef);
			if (cached !== null) {
				return cached;
			}

			for (const candidate of CLOUDFLARED_CANDIDATES) {
				if (candidate !== CLOUDFLARED && !isExecutable(candidate)) {
					yield* log("cloudflared.resolve.skip_not_executable", {
						candidate,
					});
					continue;
				}
				yield* log("cloudflared.resolve.try", { candidate });
				const ok = yield* Effect.scoped(
					Effect.gen(function* () {
						const proc = yield* executor.spawn(
							Command.make(candidate, ["--version"]),
						);
						const exitCode = yield* proc.exitCode;
						return exitCode === 0;
					}),
				).pipe(Effect.catch(() => Effect.succeed(false)));
				if (ok) {
					yield* Ref.set(binaryRef, candidate);
					yield* log("cloudflared.resolve.ok", { candidate });
					return candidate;
				}
				yield* log("cloudflared.resolve.fail", { candidate });
			}

			yield* log("cloudflared.resolve.download_pinned");
			const installed = yield* Effect.tryPromise({
				try: () => ensurePinnedCloudflared({ userData: paths.userData }),
				catch: (cause) =>
					new ManagedTunnelError({
						reason:
							cause instanceof Error
								? `cloudflared_install_failed: ${cause.message}`
								: `cloudflared_install_failed: ${String(cause)}`,
					}),
			});
			yield* Ref.set(binaryRef, installed);
			yield* log("cloudflared.resolve.download_ok", { installed });
			return installed;
		});

		// Preflight: fail fast with a clear message if the binary is missing, so the
		// link flow can surface an actionable error instead of a silent no-tunnel.
		const ensureBinary = resolveBinary;

		// One supervised run. The Scope kills the process on interrupt (stop/unlink
		// or app shutdown). `exitCode` only resolves when cloudflared dies, so a
		// healthy connector simply blocks here until interrupted.
		const runOnce = () =>
			Effect.scoped(
				Effect.gen(function* () {
					const binary = yield* ensureBinary;
					const command = Command.make(
						binary,
						managedTunnelRunArgs(tokenPath),
						{ stdout: "inherit", stderr: "inherit" },
					);
					const proc = yield* executor.spawn(command);
					const launchId = randomUUID();
					yield* Effect.tryPromise({
						try: () =>
							writeManagedTunnelOwnership(ownershipPath, {
								pid: proc.pid,
								binary,
								tokenPath,
								launchId,
								startedAt: Date.now(),
							}),
						catch: () =>
							new ManagedTunnelError({
								reason: "cloudflared_ownership_write_failed",
							}),
					});
					yield* Effect.addFinalizer(() =>
						Effect.promise(() =>
							clearManagedTunnelOwnership(ownershipPath, launchId),
						).pipe(Effect.ignore),
					);
					yield* log("cloudflared.process.started", {
						binary,
						pid: proc.pid,
						launchId,
					});
					const exitCode = yield* proc.exitCode;
					yield* log("cloudflared.process.exited", { binary, exitCode });
				}),
			);

		const stopUnlocked = Effect.gen(function* () {
			const existing = yield* Ref.get(fiberRef);
			if (existing !== null) yield* Fiber.interrupt(existing);
			yield* Ref.set(fiberRef, null);
			yield* Effect.tryPromise({
				try: () => terminateManagedTunnelProcesses(tokenPath),
				catch: () =>
					new ManagedTunnelError({
						reason: "cloudflared_process_cleanup_failed",
					}),
			});
			yield* Effect.tryPromise({
				try: () => clearManagedTunnelOwnership(ownershipPath),
				catch: () =>
					new ManagedTunnelError({
						reason: "cloudflared_ownership_cleanup_failed",
					}),
			});
			yield* Effect.tryPromise({
				try: () => fs.promises.rm(tokenPath, { force: true }),
				catch: () =>
					new ManagedTunnelError({
						reason: "cloudflared_token_cleanup_failed",
					}),
			});
		});
		const stop = lifecycleLock.withPermits(1)(stopUnlocked);

		const start = (connectorToken: string) =>
			lifecycleLock.withPermits(1)(
				Effect.gen(function* () {
					yield* log("cloudflared.start");
					yield* ensureBinary;
					yield* stopUnlocked;
					yield* Effect.tryPromise({
						try: () => writeManagedTunnelToken(tokenPath, connectorToken),
						catch: () =>
							new ManagedTunnelError({
								reason: "cloudflared_token_write_failed",
							}),
					});
					// Restart on crash with a short backoff; a daemon fiber so link() returns.
					yield* Effect.uninterruptible(
						Effect.gen(function* () {
							const fiber = yield* runOnce().pipe(
								Effect.ignore,
								Effect.repeat(Schedule.spaced("3 seconds")),
								Effect.asVoid,
								Effect.forkDetach,
							);
							yield* Ref.set(fiberRef, fiber);
						}),
					);
					yield* log("cloudflared.start.ok");
				}),
			);

		// Recover connectors left behind when the previous app process could not
		// run its finalizers. Exact token-path matching leaves all other tunnels alone.
		const recovered = yield* Effect.tryPromise(async () => {
			const terminated = await terminateManagedTunnelProcesses(tokenPath);
			await clearManagedTunnelOwnership(ownershipPath);
			return terminated;
		}).pipe(
			Effect.catch((cause) =>
				log("cloudflared.startup.recovery_failed", {
					reason: cause instanceof Error ? cause.message : String(cause),
				}).pipe(Effect.as([] as ReadonlyArray<number>)),
			),
		);
		if (recovered.length > 0)
			yield* log("cloudflared.startup.recovered", {
				processCount: recovered.length,
			});

		// Ensure the connector is torn down when the runtime scope closes.
		yield* Effect.addFinalizer(() =>
			stop.pipe(
				Effect.catch((error) =>
					log("cloudflared.token.cleanup_failed", { reason: error.reason }),
				),
			),
		);

		return ManagedTunnelRuntime.of({ start, stop: () => stop });
	}),
);
