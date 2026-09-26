import {
	PtyCatalog,
	type PtyCommand,
	PtyCursorEvent,
	PtyEpochEvent,
	type PtyEvent,
	PtyGapEvent,
	PtyId,
	PtyNotFoundError,
	PtyOpenConflictError,
	type PtyOpenToken,
	type PtyOwnerId,
	PtyOwnerLimitError,
	PtyOwnerMismatchError,
	PtySpawnError,
	PtySummary,
} from "@zuse/contracts";
import { Effect, Layer, PubSub, Ref, Semaphore, Stream } from "effect";
import * as pty from "node-pty";
import { ensureNodePtySpawnHelperExecutable } from "../node-pty-helper.ts";
import { PtyEventJournal } from "../pty-event-journal.ts";
import { PtyService } from "../services/pty-service.ts";

type PtyBroadcast =
	| { readonly _tag: "event"; readonly event: typeof PtyEvent.Type }
	| { readonly _tag: "end" };

type PendingChildEvent =
	| { readonly _tag: "data"; readonly bytes: string }
	| {
			readonly _tag: "exit";
			readonly exitCode: number | null;
			readonly signal: number | null;
	  };

type SpawnedPty = Readonly<{
	child: pty.IPty;
	activate: (consumer: (event: PendingChildEvent) => void) => void;
}>;

interface ActivePty {
	pty: pty.IPty;
	readonly cwd: string;
	readonly command: PtyCommand | undefined;
	journal: PtyEventJournal;
	readonly events: PubSub.PubSub<PtyBroadcast>;
	readonly ownerId: PtyOwnerId | null;
	readonly openToken: PtyOpenToken | null;
	label: string | null;
	readonly scope: "session" | "environment";
	cols: number;
	rows: number;
	processEpoch: string;
	generation: number;
	exited: boolean;
	exitOrder: number | null;
}

type PtyLaunchConfig = Pick<ActivePty, "cwd" | "cols" | "rows" | "command">;

const OUTPUT_REPLAY_BYTES = 1024 * 1024;
const LIVE_OUTPUT_CHUNKS = 1024;
export const PTY_EXITED_RETENTION_PER_OWNER = 16;
const PTY_LIVE_LIMIT_PER_OWNER = 4;

const defaultShell = (): string => {
	if (process.platform === "win32") {
		return process.env.COMSPEC ?? "cmd.exe";
	}
	return process.env.SHELL ?? "/bin/bash";
};

const normalizeLabel = (label: string | null): string | null => {
	if (label === null) return null;
	const normalized = label.trim();
	return normalized.length === 0 ? null : normalized;
};

