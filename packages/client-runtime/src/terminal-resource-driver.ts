import type { EnvironmentId, PtyEvent, PtyId } from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import type { ResourceDriver } from "./client-bus.ts";
import {
	makeResourceKey,
	type ResourceKey,
	type TerminalRef,
} from "./resource-ref.ts";
import {
	failTerminalResource,
	initialTerminalResourceState,
	reconnectTerminalResource,
	reduceTerminalOutput,
	type TerminalResourceState,
} from "./terminal-resource.ts";

export type TerminalResourceKey = ResourceKey<TerminalResourceState>;

export type TerminalOutputSink = Readonly<{
	write: (bytes: string) => Promise<void>;
	exited: (exitCode: number | null, signal: number | null) => Promise<void>;
}>;

export type TerminalDriverClient = Readonly<{
	"pty.output": (payload: {
		readonly ptyId: PtyId;
		readonly afterSequence: number;
	}) => Stream.Stream<typeof PtyEvent.Type, unknown>;
}>;

type TerminalDriverOptions<Client> = Readonly<{
	sinkFor: (key: TerminalResourceKey) => TerminalOutputSink | null;
	streamOutput?: (
		client: Client,
		ref: TerminalRef,
		afterSequence: number,
	) => Stream.Stream<typeof PtyEvent.Type, unknown>;
	reportConnectionFailure: (
		environmentId: EnvironmentId,
		generation: number,
		cause: unknown,
	) => void;
}>;

class RecoverTerminalOutput extends Error {}
class TerminalOutputSinkFailed extends Error {}

export const terminalResourceKey = (ref: TerminalRef): TerminalResourceKey =>
	makeResourceKey<TerminalResourceState>("terminal", ref);

export const terminalRefFromKey = (
	key: ResourceKey<unknown>,
): TerminalRef | null =>
	key.kind === "terminal" && "terminalId" in key.ref ? key.ref : null;

const hasErrorTag = (cause: unknown, tag: string): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	cause._tag === tag;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const metadata = (
	event: typeof PtyEvent.Type,
): Parameters<typeof reduceTerminalOutput>[1] => {
	switch (event._tag) {
		case "data":
			return { _tag: "data", sequence: event.sequence };
		case "exit":
			return {
				_tag: "exit",
				sequence: event.sequence,
				exitCode: event.exitCode,
				signal: event.signal,
			};
		case "cursor":
			return { _tag: "cursor", sequence: event.sequence };
		case "gap":
			return event;
	}
};

/** Owns PTY replay, cursor validation, reconnects, and sink acknowledgement. */
export const makeTerminalResourceDriver = <Client>(
	options: TerminalDriverOptions<Client>,
): ResourceDriver<Client, TerminalResourceState> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;

	return {
		start: (context) => {
			const ref = terminalRefFromKey(context.key);
			if (ref === null) return;
			const key = context.key as TerminalResourceKey;
			const sink = options.sinkFor(key);
			if (sink === null) throw new Error("Terminal output sink is unavailable");
			active = true;
			const initial =
				context.data ?? initialTerminalResourceState(ref.terminalId);
			let state =
				context.data === null ||
				initial.phase === "exited" ||
				initial.phase === "failed"
					? initial
					: reconnectTerminalResource(initial);
			let recoveries = 0;
			let emittedCursor = context.cursor;

			const emitState = (sync: "synchronizing" | "live" | "failed") => {
				const cursor = {
					epoch: state.processEpoch,
					version: state.outputSequence,
				};
				const cursorChanged =
					emittedCursor?.epoch !== cursor.epoch ||
					emittedCursor.version !== cursor.version;
				const accepted = context.emit({
					data: state,
					...(cursorChanged ? { cursor } : {}),
					sync,
					resetEpoch:
						emittedCursor !== null && emittedCursor.epoch !== cursor.epoch,
				});
				if (accepted) emittedCursor = cursor;
				return accepted;
			};

			emitState("synchronizing");

			const failResource = (
				kind: Parameters<typeof failTerminalResource>[1]["kind"],
				message: string,
			) => {
				state = failTerminalResource(state, { kind, message });
				emitState("failed");
			};

			const handleEvent = (
				event: typeof PtyEvent.Type,
			): Effect.Effect<
				void,
				RecoverTerminalOutput | TerminalOutputSinkFailed
			> => {
				if (!active || !context.isCurrent()) return Effect.void;
				const reduction = reduceTerminalOutput(state, metadata(event));
				if (reduction.kind === "duplicate") return Effect.void;
				if (reduction.kind === "recover") {
					state = reduction.state;
					emitState("synchronizing");
					return Effect.fail(new RecoverTerminalOutput());
				}
				if (reduction.kind === "failed") {
					state = reduction.state;
					emitState("failed");
					active = false;
					return Effect.void;
				}

				const commit = () => {
					state = reduction.state;
					if (event._tag === "cursor") recoveries = 0;
					if (
						!emitState(
							state.phase === "running" || state.phase === "exited"
								? "live"
								: "synchronizing",
						)
					) {
						active = false;
					}
				};
				if (event._tag === "data") {
					return Effect.tryPromise({
						try: () => sink.write(event.bytes),
						catch: (cause) => new TerminalOutputSinkFailed(messageOf(cause)),
					}).pipe(Effect.tap(() => Effect.sync(commit)));
				}
				if (event._tag === "exit") {
					return Effect.tryPromise({
						try: () => sink.exited(event.exitCode, event.signal),
						catch: (cause) => new TerminalOutputSinkFailed(messageOf(cause)),
					}).pipe(Effect.tap(() => Effect.sync(commit)));
				}
				commit();
				return Effect.void;
			};

			const runOutput = (): Effect.Effect<void, unknown> =>
				Stream.runForEach(
					options.streamOutput?.(context.client, ref, state.outputSequence) ??
						(context.client as TerminalDriverClient)["pty.output"]({
							ptyId: ref.terminalId,
							afterSequence: state.outputSequence,
						}),
					handleEvent,
				).pipe(
					Effect.catch((cause) => {
						if (cause instanceof RecoverTerminalOutput && recoveries < 1) {
							recoveries += 1;
							return runOutput();
						}
						return Effect.fail(cause);
					}),
				);

			const program = runOutput().pipe(
				Effect.matchCauseEffect({
					onFailure: (cause) =>
						Effect.sync(() => {
							if (!active || Cause.hasInterruptsOnly(cause)) return;
							const failure = Cause.squash(cause);
							if (failure instanceof TerminalOutputSinkFailed) {
								failResource("output-failed", failure.message);
								return;
							}
							if (failure instanceof RecoverTerminalOutput) {
								failResource(
									"output-failed",
									"Terminal output remained discontinuous after replay.",
								);
								return;
							}
							if (hasErrorTag(failure, "PtyNotFoundError")) {
								failResource(
									"process-missing",
									"Terminal process is unavailable.",
								);
								return;
							}
							state = reconnectTerminalResource(state);
							emitState("synchronizing");
							options.reportConnectionFailure(
								ref.environmentId,
								context.generation,
								failure,
							);
						}),
					onSuccess: () =>
						Effect.sync(() => {
							if (
								!active ||
								state.phase === "exited" ||
								state.phase === "failed"
							) {
								return;
							}
							failResource(
								"stream-ended",
								"Terminal output stream ended before the process exited.",
							);
						}),
				}),
			);
			fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(program)));
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};
