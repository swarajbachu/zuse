import {
	type PermissionDecision,
	type PermissionKind,
	type PermissionMode,
	type RuntimeMode,
	SimulatorId,
} from "@zuse/contracts";
import { Context, Schema } from "effect";
import { getToolPolicy } from "../kernel/policy.ts";
export interface SimulatorToolsClient {
	call(
		sessionId: string,
		name: string,
		args: unknown,
		signal: AbortSignal,
	): Promise<{
		content: Array<
			| { type: "text"; text: string }
			| { type: "image"; data: string; mimeType: "image/png" }
		>;
	}>;
}
export class SimulatorTools extends Context.Service<
	SimulatorTools,
	SimulatorToolsClient
>()("@zuse/agents/SimulatorTools") {}
export interface SimulatorToolOptions {
	readonly client: SimulatorToolsClient;
	readonly requestPermission: (
		kind: PermissionKind,
		options: { forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
}
const target = { type: "string", pattern: "^[A-Za-z0-9-]{1,128}$" };
export const SIMULATOR_MCP_TOOLS = [
	{
		name: "device_list",
		description:
			"List iOS simulators and Android emulators on this Zuse environment, with their platform. Device support and agent access must be enabled in the Simulator panel.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "device_open",
		description:
			"Open an iOS simulator or Android emulator in this chat's Simulator panel so the user can watch, booting it if needed. Android emulators get a new id (their serial) when they boot; use the returned device id afterwards. Returns a pinned agent-device launcher for snapshots and interactions; its target is fixed to this device.",
		inputSchema: {
			type: "object",
			properties: { deviceId: target },
			required: ["deviceId"],
			additionalProperties: false,
		},
	},
	{
		name: "device_screenshot",
		description:
			"Return a PNG screenshot of a simulator or emulator opened in this chat.",
		inputSchema: {
			type: "object",
			properties: { deviceId: target },
			required: ["deviceId"],
			additionalProperties: false,
		},
	},
	{
		name: "device_close",
		description:
			"Close this chat's device session. Set shutdown to also power off the simulator; otherwise the device keeps running.",
		inputSchema: {
			type: "object",
			properties: { deviceId: target, shutdown: { type: "boolean" } },
			required: ["deviceId"],
			additionalProperties: false,
		},
	},
];
export const SimulatorToolTarget = Schema.Struct({
	deviceId: SimulatorId,
	shutdown: Schema.optional(Schema.Boolean),
});
export async function handleSimulatorTool(
	name: string,
	args: unknown,
	options: SimulatorToolOptions,
	sessionId: string,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (isSimulatorMutation(name)) {
		const policy = getToolPolicy(
			"other",
			options.getRuntimeMode(),
			options.getPermissionMode(),
		);
		if (policy.kind === "auto-deny")
			throw new Error("Device actions are blocked in plan mode.");
		if (policy.kind === "prompt") {
			const decision = await options.requestPermission(
				{
					_tag: "Other",
					tool: name,
					summary: "Control this chat's simulator or emulator",
				},
				{ forcePrompt: false },
			);
			if (decision._tag === "Deny") throw new Error("Device action denied.");
			signal.throwIfAborted();
		}
	}
	return options.client.call(sessionId, name, args, signal);
}

export const isSimulatorMutation = (name: string) =>
	name === "device_open" || name === "device_close";
