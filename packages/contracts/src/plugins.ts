import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";

/** A tenant is a personal account or an organization, never a runtime. */
export const PluginTenant = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literals(["personal", "organization"]),
	name: Schema.String,
});
export type PluginTenant = typeof PluginTenant.Type;

/** Display metadata only. Endpoints and auth policy stay server-owned.
 * Newer fields default when absent so desktop and API versions can skew. */
export const PluginDefinition = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	/** Provider domain, used for the catalog icon. */
	domain: Schema.String.pipe(
		Schema.withConstructorDefault(Effect.succeed("")),
		Schema.withDecodingDefaultType(Effect.succeed("")),
	),
	category: Schema.NullOr(Schema.String).pipe(
		Schema.withConstructorDefault(Effect.succeed(null)),
		Schema.withDecodingDefaultType(Effect.succeed(null)),
	),
	/** Hand-picked, well-known entries shown first in Browse. */
	featured: Schema.Boolean.pipe(
		Schema.withConstructorDefault(Effect.succeed(false)),
		Schema.withDecodingDefaultType(Effect.succeed(false)),
	),
});
export type PluginDefinition = typeof PluginDefinition.Type;

export const PluginConnection = Schema.Struct({
	id: Schema.String,
	pluginId: Schema.String,
	label: Schema.String,
	owner: Schema.Literals(["user", "organization"]),
	state: Schema.Literals(["connecting", "connected", "needs-auth", "error"]),
	createdAt: Schema.Number,
	/** Off keeps the credentials but hides the plugin's tools from agents. */
	enabled: Schema.Boolean.pipe(
		Schema.withConstructorDefault(Effect.succeed(true)),
		Schema.withDecodingDefaultType(Effect.succeed(true)),
	),
});
export type PluginConnection = typeof PluginConnection.Type;

export const PluginSnapshot = Schema.Struct({
	/** Organization members use connections; admins manage them. */
	canManage: Schema.Boolean.pipe(
		Schema.withConstructorDefault(Effect.succeed(true)),
		Schema.withDecodingDefaultType(Effect.succeed(true)),
	),
	kind: Schema.Literal("snapshot"),
	tenants: Schema.Array(PluginTenant),
	tenantId: Schema.String,
	endpoint: Schema.String,
	catalog: Schema.Array(PluginDefinition),
	connections: Schema.Array(PluginConnection),
});
export type PluginSnapshot = typeof PluginSnapshot.Type;

/** Desktop loopback ports registered by the shell; mirrors the sign-in ports. */
export const PLUGIN_CALLBACK_PORTS = [8976, 8977, 8978, 8979] as const;
/** Where the provider callback hands the one-use ticket back to Zuse. */
export const PluginReturnTo = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("web") }),
	Schema.Struct({
		kind: Schema.Literal("desktop"),
		port: Schema.Literals(PLUGIN_CALLBACK_PORTS),
	}),
]);
export type PluginReturnTo = typeof PluginReturnTo.Type;

export const PluginAttempt = Schema.Struct({
	kind: Schema.Literal("attempt"),
	id: Schema.String,
	connectionId: Schema.String,
	state: Schema.Literals(["pending", "connected", "failed", "cancelled"]),
	authorizationUrl: Schema.NullOr(Schema.String),
	expiresAt: Schema.Number,
});
export type PluginAttempt = typeof PluginAttempt.Type;

export const PluginRequest = Schema.Union([
	Schema.Struct({
		action: Schema.Literal("list"),
		tenantId: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		action: Schema.Literal("connect"),
		tenantId: Schema.String,
		pluginId: Schema.String,
		label: Schema.String,
		requestId: Schema.String,
		returnTo: Schema.optional(PluginReturnTo),
	}),
	Schema.Struct({
		action: Schema.Literal("poll"),
		tenantId: Schema.String,
		attemptId: Schema.String,
	}),
	Schema.Struct({
		action: Schema.Literal("cancel"),
		tenantId: Schema.String,
		attemptId: Schema.String,
	}),
	Schema.Struct({
		action: Schema.Literal("complete"),
		tenantId: Schema.String,
		ticket: Schema.String,
	}),
	Schema.Struct({
		action: Schema.Literal("disconnect"),
		tenantId: Schema.String,
		connectionId: Schema.String,
	}),
	Schema.Struct({
		action: Schema.Literal("setEnabled"),
		tenantId: Schema.String,
		connectionId: Schema.String,
		enabled: Schema.Boolean,
	}),
]);
export type PluginRequest = typeof PluginRequest.Type;
export const PluginResponse = Schema.Union([
	PluginSnapshot,
	PluginAttempt,
	Schema.Struct({ kind: Schema.Literal("ok") }),
]);
export type PluginResponse = typeof PluginResponse.Type;

export const PluginsRequestRpc = Rpc.make("plugins.request", {
	payload: PluginRequest,
	success: PluginResponse,
	error: CloudWorkspaceOpError,
});

export const PluginToolRequest = Schema.Union([
	Schema.Struct({ action: Schema.Literal("list") }),
	Schema.Struct({ action: Schema.Literal("search"), query: Schema.String }),
	Schema.Struct({ action: Schema.Literal("schema"), address: Schema.String }),
	Schema.Struct({
		action: Schema.Literal("call"),
		address: Schema.String,
		arguments: Schema.Record(Schema.String, Schema.Unknown),
	}),
]);
export type PluginToolRequest = typeof PluginToolRequest.Type;

export const PLUGIN_MCP_TOOLS = [
	{
		name: "plugins_list",
		description:
			"List enabled, connected Zuse plugins and account labels. Optional: search directly when you already know the service or task.",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: "plugins_search",
		description:
			"Search the current workspace's connected Zuse plugins directly by service and task, for example 'linear issue'. No listing or empty query is needed first. Returns exact tool addresses; use plugins_schema then plugins_call. An empty result means no matching tools; use plugins_list to check connected services before concluding none are connected.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "plugins_schema",
		description:
			"Get the input schema for a connected plugin tool by its exact address.",
		inputSchema: {
			type: "object",
			properties: { address: { type: "string" } },
			required: ["address"],
			additionalProperties: false,
		},
	},
	{
		name: "plugins_call",
		description:
			"Call a connected plugin tool using its schema. May read or modify external data; subject to session permission policy.",
		inputSchema: {
			type: "object",
			properties: {
				address: { type: "string" },
				arguments: { type: "object" },
			},
			required: ["address", "arguments"],
			additionalProperties: false,
		},
	},
];
