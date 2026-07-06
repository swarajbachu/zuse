import { Command, CommandExecutor } from "@effect/platform";
import {
  Context,
  Data,
  Effect,
  Fiber,
  Layer,
  Ref,
  Schedule,
} from "effect";

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
    readonly start: (connectorToken: string) => Effect.Effect<void, ManagedTunnelError>;
    /** Stop the connector if running. */
    readonly stop: () => Effect.Effect<void>;
  }
>() {}

const CLOUDFLARED = "cloudflared";

export const ManagedTunnelRuntimeLive: Layer.Layer<
  ManagedTunnelRuntime,
  never,
  CommandExecutor.CommandExecutor
> = Layer.scoped(
  ManagedTunnelRuntime,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<void> | null>(null);

    // Preflight: fail fast with a clear message if the binary is missing, so the
    // link flow can surface an actionable error instead of a silent no-tunnel.
    const ensureBinary = Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* executor.start(
          Command.make(CLOUDFLARED, "--version"),
        );
        yield* proc.exitCode;
      }),
    ).pipe(
      Effect.mapError(
        () =>
          new ManagedTunnelError({
            reason:
              "cloudflared_not_found: install cloudflared and ensure it is on PATH",
          }),
      ),
    );

    // One supervised run. The Scope kills the process on interrupt (stop/unlink
    // or app shutdown). `exitCode` only resolves when cloudflared dies, so a
    // healthy connector simply blocks here until interrupted.
    const runOnce = (connectorToken: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const command = Command.make(
            CLOUDFLARED,
            "tunnel",
            "--no-autoupdate",
            "run",
            "--token",
            connectorToken,
          ).pipe(Command.stdout("inherit"), Command.stderr("inherit"));
          const proc = yield* executor.start(command);
          yield* proc.exitCode;
        }),
      );

    const stop = Effect.gen(function* () {
      const existing = yield* Ref.get(fiberRef);
      if (existing !== null) yield* Fiber.interrupt(existing);
      yield* Ref.set(fiberRef, null);
    });

    const start = (connectorToken: string) =>
      Effect.gen(function* () {
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
      });

    // Ensure the connector is torn down when the runtime scope closes.
    yield* Effect.addFinalizer(() => stop);

    return ManagedTunnelRuntime.of({ start, stop: () => stop });
  }),
);
