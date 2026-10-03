import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";
import { FolderId } from "./ids.ts";

export const EnvironmentEntry = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	kind: Schema.Literals(["secret", "variable"]),
	scope: Schema.Literals(["personal", "team"]),
	projectIds: Schema.NullOr(Schema.Array(Schema.String)),
	excludedProjectIds: Schema.Array(Schema.String),
	target: Schema.Literals(["both", "local", "cloud"]),
	revision: Schema.Number,
	updatedAt: Schema.Number,
});
export type EnvironmentEntry = typeof EnvironmentEntry.Type;
export const EnvironmentProject = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});
export type EnvironmentProject = typeof EnvironmentProject.Type;
export const EnvironmentVaultSnapshot = Schema.Struct({
	enabled: Schema.Boolean,
	teamEnabled: Schema.Boolean,
	revision: Schema.Number,
	entries: Schema.Array(EnvironmentEntry),
	projects: Schema.Array(EnvironmentProject),
});
export type EnvironmentVaultSnapshot = typeof EnvironmentVaultSnapshot.Type;
export const EnvironmentVaultCommand = Schema.Union([
	Schema.Struct({ action: Schema.Literal("list") }),
	Schema.Struct({
		action: Schema.Literal("rotate"),
		expectedRevision: Schema.Number,
	}),
	Schema.Struct({
		action: Schema.Literal("save"),
		expectedRevision: Schema.Number,
		entry: EnvironmentEntry,
		value: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		action: Schema.Literal("delete"),
		expectedRevision: Schema.Number,
		id: Schema.String,
	}),
	Schema.Struct({ action: Schema.Literal("reveal"), id: Schema.String }),
	Schema.Struct({
		action: Schema.Literal("project"),
		expectedRevision: Schema.Number,
		name: Schema.String,
	}),
]);
export type EnvironmentVaultCommand = typeof EnvironmentVaultCommand.Type;
export const EnvironmentVaultResult = Schema.Struct({
	snapshot: EnvironmentVaultSnapshot,
	value: Schema.optional(Schema.String),
	projectId: Schema.optional(Schema.String),
});
export type EnvironmentVaultResult = typeof EnvironmentVaultResult.Type;
export const EnvironmentResolved = Schema.Struct({
	projectId: Schema.optional(Schema.String),
	revision: Schema.Number,
	values: Schema.Record(Schema.String, Schema.String),
	secretNames: Schema.Array(Schema.String),
	sources: Schema.Record(Schema.String, Schema.String),
	resolvedAt: Schema.Number,
});
export type EnvironmentResolved = typeof EnvironmentResolved.Type;
export const EnvironmentVaultRpc = Rpc.make("environment.vault", {
	payload: EnvironmentVaultCommand,
	success: EnvironmentVaultResult,
	error: CloudWorkspaceOpError,
});

export const EnvironmentLinkRpc = Rpc.make("environment.link", {
	payload: Schema.Struct({
		folderId: FolderId,
		projectId: Schema.optional(Schema.NullOr(Schema.String)),
	}),
	success: Schema.Struct({
		projectId: Schema.NullOr(Schema.String),
		target: Schema.optional(Schema.Literals(["local", "cloud"])),
		offline: Schema.optional(Schema.Boolean),
		resolvedAt: Schema.optional(Schema.Number),
	}),
	error: CloudWorkspaceOpError,
});
