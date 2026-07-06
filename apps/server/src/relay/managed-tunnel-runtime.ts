import { Command, CommandExecutor } from "@effect/platform";
import { Context, Data, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import fs from "node:fs";

import { AppPaths } from "../app-paths.ts";
import { appendRelayDiagnostic } from "./relay-diagnostics.ts";

/**
 * Runs the `cloudflared` connector that backs the environment's managed tunnel.
 * The relay provisions the tunnel + hostname and hands back a connector token;
 * this service launches `cloudflared tunnel run --token <token>` on the desktop
 * and keeps it alive (restart-on-exit) until the environment is unlinked or the
 * app shuts down. No chat bytes touch the relay — the connector dials out to the
 * Cloudflare edge and traffic flows edge → connector → the local WS server.
 */
export class ManagedTunnelError extends Data.TaggedError("ManagedTunnelError")<{
  readonly reason: string;
}> {}

export class ManagedTunnelRuntime extends Context.Tag(
  "zuse/ManagedTunnelRuntime",
)<
  ManagedTunnelRuntime,
  {
    /** Launch (or relaunch) the connector for `connectorToken`. */
    readonly start: (
      connectorToken: string,
    ) => Effect.Effect<void, ManagedTunnelError>;
    /** Stop the connector if running. */
    readonly stop: () => Effect.Effect<void>;
  }
>() {}

const CLOUDFLARED = "cloudflared";
const CLOUDFLARED_CANDIDATES = [
  CLOUDFLARED,
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
] as const;

export const ManagedTunnelRuntimeLive: Layer.Layer<
  ManagedTunnelRuntime,
  never,
  CommandExecutor.CommandExecutor | AppPaths
> = Layer.scoped(
  ManagedTunnelRuntime,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const paths = yield* AppPaths;
    const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<void> | null>(null);
    const binaryRef = yield* Ref.make<string | null>(null);
    const log = (event: string, fields?: Record<string, unknown>) =>
      appendRelayDiagnostic(paths, event, fields);

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
            const proc = yield* executor.start(
              Command.make(candidate, "--version"),
            );
            const exitCode = yield* proc.exitCode;
            return exitCode === 0;
          }),
        ).pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (ok) {
          yield* Ref.set(binaryRef, candidate);
          yield* log("cloudflared.resolve.ok", { candidate });
          return candidate;
        }
        yield* log("cloudflared.resolve.fail", { candidate });
      }

      yield* log("cloudflared.resolve.not_found");
      return yield* Effect.fail(
        new ManagedTunnelError({
          reason:
            "cloudflared_not_found: install cloudflared and ensure it is on PATH",
        }),
      );
    });

    // Preflight: fail fast with a clear message if the binary is missing, so the
    // link flow can surface an actionable error instead of a silent no-tunnel.
    const ensureBinary = resolveBinary;

    // One supervised run. The Scope kills the process on interrupt (stop/unlink
    // or app shutdown). `exitCode` only resolves when cloudflared dies, so a
    // healthy connector simply blocks here until interrupted.
    const runOnce = (connectorToken: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const binary = yield* ensureBinary;
          const command = Command.make(
            binary,
            "tunnel",
            "--no-autoupdate",
            "run",
            "--token",
            connectorToken,
          ).pipe(Command.stdout("inherit"), Command.stderr("inherit"));
          const proc = yield* executor.start(command);
          yield* log("cloudflared.process.started", { binary });
          const exitCode = yield* proc.exitCode;
          yield* log("cloudflared.process.exited", { binary, exitCode });
        }),
      );

    const stop = Effect.gen(function* () {
      const existing = yield* Ref.get(fiberRef);
      if (existing !== null) yield* Fiber.interrupt(existing);
      yield* Ref.set(fiberRef, null);
    });

    const start = (connectorToken: string) =>
      Effect.gen(function* () {
        yield* log("cloudflared.start");
        yield* ensureBinary;
        yield* stop;
        // Restart on crash with a short backoff; a daemon fiber so link() returns.
        const fiber = yield* runOnce(connectorToken).pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced("3 seconds")),
          Effect.asVoid,
          Effect.forkDaemon,
        );
        yield* Ref.set(fiberRef, fiber);
        yield* log("cloudflared.start.ok");
      });

    // Ensure the connector is torn down when the runtime scope closes.
    yield* Effect.addFinalizer(() => stop);

    return ManagedTunnelRuntime.of({ start, stop: () => stop });
  }),
);
