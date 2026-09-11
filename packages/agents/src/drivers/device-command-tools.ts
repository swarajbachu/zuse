import type { DeviceBridgeAction, DeviceBridgeResult } from "@zuse/contracts";

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
			"Request a shell command on the user's bound desktop. Returns a command ID; use local_command_status for output and completion. Permission is enforced by the desktop even in unrestricted mode. Commands can read and modify local files. Use an absolute LOCAL working directory.",
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
	const result = await client.request(action);
	return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
};
