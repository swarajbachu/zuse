import {
  PtyCursorEvent,
  type PtyEvent,
  PtyGapEvent,
  PtyId,
  PtyNotFoundError,
	PtyOwnerLimitError,
	PtyOwnerMismatchError,
  PtySpawnError,
	PtySummary,
} from "@zuse/contracts";
import { Effect, Layer, PubSub, Ref, Semaphore, Stream } from "effect";
import * as pty from "node-pty";
import { ensureNodePtySpawnHelperExecutable } from "../node-pty-helper.ts";
import {
  PtyEventJournal,
  type PtySequencedEvent,
} from "../pty-event-journal.ts";
import { PtyService } from "../services/pty-service.ts";

type PtyBroadcast =
  | { readonly _tag: "event"; readonly event: PtySequencedEvent }
  | { readonly _tag: "end" };

interface ActivePty {
  readonly pty: pty.IPty;
  readonly cwd: string;
  readonly journal: PtyEventJournal;
  readonly events: PubSub.PubSub<PtyBroadcast>;
	readonly ownerId: string | null;
	readonly label: string | null;
	readonly scope: "session" | "environment";
	cols: number;
	rows: number;
  exited: boolean;
}

const OUTPUT_REPLAY_BYTES = 1024 * 1024;
const LIVE_OUTPUT_CHUNKS = 1024;
const MOBILE_TERMINAL_LIMIT = 4;

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
		const openAdmission = yield* Semaphore.make(1);

		const open: PtyService["Service"]["open"] = (
			cwd,
			cols,
			rows,
			command,
			mobileOwnership,
		) =>
			openAdmission.withPermits(1)(
      Effect.gen(function* () {
					if (mobileOwnership !== undefined) {
						const current = yield* Ref.get(ref);
						const ownedLiveCount = [...current.values()].filter(
							(item) =>
								item.ownerId === mobileOwnership.ownerId && !item.exited,
						).length;
						if (ownedLiveCount >= MOBILE_TERMINAL_LIMIT) {
							return yield* new PtyOwnerLimitError({
								ownerId: mobileOwnership.ownerId,
								limit: MOBILE_TERMINAL_LIMIT,
							});
						}
					}

        const id = PtyId.make(crypto.randomUUID());

					const events =
						yield* PubSub.sliding<PtyBroadcast>(LIVE_OUTPUT_CHUNKS);
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
						ownerId: mobileOwnership?.ownerId ?? null,
						label: mobileOwnership?.label ?? null,
						scope: mobileOwnership?.scope ?? "session",
						cols: Math.max(1, cols),
						rows: Math.max(1, rows),
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
				}),
			);

		const list: PtyService["Service"]["list"] = (ownerId) =>
			Effect.map(Ref.get(ref), (items) =>
				[...items.entries()]
					.filter(([, item]) => item.ownerId === ownerId)
					.map(([ptyId, item]) =>
						PtySummary.make({
							ptyId,
							cwd: item.cwd,
							label: item.label,
							scope: item.scope,
							status: item.exited ? "exited" : "running",
							cols: item.cols,
							rows: item.rows,
							latestOutputSequence: item.journal.latestSequence,
						}),
					),
			);

    const getActive = (
      ptyId: PtyId,
			ownerId?: string,
		): Effect.Effect<ActivePty, PtyNotFoundError | PtyOwnerMismatchError> =>
			Effect.gen(function* () {
				const m = yield* Ref.get(ref);
        const active = m.get(ptyId);
				if (active === undefined) return yield* new PtyNotFoundError({ ptyId });
				if (active.ownerId !== null && active.ownerId !== ownerId)
					return yield* new PtyOwnerMismatchError({ ptyId });
				return active;
      });

		const write: PtyService["Service"]["write"] = (ptyId, data, ownerId) =>
			Effect.flatMap(getActive(ptyId, ownerId), (active) =>
        active.exited
          ? Effect.fail(new PtyNotFoundError({ ptyId }))
          : Effect.sync(() => active.pty.write(data)),
      );

		const resize: PtyService["Service"]["resize"] = (
			ptyId,
			cols,
			rows,
			ownerId,
		) =>
			Effect.flatMap(getActive(ptyId, ownerId), (active) =>
        active.exited
          ? Effect.fail(new PtyNotFoundError({ ptyId }))
          : Effect.sync(() => {
              try {
								active.cols = Math.max(1, cols);
								active.rows = Math.max(1, rows);
								active.pty.resize(active.cols, active.rows);
              } catch {
                // pty may have exited between the renderer's last render and
                // this resize call — safe to ignore.
              }
            }),
      );

		const close: PtyService["Service"]["close"] = (ptyId, ownerId) =>
			Effect.flatMap(getActive(ptyId, ownerId), (active) =>
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
			ownerId,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
					const active = yield* getActive(ptyId, ownerId);
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

		return {
			open,
			list,
			write,
			resize,
			close,
			closeByCwdPrefix,
			subscribe,
		} as const;
  }),
);
