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
	normalizeTerminalCatalog,
	type TerminalCatalog,
} from "@zuse/client-runtime/terminal-catalog";
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
	type PtyCatalog,
	type PtyCommand,
	type PtyId,
	type PtyOwnerId,
	type PtyOwnership,
	type PtySummary,
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
	ownerId?: PtyOwnerId;
	commandId?: CommandId;
}): ClientCommand<
	Readonly<{ ptyId: PtyId; data: string; ownerId?: PtyOwnerId }>,
	void
> => ({
	kind: "pty.write",
	commandId: input.commandId ?? CommandId.make(crypto.randomUUID()),
	environmentId: input.ref.environmentId,
	resource: terminalResourceKey(input.ref),
	payload: {
		ptyId: input.ref.terminalId,
		data: input.data,
		ownerId: input.ownerId,
	},
	retry: "never",
	createdAt: Date.now(),
});

export type TerminalOpenInput = Readonly<{
	cwd: string;
	cols: number;
	rows: number;
	command?: PtyCommand;
	ownership?: PtyOwnership;
}>;

const terminalCommand = <Payload, Result>(input: {
	kind:
		| "pty.open"
		| "pty.list"
		| "pty.write"
		| "pty.resize"
		| "pty.close"
		| "pty.closeOwned"
		| "pty.rename"
		| "pty.restart";
	environmentId: EnvironmentId;
	resource: TerminalResourceKey | null;
	payload: Payload;
	commandId?: CommandId;
	retry?: "safe" | "never";
}): ClientCommand<Payload, Result> => ({
	kind: input.kind,
	commandId: input.commandId ?? CommandId.make(crypto.randomUUID()),
	environmentId: input.environmentId,
	resource: input.resource,
	payload: input.payload,
	retry: input.retry ?? "never",
	createdAt: Date.now(),
});

export const terminalOpenCommand = (input: {
	environmentId: EnvironmentId;
	payload: TerminalOpenInput;
	commandId?: CommandId;
}): ClientCommand<
	TerminalOpenInput,
	{ readonly ptyId: PtyId; readonly processEpoch: string }
> =>
	terminalCommand({
		kind: "pty.open",
		environmentId: input.environmentId,
		resource: null,
		payload: input.payload,
		commandId: input.commandId,
		retry: input.payload.ownership?.openToken === undefined ? "never" : "safe",
	});

export const terminalCloseOwnedCommand = (input: {
	environmentId: EnvironmentId;
	ownerId: PtyOwnerId;
	commandId?: CommandId;
}): ClientCommand<
	Readonly<{ ownerId: PtyOwnerId }>,
	Readonly<{ closed: number }>
> =>
	terminalCommand({
		kind: "pty.closeOwned",
		environmentId: input.environmentId,
		resource: null,
		payload: { ownerId: input.ownerId },
		commandId: input.commandId,
		retry: "safe",
	});

export const terminalCloseCommand = (input: {
	ref: TerminalRef;
	ownerId?: PtyOwnerId;
	commandId?: CommandId;
}): ClientCommand<Readonly<{ ptyId: PtyId; ownerId?: PtyOwnerId }>, void> =>
	terminalCommand({
		kind: "pty.close",
		environmentId: input.ref.environmentId,
		resource: terminalResourceKey(input.ref),
		payload: { ptyId: input.ref.terminalId, ownerId: input.ownerId },
		commandId: input.commandId,
		retry: input.ownerId === undefined ? "never" : "safe",
	});

export const terminalRestartCommand = (input: {
	ref: TerminalRef;
	ownerId?: PtyOwnerId;
	expectedProcessEpoch?: string;
	commandId?: CommandId;
}): ClientCommand<
	Readonly<{
		ptyId: PtyId;
		ownerId?: PtyOwnerId;
		expectedProcessEpoch?: string;
	}>,
	{ readonly ptyId: PtyId; readonly processEpoch: string }
> =>
	terminalCommand({
		kind: "pty.restart",
		environmentId: input.ref.environmentId,
		resource: terminalResourceKey(input.ref),
		payload: {
			ptyId: input.ref.terminalId,
			ownerId: input.ownerId,
			expectedProcessEpoch: input.expectedProcessEpoch,
		},
		commandId: input.commandId,
		// Restart is idempotent only as a compare-and-set operation. A legacy
		// request without an epoch still means "spawn again" on every application.
		retry: input.expectedProcessEpoch === undefined ? "never" : "safe",
	});

export type RetainedTerminalResource = Readonly<{
	key: TerminalResourceKey;
	lease: ResourceLease;
}>;

