import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
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
import { ensurePinnedCloudflared } from "./cloudflared-install.ts";
import { appendRelayDiagnostic } from "./relay-diagnostics.ts";

/**
 * Runs the `cloudflared` connector that backs the environment's managed tunnel.
 * The relay provisions the tunnel + hostname and hands back a connector token;
 * this service writes the token to a private file and launches `cloudflared`
 * with only that path in its process arguments
 * and keeps it alive (restart-on-exit) until the environment is unlinked or the
 * app shuts down. No chat bytes touch the relay — the connector dials out to the
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

export const managedTunnelTokenPath = (userData: string): string =>
	join(userData, "relay", "cloudflared-token");

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
		const fiberRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
		const binaryRef = yield* Ref.make<string | null>(null);
		const lifecycleLock = yield* Semaphore.make(1);
		const log = (event: string, fields?: Record<string, unknown>) =>
			appendRelayDiagnostic(telemetry, event, fields);

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
					yield* log("cloudflared.process.started", { binary });
					const exitCode = yield* proc.exitCode;
					yield* log("cloudflared.process.exited", { binary, exitCode });
				}),
			);

		const stopUnlocked = Effect.gen(function* () {
			const existing = yield* Ref.get(fiberRef);
			if (existing !== null) yield* Fiber.interrupt(existing);
			yield* Ref.set(fiberRef, null);
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
