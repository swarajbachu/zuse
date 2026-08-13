import { type CommandId, EnvironmentId } from "@zuse/contracts";

import { dispatchEnvironmentShellCommand } from "./environment-shell-client-bus.ts";

const LOCAL_DEVICE_ENVIRONMENT_ID = EnvironmentId.make("local");

/**
 * Dispatches device-host operations through the same command plane while
 * keeping their intentionally local target explicit.
 */
export const dispatchLocalDeviceCommand = <Payload, Result>(
	kind: string,
	payload: Payload,
): Promise<Result> =>
	dispatchEnvironmentShellCommand<Payload, Result>({
		environmentId: LOCAL_DEVICE_ENVIRONMENT_ID,
		kind,
		commandId: crypto.randomUUID() as CommandId,
		payload,
	}).then(({ result }) => result);

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
