import { PluginToolRequest } from "@zuse/contracts";
import { Schema } from "effect";
import { getToolPolicy } from "../kernel/policy.ts";
import type { OrchestrationPermissionOptions } from "./orchestration-tools.ts";

export interface PluginClient {
	request(input: PluginToolRequest): Promise<unknown>;
}
export type PluginClientFactory = () => Promise<PluginClient | undefined>;
let factory: PluginClientFactory | undefined;
export const setDefaultPluginClientFactory = (
	value: PluginClientFactory | undefined,
) => {
	factory = value;
};
export const getDefaultPluginClient = () =>
	factory?.() ?? Promise.resolve(undefined);
export { PLUGIN_MCP_TOOLS as PLUGIN_TOOLS } from "@zuse/contracts";
export type PluginPermissionOptions = OrchestrationPermissionOptions;

export const handlePluginTool = async (
	name: string,
	args: Record<string, unknown>,
	client: PluginClient,
	permissions: PluginPermissionOptions,
) => {
	const action =
		name === "plugins_list"
			? "list"
			: name === "plugins_search"
				? "search"
				: name === "plugins_schema"
					? "schema"
					: name === "plugins_call"
						? "call"
						: undefined;
	if (!action) throw new Error("Unknown plugin tool");
	const input = Schema.decodeUnknownSync(PluginToolRequest)({
		...args,
		action,
	});
	if (input.action === "call") {
		const policy = getToolPolicy(
			"other",
			permissions.getRuntimeMode(),
			permissions.getPermissionMode(),
		);
		if (policy.kind === "auto-deny")
			throw new Error("Plugin calls are unavailable in plan mode.");
		if (policy.kind !== "auto-allow") {
			const decision = await permissions.requestPermission(
				{
					_tag: "Other",
					tool: input.address,
					summary: `Call connected plugin tool ${input.address} with ${JSON.stringify(input.arguments).slice(0, 2000)}`,
				},
				{ forcePrompt: false },
			);
			if (decision._tag === "Deny") throw new Error("Plugin call denied.");
		}
	}
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(await client.request(input)),
			},
		],
	};
};

export const createHttpPluginClient = (
	url: string,
	token: () => Promise<string>,
): PluginClient => ({
	async request(input) {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${await token()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok)
			throw new Error(
				"Plugin request failed. Check Plugins in the workspace this chat belongs to.",
			);
		return response.json();
	},
});

/** Revocable session auth; AUTH survives provider shell filters for KEY/SECRET/TOKEN. */
export const pluginCliEnv = (endpoint: string, token: string) => ({
	ZUSE_PLUGIN_URL: new URL("/plugins", endpoint).href,
	ZUSE_PLUGIN_AUTH: token,
});
