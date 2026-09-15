import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

const Text = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4096),
);
export const AgentPluginLocator = Schema.Struct({
	marketplace: Text,
	name: Text,
});
export const AgentPlugin = Schema.Struct({
	id: Text,
	name: Text,
	marketplace: Text,
	displayName: Schema.String,
	description: Schema.String,
	installed: Schema.Boolean,
	enabled: Schema.Boolean,
	available: Schema.Boolean,
	installable: Schema.Boolean,
	capabilities: Schema.Array(Schema.String),
});
export type AgentPlugin = typeof AgentPlugin.Type;
export const AgentPluginCatalog = Schema.Struct({
	plugins: Schema.Array(AgentPlugin),
	marketplaces: Schema.Array(
		Schema.Struct({ name: Text, local: Schema.Boolean }),
	),
	errors: Schema.Array(Schema.String),
});
export type AgentPluginCatalog = typeof AgentPluginCatalog.Type;
export const AgentPluginDetails = Schema.Struct({
	description: Schema.String,
	skills: Schema.Array(Schema.String),
	hooks: Schema.Array(Schema.String),
	mcpServers: Schema.Array(Schema.String),
	apps: Schema.Array(Schema.String),
});
export type AgentPluginDetails = typeof AgentPluginDetails.Type;
export const AgentPluginCommand = Schema.Union([
	Schema.TaggedStruct("install", { plugin: AgentPluginLocator }),
	Schema.TaggedStruct("uninstall", { plugin: AgentPluginLocator }),
	Schema.TaggedStruct("set-enabled", {
		plugin: AgentPluginLocator,
		enabled: Schema.Boolean,
	}),
	Schema.TaggedStruct("add-marketplace", { source: Text }),
	Schema.TaggedStruct("update-marketplace", { marketplace: Text }),
	Schema.TaggedStruct("remove-marketplace", { marketplace: Text }),
]);
export type AgentPluginCommand = typeof AgentPluginCommand.Type;
export class AgentPluginError extends Schema.TaggedErrorClass<AgentPluginError>()(
	"AgentPluginError",
	{ reason: Schema.String },
) {}
export const AgentPluginCatalogRpc = Rpc.make("agentPlugin.catalog", {
	success: AgentPluginCatalog,
	error: AgentPluginError,
});
export const AgentPluginInspectRpc = Rpc.make("agentPlugin.inspect", {
	payload: AgentPluginLocator,
	success: AgentPluginDetails,
	error: AgentPluginError,
});
export const AgentPluginExecuteRpc = Rpc.make("agentPlugin.execute", {
	payload: AgentPluginCommand,
	success: Schema.Struct({ message: Schema.String }),
	error: AgentPluginError,
});
