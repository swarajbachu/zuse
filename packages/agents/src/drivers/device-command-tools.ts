import { setTimeout as delay } from "node:timers/promises";
import type { DeviceBridgeAction, DeviceBridgeResult } from "@zuse/contracts";

export const DEVICE_COMMAND_TOOL_TIMEOUT_SECONDS = 3600;

export interface DeviceCommandClient {
	request(action: DeviceBridgeAction): Promise<DeviceBridgeResult>;
}
let defaultClient: DeviceCommandClient | undefined;
/** Installed only by an authenticated cloud runtime, never by model input. */
export const setDefaultDeviceCommandClient = (
	client: DeviceCommandClient | undefined,
): void => {
	defaultClient = client;
};
export const getDefaultDeviceCommandClient = ():
	| DeviceCommandClient
	| undefined => defaultClient;
const inputSchema = (
	properties: Record<string, unknown>,
	required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
export const DEVICE_COMMAND_TOOLS = [
	{
		name: "local_device",
		description:
			"Get the desktop computer bound to this cloud chat, its local home directory, and command status. Local execution requires separate user approval.",
		inputSchema: inputSchema({}),
	},
	{
		name: "local_command_execute",
		description:
			"Request a shell command on the user's bound desktop. Waits for the user to approve or deny, then waits for command completion and returns output. Do not send a separate confirmation message or report a pending ID. Permission is enforced by the desktop even in unrestricted mode. Commands can read and modify local files. Use an absolute LOCAL working directory.",
		inputSchema: inputSchema(
			{ command: { type: "string" }, cwd: { type: "string" } },
			["command", "cwd"],
		),
	},
	{
		name: "local_command_status",
		description:
			"Read local command output, approval state, and exit status. Do not re-run a command whose outcome is unknown.",
		inputSchema: inputSchema({ id: { type: "string" } }, ["id"]),
	},
	{
		name: "local_command_cancel",
		description: "Cancel a local command and terminate its process group.",
		inputSchema: inputSchema({ id: { type: "string" } }, ["id"]),
	},
];
export const handleDeviceCommandTool = async (
	client: DeviceCommandClient,
	name: string,
	args: Record<string, unknown>,
	planMode: boolean,
	signal?: AbortSignal,
) => {
	let action: DeviceBridgeAction;
	if (name === "local_device") action = { _tag: "status" };
	else if (name === "local_command_execute") {
		if (planMode)
			throw new Error("Local command execution is unavailable in plan mode.");
		if (typeof args.command !== "string" || typeof args.cwd !== "string")
			throw new Error("command and cwd are required");
		action = {
			_tag: "execute",
			input: { id: crypto.randomUUID(), command: args.command, cwd: args.cwd },
		};
	} else {
		if (typeof args.id !== "string") throw new Error("id is required");
		action = {
			_tag: name === "local_command_cancel" ? "cancel" : "poll",
			id: args.id,
		};
	}
	signal?.throwIfAborted();
	let result = await client.request(action);
	if (action._tag === "execute") {
		try {
			while (
				"state" in result &&
				(result.state === "pending" || result.state === "running")
			) {
				await delay(1000, undefined, { signal });
				result = await client.request({ _tag: "poll", id: action.input.id });
			}
			signal?.throwIfAborted();
		} catch (cause) {
			// Stop only this command; cancellation never authorizes or replays it.
			await client
				.request({ _tag: "cancel", id: action.input.id })
				.catch(() => undefined);
			throw new Error(
				`Local command ${action.input.id} was interrupted. Its outcome may be unknown; inspect its status before requesting another command.`,
				{ cause },
			);
		}
	}
	return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
};