const commandMatches = (
	left: PtyCommand | undefined,
	right: PtyCommand | undefined,
): boolean => {
	if (left === undefined || right === undefined) return left === right;
	if (left.cmd !== right.cmd || left.args.length !== right.args.length) {
		return false;
	}
	if (!left.args.every((arg, index) => arg === right.args[index])) return false;
	const leftEnv = Object.entries(left.env ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const rightEnv = Object.entries(right.env ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return (
		leftEnv.length === rightEnv.length &&
		leftEnv.every(
			([key, value], index) =>
				key === rightEnv[index]?.[0] && value === rightEnv[index]?.[1],
		)
	);
};

const toSummary = (ptyId: PtyId, active: ActivePty): PtySummary =>
	PtySummary.make({
		ptyId,
		cwd: active.cwd,
		label: active.label,
		scope: active.scope,
		status: active.exited ? "exited" : "running",
		cols: active.cols,
		rows: active.rows,
		processEpoch: active.processEpoch,
		latestOutputSequence: active.journal.latestSequence,
		openToken: active.openToken,
	});

export const PtyServiceLive = Layer.effect(
	PtyService,
	Effect.gen(function* () {
		const ref = yield* Ref.make<ReadonlyMap<PtyId, ActivePty>>(new Map());
		// One gate makes owner admission and every catalog/process replacement
		// atomic. PTY byte IO remains outside it and never waits on catalog work.
		const lifecycle = yield* Semaphore.make(1);
		let exitOrder = 0;

		const retireEntries = Effect.fn("PtyService.retireEntries")(function* (
			entries: ReadonlyArray<readonly [PtyId, ActivePty]>,
		) {
			if (entries.length === 0) return 0;
			const items = yield* Ref.get(ref);
			const retiring = entries.filter(
				([ptyId, active]) => items.get(ptyId) === active,
			);
			if (retiring.length === 0) return 0;
			const next = new Map(items);
			for (const [ptyId, active] of retiring) {
				active.generation += 1;
				next.delete(ptyId);
			}
			yield* Ref.set(ref, next);
			for (const [, active] of retiring) {
				try {
					if (!active.exited) active.pty.kill();
				} catch {
					// Already dead.
				}
				yield* PubSub.shutdown(active.events);
			}
			return retiring.length;
		});

		const pruneExited = Effect.fn("PtyService.pruneExited")(function* (
			ownerId: PtyOwnerId | null,
		) {
			const items = yield* Ref.get(ref);
			const exited = [...items.entries()]
				.filter(([, active]) => active.ownerId === ownerId && active.exited)
				.sort(
					([, left], [, right]) =>
						(left.exitOrder ?? Number.MAX_SAFE_INTEGER) -
						(right.exitOrder ?? Number.MAX_SAFE_INTEGER),
				);
			const retire = exited.slice(
				0,
				Math.max(0, exited.length - PTY_EXITED_RETENTION_PER_OWNER),
			);
			if (retire.length === 0) return;

			yield* retireEntries(retire);
		});

		const spawnChild = Effect.fn("PtyService.spawnChild")(function* (
			active: PtyLaunchConfig,
		) {
			const cmd = active.command?.cmd ?? defaultShell();
			const args = active.command?.args ?? [];
			return yield* Effect.try({
				try: () => {
					ensureNodePtySpawnHelperExecutable();
					const child = pty.spawn(cmd, [...args], {
						name: "xterm-256color",
						cols: active.cols,
						rows: active.rows,
						cwd: active.cwd,
						env: {
							...(process.env as Record<string, string>),
							...(active.command?.env ?? {}),
							TERM: "xterm-256color",
						},
					});
					const pending: PendingChildEvent[] = [];
					let consumer: ((event: PendingChildEvent) => void) | null = null;
					const capture = (event: PendingChildEvent): void => {
						if (consumer === null) pending.push(event);
						else consumer(event);
					};
					try {
						// Attach inside the same synchronous spawn boundary. Effect may
						// cooperatively yield before the catalog entry is ready, so callbacks
						// must already have somewhere to wait.
						child.onData((bytes) => capture({ _tag: "data", bytes }));
						child.onExit(({ exitCode, signal }) =>
							capture({
								_tag: "exit",
								exitCode: exitCode ?? null,
								signal: signal ?? null,
							}),
						);
					} catch (cause) {
						try {
							child.kill();
						} catch {
							// Best effort after listener setup fails.
						}
						throw cause;
					}
					return {
						child,
						activate: (nextConsumer) => {
							consumer = nextConsumer;
							const buffered = pending.splice(0);
							for (const event of buffered) nextConsumer(event);
						},
					} satisfies SpawnedPty;
				},
				catch: (cause) =>
					new PtySpawnError({
						reason: cause instanceof Error ? cause.message : String(cause),
					}),
			});
		});

		const wireChild = (
			active: ActivePty,
			spawned: SpawnedPty,
			generation: number,
		): (() => void) => {
			const child = spawned.child;
			const isCurrent = () =>
				active.generation === generation && active.pty === child;

			const publish = (event: PendingChildEvent): void => {
				if (!isCurrent()) return;
				if (active.exited) return;
				if (event._tag === "data") {
					const sequenced = active.journal.appendData(event.bytes);
					PubSub.publishUnsafe(active.events, {
						_tag: "event",
						event: sequenced,
					});
					return;
				}
				active.exited = true;
				active.exitOrder = ++exitOrder;
				const sequenced = active.journal.appendExit(
					event.exitCode,
					event.signal,
				);
				PubSub.publishUnsafe(active.events, {
					_tag: "event",
					event: sequenced,
				});
				PubSub.publishUnsafe(active.events, { _tag: "end" });
			};

			return () => {
				if (!isCurrent()) return;
				spawned.activate(publish);
			};
		};

		const getActive = Effect.fn("PtyService.getActive")(function* (
			ptyId: PtyId,
			ownerId?: PtyOwnerId,
		) {
			const items = yield* Ref.get(ref);
			const active = items.get(ptyId);
			if (active === undefined) return yield* new PtyNotFoundError({ ptyId });
			if (active.ownerId !== null && active.ownerId !== ownerId) {
				return yield* new PtyOwnerMismatchError({ ptyId });
			}
			return active;
		});

		const open: PtyService["Service"]["open"] = (
			cwd,
			cols,
			rows,
			command,
			ownership,
		) =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					let current = yield* Ref.get(ref);
					if (ownership !== undefined) {
						const openToken = ownership.openToken;
						if (openToken !== undefined) {
							const existing = [...current.entries()].find(
								([, item]) =>
									item.ownerId === ownership.ownerId &&
									item.openToken === openToken,
							);
							if (existing !== undefined) {
								const [ptyId, active] = existing;
								if (
									active.cwd !== cwd ||
									active.scope !== (ownership.scope ?? "session") ||
									!commandMatches(active.command, command)
								) {
									return yield* new PtyOpenConflictError({
										ownerId: ownership.ownerId,
										openToken,
										ptyId,
										reason: "launch-mismatch",
									});
								}
								const nextCols = Math.max(1, cols);
								const nextRows = Math.max(1, rows);
								active.cols = nextCols;
								active.rows = nextRows;
								if (!active.exited) {
									try {
										active.pty.resize(nextCols, nextRows);
									} catch {
										// The process may exit while a lost acknowledgement is retried.
									}
								}
								return { ptyId, processEpoch: active.processEpoch };
							}
						}
						yield* pruneExited(ownership.ownerId);
						current = yield* Ref.get(ref);
						const ownedLiveCount = [...current.values()].filter(
							(item) => item.ownerId === ownership.ownerId && !item.exited,
						).length;
						if (ownedLiveCount >= PTY_LIVE_LIMIT_PER_OWNER) {
							return yield* new PtyOwnerLimitError({
								ownerId: ownership.ownerId,
								limit: PTY_LIVE_LIMIT_PER_OWNER,
							});
						}
					} else {
						yield* pruneExited(null);
					}

					const ptyId = PtyId.make(crypto.randomUUID());
					const processEpoch = crypto.randomUUID();
					const launch: PtyLaunchConfig = {
						cwd,
						command,
						cols: Math.max(1, cols),
						rows: Math.max(1, rows),
					};
					const spawned = yield* spawnChild(launch);
					const child = spawned.child;
					const events =
						yield* PubSub.sliding<PtyBroadcast>(LIVE_OUTPUT_CHUNKS);
					const active: ActivePty = {
						pty: child,
						cwd,
						command,
						journal: new PtyEventJournal(OUTPUT_REPLAY_BYTES, processEpoch),
						events,
						ownerId: ownership?.ownerId ?? null,
						openToken: ownership?.openToken ?? null,
						label: normalizeLabel(ownership?.label ?? null),
						scope: ownership?.scope ?? "session",
						cols: launch.cols,
						rows: launch.rows,
						processEpoch,
						generation: 1,
						exited: false,
						exitOrder: null,
					};
					const activate = wireChild(active, spawned, active.generation);
					yield* Ref.update(ref, (items) => {
						const next = new Map(items);
						next.set(ptyId, active);
						return next;
					});
					activate();
					return { ptyId, processEpoch };
				}),
			);

		const list: PtyService["Service"]["list"] = (ownerId) =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					yield* pruneExited(ownerId);
					const items = yield* Ref.get(ref);
					const terminals = [...items.entries()]
						.filter(([, item]) => item.ownerId === ownerId)
						.map(([ptyId, item]) => toSummary(ptyId, item));
					return PtyCatalog.make({
						terminals,
						liveLimit: PTY_LIVE_LIMIT_PER_OWNER,
					});
				}),
			);

		const write: PtyService["Service"]["write"] = (ptyId, data, ownerId) =>
			Effect.gen(function* () {
				const active = yield* getActive(ptyId, ownerId);
				const child = active.pty;
				const generation = active.generation;
				// `getActive` and the native write are separate Effect operations. Close
				// or restart may retire this entry between them, so validate both the
				// catalog identity and the process lease before entering node-pty.
				const current = yield* Ref.get(ref);
				if (
					current.get(ptyId) !== active ||
					active.exited ||
					active.generation !== generation ||
					active.pty !== child
				) {
					return yield* new PtyNotFoundError({ ptyId });
				}

				const wroteCurrentProcess = yield* Effect.sync(() => {
					if (
						active.exited ||
						active.generation !== generation ||
						active.pty !== child
					) {
						return false;
					}
					try {
						child.write(data);
					} catch (cause) {
						// node-pty can report a synchronous exit while attempting the
						// write. Translate only that observable lifecycle race; unrelated
						// native/programming failures remain defects instead of being hidden.
						if (
							active.exited ||
							active.generation !== generation ||
							active.pty !== child
						) {
							return false;
						}
						throw cause;
					}
					return (
						!active.exited &&
						active.generation === generation &&
						active.pty === child
					);
				});
				if (!wroteCurrentProcess) {
					return yield* new PtyNotFoundError({ ptyId });
				}
			});

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
								// The child may exit between the resource snapshot and resize.
							}
						}),
			);

		const close: PtyService["Service"]["close"] = (ptyId, ownerId) =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					const items = yield* Ref.get(ref);
					const active = items.get(ptyId);
					if (active === undefined) {
						// An owner-qualified close is an idempotent desired-state command.
						// Its first acknowledgement may be lost, so a replay after removal
						// must still succeed. Legacy unowned callers retain not-found behavior.
						if (ownerId !== undefined) return;
						return yield* new PtyNotFoundError({ ptyId });
					}
					if (active.ownerId !== null && active.ownerId !== ownerId) {
						return yield* new PtyOwnerMismatchError({ ptyId });
					}
					yield* retireEntries([[ptyId, active]]);
				}),
			);

		const closeOwned: PtyService["Service"]["closeOwned"] = (ownerId) =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					const items = yield* Ref.get(ref);
					const owned = [...items.entries()].filter(
						([, active]) => active.ownerId === ownerId,
					);
					if (owned.length === 0) return 0;

					return yield* retireEntries(owned);
				}),
			);

		const rename: PtyService["Service"]["rename"] = (ptyId, label, ownerId) =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					const active = yield* getActive(ptyId, ownerId);
					active.label = normalizeLabel(label);
					return toSummary(ptyId, active);
				}),
			);

		const restart: PtyService["Service"]["restart"] = (
			ptyId,
			ownerId,
			expectedProcessEpoch,
		) =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					const active = yield* getActive(ptyId, ownerId);
					if (
						expectedProcessEpoch !== undefined &&
						active.processEpoch !== expectedProcessEpoch
					) {
						return { ptyId, processEpoch: active.processEpoch };
					}
					if (active.exited && active.ownerId !== null) {
						const current = yield* Ref.get(ref);
						const ownedLiveCount = [...current.values()].filter(
							(item) => item.ownerId === active.ownerId && !item.exited,
						).length;
						if (ownedLiveCount >= PTY_LIVE_LIMIT_PER_OWNER) {
							return yield* new PtyOwnerLimitError({
								ownerId: active.ownerId,
								limit: PTY_LIVE_LIMIT_PER_OWNER,
							});
						}
					}
					// Spawn first. A spawn failure leaves the existing process and cursor
					// completely untouched.
					const spawned = yield* spawnChild(active);
					const nextChild = spawned.child;
					const previousChild = active.pty;
					const previousExited = active.exited;
					const processEpoch = crypto.randomUUID();
					active.generation += 1;
					active.pty = nextChild;
					active.processEpoch = processEpoch;
					active.journal = new PtyEventJournal(
						OUTPUT_REPLAY_BYTES,
						processEpoch,
					);
					active.exited = false;
					active.exitOrder = null;
					const activate = wireChild(active, spawned, active.generation);
					PubSub.publishUnsafe(active.events, {
						_tag: "event",
						event: PtyEpochEvent.make({ processEpoch, sequence: 0 }),
					});
					activate();
					try {
						if (!previousExited) previousChild.kill();
					} catch {
						// Already dead. Its callbacks are generation-fenced either way.
					}
					return { ptyId, processEpoch };
				}),
			);

		const closeByCwdPrefix: PtyService["Service"]["closeByCwdPrefix"] = (
			cwdPrefix,
		) =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					const prefix = cwdPrefix.endsWith("/") ? cwdPrefix : `${cwdPrefix}/`;
					const items = yield* Ref.get(ref);
					const matching = [...items.entries()].filter(
						([, active]) =>
							active.cwd === cwdPrefix || active.cwd.startsWith(prefix),
					);
					yield* retireEntries(matching);
				}),
			);

		const subscribe: PtyService["Service"]["subscribe"] = (
			ptyId,
			afterSequence,
			processEpoch,
			ownerId,
		) =>
			Stream.unwrap(
				lifecycle.withPermits(1)(
					Effect.gen(function* () {
						const active = yield* getActive(ptyId, ownerId);
						const subscription = yield* PubSub.subscribe(active.events);
						const snapshotEpoch = active.processEpoch;
						const epochChanged =
							processEpoch !== undefined && processEpoch !== snapshotEpoch;
						const journal = active.journal;
						const replay = journal.replay(
							epochChanged ? undefined : afterSequence,
						);
						const latestAtSnapshot = journal.latestSequence;
						if (replay._tag === "gap") {
							return Stream.make(
								PtyGapEvent.make({
									processEpoch: snapshotEpoch,
									requestedAfter: replay.requestedAfter,
									earliestAvailable: replay.earliestAvailable,
									latestAvailable: replay.latestAvailable,
								}),
							);
						}
						const epochTransition = epochChanged
							? [
									PtyEpochEvent.make({
										processEpoch: snapshotEpoch,
										sequence: 0,
									}),
								]
							: [];
						const initial: ReadonlyArray<typeof PtyEvent.Type> = [
							...epochTransition,
							...replay.events,
						];
						if (active.exited) return Stream.fromIterable(initial);
						const synchronized = Stream.concat(
							Stream.fromIterable(initial),
							Stream.make(
								PtyCursorEvent.make({
									processEpoch: snapshotEpoch,
									sequence: latestAtSnapshot,
								}),
							),
						);
						const live: Stream.Stream<typeof PtyEvent.Type> =
							Stream.fromSubscription(subscription).pipe(
								Stream.takeWhile((item) => item._tag !== "end"),
								Stream.filter(
									(item): item is Extract<PtyBroadcast, { _tag: "event" }> =>
										item._tag === "event",
								),
								Stream.map((item) => item.event),
								Stream.filter(
									(event) =>
										event._tag === "epoch" ||
										event._tag === "gap" ||
										event.processEpoch !== snapshotEpoch ||
										event.sequence > latestAtSnapshot,
								),
							);
						return Stream.concat(synchronized, live);
					}),
				),
			).pipe(Stream.scoped);

		yield* Effect.addFinalizer(() =>
			lifecycle.withPermits(1)(
				Effect.gen(function* () {
					const items = yield* Ref.get(ref);
					yield* retireEntries([...items.entries()]);
				}),
			),
		);

		return {
			open,
			list,
			write,
			resize,
			close,
			closeOwned,
			rename,
			restart,
			closeByCwdPrefix,
			subscribe,
		} as const;
	}),
);
