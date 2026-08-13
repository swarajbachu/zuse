import type {
	ResourceDriver,
	ResourceLease,
} from "@zuse/client-runtime/client-bus";
import type { ClientCommand } from "@zuse/client-runtime/client-persistence";
import {
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
	type TerminalRef,
} from "@zuse/client-runtime/resource-ref";
import {
	failTerminalResource,
	initialTerminalResourceState,
	reconnectTerminalResource,
	reduceTerminalOutput,
	type TerminalResourceState,
} from "@zuse/client-runtime/terminal-resource";
import {
	CommandId,
	type EnvironmentId,
	type PtyCommand,
	type PtyEvent,
	type PtyId,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

export type TerminalResourceKey = ResourceKey<TerminalResourceState>;

export type TerminalOutputSink = Readonly<{
	write: (bytes: string) => Promise<void>;
	exited: (exitCode: number | null, signal: number | null) => Promise<void>;
}>;

export type TerminalDriverClient = Pick<MemoizeClient, "pty.output">;

type TerminalDriverOptions = Readonly<{
	sinkFor: (key: TerminalResourceKey) => TerminalOutputSink | null;
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

const terminalRefFromKey = (key: ResourceKey<unknown>): TerminalRef | null =>
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

/**
 * Owns PTY stream lifecycle and cursor validation. Payload bytes bypass the
 * canonical reducer and are acknowledged by the sink before its cursor moves.
 */
export const makeTerminalResourceDriver = (
	options: TerminalDriverOptions,
): ResourceDriver<TerminalDriverClient, TerminalResourceState> => {
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

			const emitState = (sync: "synchronizing" | "live" | "failed"): boolean =>
				(() => {
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
				})();

			emitState("synchronizing");

			const failResource = (
				kind: Parameters<typeof failTerminalResource>[1]["kind"],
				message: string,
			): void => {
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

				const commit = (): void => {
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
					}).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (context.isCurrent()) commit();
							}),
						),
					);
				}
				if (event._tag === "exit") {
					return Effect.tryPromise({
						try: () => sink.exited(event.exitCode, event.signal),
						catch: (cause) => new TerminalOutputSinkFailed(messageOf(cause)),
					}).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (context.isCurrent()) commit();
							}),
						),
					);
				}
				commit();
				return Effect.void;
			};

			const runOutput = (): Effect.Effect<void, unknown> =>
				Stream.runForEach(
					context.client["pty.output"]({
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

export const terminalInputCommand = (input: {
	ref: TerminalRef;
	data: string;
	commandId?: CommandId;
}): ClientCommand<Readonly<{ ptyId: PtyId; data: string }>, void> => ({
	kind: "pty.write",
	commandId: input.commandId ?? CommandId.make(crypto.randomUUID()),
	environmentId: input.ref.environmentId,
	resource: terminalResourceKey(input.ref),
	payload: { ptyId: input.ref.terminalId, data: input.data },
	retry: "never",
	createdAt: Date.now(),
});

export type TerminalOpenInput = Readonly<{
	cwd: string;
	cols: number;
	rows: number;
	command?: PtyCommand;
}>;

const terminalCommand = <Payload, Result>(input: {
	kind: "pty.open" | "pty.write" | "pty.resize" | "pty.close";
	environmentId: EnvironmentId;
	resource: TerminalResourceKey | null;
	payload: Payload;
}): ClientCommand<Payload, Result> => ({
	kind: input.kind,
	commandId: CommandId.make(crypto.randomUUID()),
	environmentId: input.environmentId,
	resource: input.resource,
	payload: input.payload,
	retry: "never",
	createdAt: Date.now(),
});

export type RetainedTerminalResource = Readonly<{
	key: TerminalResourceKey;
	lease: ResourceLease;
}>;

export const terminalSinkId = (ref: TerminalRef): string =>
	resourceKeyId(terminalResourceKey(ref));

type RetainedSink = {
	readonly sink: TerminalOutputSink;
	retainers: number;
};

const sinks = new Map<string, RetainedSink>();

const reportConnectionFailure = (
	environmentId: EnvironmentId,
	generation: number,
	cause: unknown,
): void => {
	getRendererClientBus().reportConnectionFault(
		environmentId,
		{ phase: "failed", message: messageOf(cause) },
		generation,
	);
};

const terminalDriverFactory = (key: ResourceKey<unknown>) =>
	key.kind !== "terminal"
		? null
		: (makeTerminalResourceDriver({
				sinkFor: (terminalKey) =>
					sinks.get(resourceKeyId(terminalKey))?.sink ?? null,
				reportConnectionFailure,
			}) as ResourceDriver<MemoizeClient, unknown>);

registerRendererResourceDriver("terminal", terminalDriverFactory);

export const retainTerminalResource = (
	ref: TerminalRef,
	sink: TerminalOutputSink,
): RetainedTerminalResource => {
	const key = terminalResourceKey(ref);
	const id = resourceKeyId(key);
	const existing = sinks.get(id);
	if (existing !== undefined && existing.sink !== sink) {
		throw new Error(`Terminal sink already retained: ${id}`);
	}
	if (existing === undefined) sinks.set(id, { sink, retainers: 1 });
	else existing.retainers += 1;
	const lease = getRendererClientBus().retain(key, { activation: "connect" });
	let released = false;
	return {
		key,
		lease: {
			activate: lease.activate,
			release: () => {
				if (released) return;
				released = true;
				lease.release();
				const retained = sinks.get(id);
				if (retained?.sink !== sink) return;
				retained.retainers -= 1;
				if (retained.retainers === 0) sinks.delete(id);
			},
		},
	};
};

export const dispatchTerminalInput = async (
	ref: TerminalRef,
	data: string,
): Promise<void> => {
	await getRendererClientBus().dispatch(terminalInputCommand({ ref, data }));
};

export const dispatchTerminalOpen = async (
	environmentId: EnvironmentId,
	input: TerminalOpenInput,
): Promise<{ readonly ptyId: PtyId }> =>
	(
		await getRendererClientBus().dispatch(
			terminalCommand<TerminalOpenInput, { readonly ptyId: PtyId }>({
				kind: "pty.open",
				environmentId,
				resource: null,
				payload: input,
			}),
		)
	).result;

export const dispatchTerminalResize = async (
	ref: TerminalRef,
	cols: number,
	rows: number,
): Promise<void> => {
	await getRendererClientBus().dispatch(
		terminalCommand({
			kind: "pty.resize",
			environmentId: ref.environmentId,
			resource: terminalResourceKey(ref),
			payload: { ptyId: ref.terminalId, cols, rows },
		}),
	);
};

export const dispatchTerminalClose = async (
	ref: TerminalRef,
): Promise<void> => {
	await getRendererClientBus().dispatch(
		terminalCommand({
			kind: "pty.close",
			environmentId: ref.environmentId,
			resource: terminalResourceKey(ref),
			payload: { ptyId: ref.terminalId },
		}),
	);
};

export const terminalResourceSnapshot = (ref: TerminalRef) =>
	getRendererClientBus().snapshot(terminalResourceKey(ref));