export const terminalSinkId = (ref: TerminalRef): string =>
	resourceKeyId(terminalResourceKey(ref));

type RetainedSink = {
	readonly sink: TerminalOutputSink;
	readonly ownerId: PtyOwnerId | undefined;
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
				streamOutput: (client, ref, afterSequence, processEpoch) =>
					client["pty.output"]({
						ptyId: ref.terminalId,
						afterSequence,
						processEpoch,
						ownerId: sinks.get(resourceKeyId(key))?.ownerId,
					}),
				reportConnectionFailure,
			}) as ResourceDriver<MemoizeClient, unknown>);

registerRendererResourceDriver("terminal", terminalDriverFactory);

export const retainTerminalResource = (
	ref: TerminalRef,
	sink: TerminalOutputSink,
	ownerId?: PtyOwnerId,
): RetainedTerminalResource => {
	const key = terminalResourceKey(ref);
	const id = resourceKeyId(key);
	const existing = sinks.get(id);
	if (
		existing !== undefined &&
		(existing.sink !== sink || existing.ownerId !== ownerId)
	) {
		throw new Error(`Terminal sink already retained: ${id}`);
	}
	if (existing === undefined) sinks.set(id, { sink, ownerId, retainers: 1 });
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
	ownerId?: PtyOwnerId,
): Promise<void> => {
	await getRendererClientBus().dispatch(
		terminalInputCommand({ ref, data, ownerId }),
	);
};

export const dispatchTerminalOpen = async (
	environmentId: EnvironmentId,
	input: TerminalOpenInput,
): Promise<{ readonly ptyId: PtyId; readonly processEpoch: string }> =>
	(
		await getRendererClientBus().dispatch(
			terminalOpenCommand({
				environmentId,
				payload: input,
			}),
		)
	).result;

export const dispatchTerminalCloseOwned = async (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): Promise<number> =>
	(
		await getRendererClientBus().dispatch(
			terminalCloseOwnedCommand({ environmentId, ownerId }),
		)
	).result.closed;

export const dispatchTerminalResize = async (
	ref: TerminalRef,
	cols: number,
	rows: number,
	ownerId?: PtyOwnerId,
): Promise<void> => {
	await getRendererClientBus().dispatch(
		terminalCommand({
			kind: "pty.resize",
			environmentId: ref.environmentId,
			resource: terminalResourceKey(ref),
			payload: { ptyId: ref.terminalId, cols, rows, ownerId },
		}),
	);
};

export const dispatchTerminalClose = async (
	ref: TerminalRef,
	ownerId?: PtyOwnerId,
): Promise<void> => {
	await getRendererClientBus().dispatch(terminalCloseCommand({ ref, ownerId }));
};

export const dispatchTerminalRename = async (
	ref: TerminalRef,
	label: string | null,
	ownerId?: PtyOwnerId,
): Promise<PtySummary> =>
	(
		await getRendererClientBus().dispatch(
			terminalCommand<
				Readonly<{
					ptyId: PtyId;
					label: string | null;
					ownerId?: PtyOwnerId;
				}>,
				PtySummary
			>({
				kind: "pty.rename",
				environmentId: ref.environmentId,
				resource: terminalResourceKey(ref),
				payload: { ptyId: ref.terminalId, label, ownerId },
			}),
		)
	).result;

export const dispatchTerminalRestart = async (
	ref: TerminalRef,
	ownerId?: PtyOwnerId,
	expectedProcessEpoch?: string,
): Promise<{ readonly ptyId: PtyId; readonly processEpoch: string }> => {
	const bus = getRendererClientBus();
	const receipt = await bus.dispatch(
		terminalRestartCommand({ ref, ownerId, expectedProcessEpoch }),
	);
	// An exited terminal's old stream has already completed. Restart its retained
	// driver so it can observe the replacement epoch and replay from sequence 0.
	bus.restart(terminalResourceKey(ref));
	return receipt.result;
};

export const terminalResourceSnapshot = (ref: TerminalRef) =>
	getRendererClientBus().snapshot(terminalResourceKey(ref));

export const listOwnedTerminals = async (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): Promise<TerminalCatalog> => {
	const receipt = await getRendererClientBus().dispatch(
		terminalCommand<
			Readonly<{ ownerId: PtyOwnerId; includePolicy: true }>,
			PtyCatalog | ReadonlyArray<PtySummary>
		>({
			kind: "pty.list",
			environmentId,
			resource: null,
			payload: { ownerId, includePolicy: true },
		}),
	);
	return normalizeTerminalCatalog(receipt.result);
};
