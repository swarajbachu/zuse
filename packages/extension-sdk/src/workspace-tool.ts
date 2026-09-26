import { Schema } from "effect";
import { defineRpc } from "./rpc.ts";
export const AttachmentSnapshotSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	subtitle: Schema.optional(Schema.String),
	text: Schema.String,
	metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const WorkspaceToolRequest = Schema.Struct({
	action: Schema.Literals(["list", "read", "scan"]),
	path: Schema.String,
	query: Schema.String,
	cursor: Schema.Number,
});
export const WorkspaceToolResponse = Schema.Struct({
	paths: Schema.Array(Schema.String),
	items: Schema.Array(AttachmentSnapshotSchema),
	status: Schema.String,
	truncated: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.Number),
	progress: Schema.String,
});
export type WorkspaceToolResult = typeof WorkspaceToolResponse.Type;
export const workspaceToolRpc = defineRpc({
	name: "workspace-tool",
	input: WorkspaceToolRequest,
	output: WorkspaceToolResponse,
});
export const workspaceToolSearch = defineRpc({
	name: "search",
	input: Schema.Struct({ query: Schema.String }),
	output: Schema.Array(AttachmentSnapshotSchema),
});
