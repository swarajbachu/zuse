import * as pty from "node-pty";
import { type Cause, Effect, Exit, Layer, Queue, Ref, Stream } from "effect";

import {
  PtyDataEvent,
  PtyExitEvent,
  PtyId,
  PtyNotFoundError,
  PtySpawnError,
  type PtyEvent,
} from "@zuse/contracts";

import { PtyService } from "../services/pty-service.ts";

interface ActivePty {
  readonly pty: pty.IPty;
  readonly cwd: string;
  readonly events: Queue.Queue<
    typeof PtyEvent.Type,
    PtyNotFoundError | Cause.Done
  >;
}

const defaultShell = (): string => {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
};

export const PtyServiceLive = Layer.effect(
  PtyService,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<PtyId, ActivePty>>(new Map());

    const open: PtyService["Service"]["open"] = (cwd, cols, rows, command) =>
      Effect.gen(function* () {
        const id = PtyId.make(crypto.randomUUID());

        const events = yield* Queue.make<
          typeof PtyEvent.Type,
          PtyNotFoundError | Cause.Done
        >();

        const cmd = command?.cmd ?? defaultShell();
        const args = command?.args ?? [];

        const child = yield* Effect.try({
          try: () =>
            pty.spawn(cmd, [...args], {
              name: "xterm-256color",
              cols,
              rows,
              cwd,
              env: {
                ...(process.env as Record<string, string>),
                ...(command?.env ?? {}),
                TERM: "xterm-256color",
              },
            }),
          catch: (err) =>
            new PtySpawnError({
              reason: err instanceof Error ? err.message : String(err),
            }),
        });

        child.onData((bytes) => {
          Queue.offerUnsafe(events, PtyDataEvent.make({ bytes }));
        });

        child.onExit(({ exitCode, signal }) => {
          Queue.offerUnsafe(events,
            PtyExitEvent.make({
              exitCode: exitCode ?? null,
              signal: signal ?? null,
            }),
          );
          Queue.endUnsafe(events);
          Effect.runSync(
            Ref.update(ref, (m) => {
              const next = new Map(m);
              next.delete(id);
              return next;
            }),
          );
        });

        yield* Ref.update(ref, (m) => {
          const next = new Map(m);
          next.set(id, { pty: child, cwd, events });
          return next;
        });

        return { ptyId: id };
      });

    const getActive = (
      ptyId: PtyId,
    ): Effect.Effect<ActivePty, PtyNotFoundError> =>
      Effect.flatMap(Ref.get(ref), (m) => {
        const active = m.get(ptyId);
        return active === undefined
          ? Effect.fail(new PtyNotFoundError({ ptyId }))
          : Effect.succeed(active);
      });

    const write: PtyService["Service"]["write"] = (ptyId, data) =>
      Effect.flatMap(getActive(ptyId), ({ pty: child }) =>
        Effect.sync(() => child.write(data)),
      );

    const resize: PtyService["Service"]["resize"] = (ptyId, cols, rows) =>
      Effect.flatMap(getActive(ptyId), ({ pty: child }) =>
        Effect.sync(() => {
          try {
            child.resize(Math.max(1, cols), Math.max(1, rows));
          } catch {
            // pty may have exited between the renderer's last render and
            // this resize call — safe to ignore.
          }
        }),
      );

    const close: PtyService["Service"]["close"] = (ptyId) =>
      Effect.flatMap(getActive(ptyId), ({ pty: child }) =>
        Effect.sync(() => {
          try {
            child.kill();
          } catch {
            // already dead
          }
        }),
      );

    const closeByCwdPrefix: PtyService["Service"]["closeByCwdPrefix"] = (
      cwdPrefix,
    ) =>
      Effect.gen(function* () {
        const prefix = cwdPrefix.endsWith("/") ? cwdPrefix : `${cwdPrefix}/`;
        const active = yield* Ref.get(ref);
        for (const [id, item] of active) {
          if (item.cwd !== cwdPrefix && !item.cwd.startsWith(prefix)) continue;
          try {
            item.pty.kill();
          } catch {
            // already dead
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m);
            next.delete(id);
            return next;
          });
        }
      });

    const subscribe: PtyService["Service"]["subscribe"] = (ptyId) =>
      Stream.unwrap(
        Effect.map(getActive(ptyId), ({ events }) =>
          Stream.fromQueue(events),
        ),
      );

    return { open, write, resize, close, closeByCwdPrefix, subscribe } as const;
  }),
);
