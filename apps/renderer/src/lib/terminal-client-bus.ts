import type {
	ResourceDriver,
	ResourceLease,
} from "@zuse/client-runtime/client-bus";
import type { ClientCommand } from "@zuse/client-runtime/client-persistence";
import {
	type ResourceKey,
	resourceKeyId,
	type TerminalRef,
} from "@zuse/client-runtime/resource-ref";
import {
	makeTerminalResourceDriver,
	type TerminalOutputSink,
	type TerminalResourceKey,
	terminalResourceKey,
} from "@zuse/client-runtime/terminal-resource-driver";

export type { TerminalDriverClient } from "@zuse/client-runtime/terminal-resource-driver";
export {
	makeTerminalResourceDriver,
	terminalResourceKey,
} from "@zuse/client-runtime/terminal-resource-driver";

import {
	CommandId,
	type EnvironmentId,
	type PtyCommand,
	type PtyId,
} from "@zuse/contracts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

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
		: (makeTerminalResourceDriver<MemoizeClient>({
				sinkFor: (terminalKey) =>
					sinks.get(resourceKeyId(terminalKey))?.sink ?? null,
				streamOutput: (client, ref, afterSequence) =>
					client["pty.output"]({
						ptyId: ref.terminalId,
						afterSequence,
					}),
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
