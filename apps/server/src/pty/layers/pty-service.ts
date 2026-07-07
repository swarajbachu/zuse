import * as pty from "node-pty";
import { Effect, Exit, Layer, Mailbox, Ref, Stream } from "effect";

import {
  PtyDataEvent,
  PtyExitEvent,
  PtyId,
  PtyNotFoundError,
  PtySpawnError,
  type PtyEvent,
} from "@zuse/wire";

import { PtyService } from "../services/pty-service.ts";

interface ActivePty {
  readonly pty: pty.IPty;
  readonly cwd: string;
  readonly mailbox: Mailbox.Mailbox<typeof PtyEvent.Type, PtyNotFoundError>;
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

    const open: PtyService["Type"]["open"] = (cwd, cols, rows, command) =>
      Effect.gen(function* () {
        const id = PtyId.make(crypto.randomUUID());

        const mailbox = yield* Mailbox.make<
          typeof PtyEvent.Type,
          PtyNotFoundError
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
          mailbox.unsafeOffer(PtyDataEvent.make({ bytes }));
        });

        child.onExit(({ exitCode, signal }) => {
          mailbox.unsafeOffer(
            PtyExitEvent.make({
              exitCode: exitCode ?? null,
              signal: signal ?? null,
            }),
          );
          mailbox.unsafeDone(Exit.void);
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
          next.set(id, { pty: child, cwd, mailbox });
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

    const write: PtyService["Type"]["write"] = (ptyId, data) =>
      Effect.flatMap(getActive(ptyId), ({ pty: child }) =>
        Effect.sync(() => child.write(data)),
      );

    const resize: PtyService["Type"]["resize"] = (ptyId, cols, rows) =>
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

    const close: PtyService["Type"]["close"] = (ptyId) =>
      Effect.flatMap(getActive(ptyId), ({ pty: child }) =>
        Effect.sync(() => {
          try {
            child.kill();
          } catch {
            // already dead
          }
        }),
      );

    const closeByCwdPrefix: PtyService["Type"]["closeByCwdPrefix"] = (
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

    const subscribe: PtyService["Type"]["subscribe"] = (ptyId) =>
      Stream.unwrap(
        Effect.map(getActive(ptyId), ({ mailbox }) =>
          Mailbox.toStream(mailbox),
        ),
      );

    return { open, write, resize, close, closeByCwdPrefix, subscribe } as const;
  }),
);
