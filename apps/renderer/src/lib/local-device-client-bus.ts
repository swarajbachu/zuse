import type { ClientCommand } from "@zuse/client-runtime/client-persistence";
import { type CommandId, EnvironmentId } from "@zuse/contracts";

import { getLocalEnvironmentId } from "./rpc-client.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

export const localDeviceCommand = <Payload, Result>(
	environmentId: EnvironmentId,
	kind: string,
	payload: Payload,
	commandId: CommandId,
): ClientCommand<Payload, Result> => ({
	environmentId,
	kind,
	commandId,
	// Device-host RPCs share the environment connection, but they do not mutate
	// the environment-shell resource. Publishing their transient command state to
	// that cell can re-enter catalog subscribers while the command is dispatching.
	resource: null,
	payload,
	retry: "never",
	createdAt: Date.now(),
});

/**
 * Dispatches device-host operations through the same command plane while
 * keeping their intentionally local target explicit.
 */
export const dispatchLocalDeviceCommand = <Payload, Result>(
	kind: string,
	payload: Payload,
): Promise<Result> =>
	getRendererClientBus()
		.dispatch(
			localDeviceCommand<Payload, Result>(
				EnvironmentId.make(getLocalEnvironmentId()),
				kind,
				payload,
				crypto.randomUUID() as CommandId,
			),
		)
		.then(({ result }) => result);

export const readLocalExternalFile = <Result>(path: string): Promise<Result> =>
	dispatchLocalDeviceCommand<{ readonly path: string }, Result>(
		"fs.readExternalFile",
		{ path },
	);

export const writeLocalExternalFile = <Result>(input: {
	readonly path: string;
	readonly content: string;
	readonly expectedMtime: string;
}): Promise<Result> =>
	dispatchLocalDeviceCommand<typeof input, Result>(
		"fs.writeExternalFile",
		input,
	);
