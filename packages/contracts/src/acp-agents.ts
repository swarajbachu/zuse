import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { AcpProviderId, LoginEvent } from "./agent.ts";
import { PtyId, PtyOwnerId } from "./ids.ts";

export const AcpAuthMethod = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
	args: Schema.optional(Schema.Array(Schema.String)),
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const AcpModel = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});
export const AcpProbe = Schema.Struct({
	status: Schema.Literals(["ready", "authentication-required", "error"]),
	message: Schema.String,
	authMethods: Schema.Array(AcpAuthMethod),
	models: Schema.Array(AcpModel),
	modes: Schema.Array(AcpModel),
	commands: Schema.Array(
		Schema.Struct({ name: Schema.String, description: Schema.String }),
	),
	loadSession: Schema.Boolean,
	currentModeId: Schema.optional(Schema.String),
	currentModelId: Schema.optional(Schema.String),
});
export type AcpProbe = typeof AcpProbe.Type;
export const AcpDefinition = Schema.Struct({
	id: AcpProviderId,
	name: Schema.String,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	envKeys: Schema.Array(Schema.String),
	mcpEnabled: Schema.optional(Schema.Boolean),
	enabled: Schema.Boolean,
	catalogId: Schema.optional(Schema.String),
	version: Schema.optional(Schema.String),
	icon: Schema.optional(Schema.String),
	probe: Schema.optional(AcpProbe),
});
export type AcpDefinition = typeof AcpDefinition.Type;
export const AcpDefinitionInput = Schema.Struct({
	id: Schema.optional(AcpProviderId),
	name: Schema.String,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	enabled: Schema.Boolean,
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	mcpEnabled: Schema.optional(Schema.Boolean),
});
export type AcpDefinitionInput = typeof AcpDefinitionInput.Type;
export const AcpCatalogEntry = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	version: Schema.String,
	source: Schema.String,
	icon: Schema.optional(Schema.String),
	compatible: Schema.Boolean,
	origin: Schema.optional(Schema.Literals(["registry", "community"])),
});
export type AcpCatalogEntry = typeof AcpCatalogEntry.Type;
export class AcpOperationError extends Schema.TaggedErrorClass<AcpOperationError>()(
	"AcpOperationError",
	{ message: Schema.String },
) {}
export const AcpListRpc = Rpc.make("provider.acp.list", {
	success: Schema.Array(AcpDefinition),
	error: AcpOperationError,
});
export const AcpCatalogRpc = Rpc.make("provider.acp.catalog", {
	success: Schema.Array(AcpCatalogEntry),
	error: AcpOperationError,
});
export const AcpSaveRpc = Rpc.make("provider.acp.save", {
	payload: AcpDefinitionInput,
	success: AcpDefinition,
	error: AcpOperationError,
});
export const AcpRemoveRpc = Rpc.make("provider.acp.remove", {
	payload: { id: AcpProviderId },
	success: Schema.Void,
	error: AcpOperationError,
});
export const AcpTestRpc = Rpc.make("provider.acp.test", {
	payload: { id: AcpProviderId },
	success: AcpProbe,
	error: AcpOperationError,
});
export const AcpInstallRpc = Rpc.make("provider.acp.install", {
	payload: { catalogId: Schema.String, id: Schema.optional(AcpProviderId) },
	success: AcpDefinition,
	error: AcpOperationError,
});
export const AcpAuthenticationEvent = Schema.Union([
	LoginEvent,
	Schema.TaggedStruct("terminal", {
		ptyId: PtyId,
		ownerId: PtyOwnerId,
		processEpoch: Schema.String,
		cwd: Schema.String,
	}),
]);
export const AcpAuthenticateRpc = Rpc.make("provider.acp.authenticate", {
	payload: { id: AcpProviderId, methodId: Schema.String },
	success: AcpAuthenticationEvent,
	stream: true,
	error: AcpOperationError,
});

export const AcpDuplicateRpc = Rpc.make("provider.acp.duplicate", {
	payload: { id: AcpProviderId },
	success: AcpDefinition,
	error: AcpOperationError,
});
