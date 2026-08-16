import {
  PtyCursorEvent,
  type PtyEvent,
  PtyGapEvent,
  PtyId,
  PtyNotFoundError,
  PtySpawnError,
} from "@zuse/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";
import * as pty from "node-pty";

import {
  PtyEventJournal,
  type PtySequencedEvent,
} from "../pty-event-journal.ts";
import { ensureNodePtySpawnHelperExecutable } from "../node-pty-helper.ts";
import { PtyService } from "../services/pty-service.ts";

type PtyBroadcast =
  | { readonly _tag: "event"; readonly event: PtySequencedEvent }
  | { readonly _tag: "end" };

interface ActivePty {
  readonly pty: pty.IPty;
  readonly cwd: string;
  readonly journal: PtyEventJournal;
  readonly events: PubSub.PubSub<PtyBroadcast>;
  exited: boolean;
}

const OUTPUT_REPLAY_BYTES = 1024 * 1024;
const LIVE_OUTPUT_CHUNKS = 1024;

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

        const events = yield* PubSub.sliding<PtyBroadcast>(LIVE_OUTPUT_CHUNKS);
        const journal = new PtyEventJournal(OUTPUT_REPLAY_BYTES);

        const cmd = command?.cmd ?? defaultShell();
        const args = command?.args ?? [];

        const child = yield* Effect.try({
          try: () => {
            ensureNodePtySpawnHelperExecutable();
            return pty.spawn(cmd, [...args], {
              name: "xterm-256color",
              cols,
              rows,
              cwd,
              env: {
                ...(process.env as Record<string, string>),
                ...(command?.env ?? {}),
                TERM: "xterm-256color",
              },
            });
          },
          catch: (err) =>
            new PtySpawnError({
              reason: err instanceof Error ? err.message : String(err),
            }),
        });

        const active: ActivePty = {
          pty: child,
          cwd,
          journal,
          events,
          exited: false,
        };

        child.onData((bytes) => {
          const event = journal.appendData(bytes);
          PubSub.publishUnsafe(events, { _tag: "event", event });
        });

        child.onExit(({ exitCode, signal }) => {
          active.exited = true;
          const event = journal.appendExit(exitCode ?? null, signal ?? null);
          PubSub.publishUnsafe(events, { _tag: "event", event });
          PubSub.publishUnsafe(events, { _tag: "end" });
        });

        yield* Ref.update(ref, (m) => {
          const next = new Map(m);
          next.set(id, active);
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
      Effect.flatMap(getActive(ptyId), (active) =>
        active.exited
          ? Effect.fail(new PtyNotFoundError({ ptyId }))
          : Effect.sync(() => active.pty.write(data)),
      );

    const resize: PtyService["Service"]["resize"] = (ptyId, cols, rows) =>
      Effect.flatMap(getActive(ptyId), (active) =>
        active.exited
          ? Effect.fail(new PtyNotFoundError({ ptyId }))
          : Effect.sync(() => {
              try {
                active.pty.resize(Math.max(1, cols), Math.max(1, rows));
              } catch {
                // pty may have exited between the renderer's last render and
                // this resize call — safe to ignore.
              }
            }),
      );

    const close: PtyService["Service"]["close"] = (ptyId) =>
      Effect.flatMap(getActive(ptyId), (active) =>
        Effect.gen(function* () {
          yield* Ref.update(ref, (m) => {
            const next = new Map(m);
            next.delete(ptyId);
            return next;
          });
          try {
            if (!active.exited) active.pty.kill();
          } catch {
            // already dead
          }
          yield* PubSub.shutdown(active.events);
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
            if (!item.exited) item.pty.kill();
          } catch {
            // already dead
          }
          yield* PubSub.shutdown(item.events);
          yield* Ref.update(ref, (m) => {
            const next = new Map(m);
            next.delete(id);
            return next;
          });
        }
      });

    const subscribe: PtyService["Service"]["subscribe"] = (
      ptyId,
      afterSequence,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const active = yield* getActive(ptyId);
          const subscription = yield* PubSub.subscribe(active.events);
          const replay = active.journal.replay(afterSequence);
          const latestAtSnapshot = active.journal.latestSequence;
          if (replay._tag === "gap") {
            return Stream.make(
              PtyGapEvent.make({
                requestedAfter: replay.requestedAfter,
                earliestAvailable: replay.earliestAvailable,
                latestAvailable: replay.latestAvailable,
              }),
            );
          }
          const initial: ReadonlyArray<typeof PtyEvent.Type> = replay.events;
          if (active.exited) return Stream.fromIterable(initial);
          const synchronized = Stream.concat(
            Stream.fromIterable(initial),
            Stream.make(PtyCursorEvent.make({ sequence: latestAtSnapshot })),
          );
          const live: Stream.Stream<typeof PtyEvent.Type> =
            Stream.fromSubscription(subscription).pipe(
              Stream.takeWhile((item) => item._tag !== "end"),
              Stream.filter(
                (item): item is Extract<PtyBroadcast, { _tag: "event" }> =>
                  item._tag === "event",
              ),
              Stream.map((item) => item.event),
              Stream.filter((event) => event.sequence > latestAtSnapshot),
            );
          return Stream.concat(synchronized, live);
        }),
      ).pipe(Stream.scoped);

    return { open, write, resize, close, closeByCwdPrefix, subscribe } as const;
  }),
);
