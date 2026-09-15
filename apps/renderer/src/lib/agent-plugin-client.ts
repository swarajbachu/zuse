import {
	type AgentPluginCatalog,
	type AgentPluginCommand,
	type AgentPluginDetails,
	CommandId,
	EnvironmentId,
} from "@zuse/contracts";
import { dispatchEnvironmentShellCommand } from "./environment-shell-client-bus.ts";
import { getLocalEnvironmentId } from "./rpc-client.ts";

const request = async <Result>(
	kind: string,
	payload: unknown,
): Promise<Result> => {
	const result = await dispatchEnvironmentShellCommand<unknown, Result>({
		environmentId: EnvironmentId.make(getLocalEnvironmentId()),
		kind,
		commandId: CommandId.make(`agent-plugin:${crypto.randomUUID()}`),
		payload,
	});
	return result.result;
};
export const agentPluginActions = {
	catalog: () => request<AgentPluginCatalog>("agentPlugin.catalog", {}),
	inspect: (plugin: { marketplace: string; name: string }) =>
		request<AgentPluginDetails>("agentPlugin.inspect", plugin),
	execute: (command: AgentPluginCommand) =>
		request<{ message: string }>("agentPlugin.execute", command),
};
