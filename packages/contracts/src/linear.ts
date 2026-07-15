import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { SessionId } from "./session.ts";

export class LinearConnection extends Schema.Class<LinearConnection>(
	"LinearConnection",
)({
	workspaceId: Schema.String,
	workspaceName: Schema.String,
	workspaceKey: Schema.String,
	viewerName: Schema.String,
	viewerEmail: Schema.String,
	connectedAt: Schema.DateFromString,
}) {}

export class LinearIssueRef extends Schema.Class<LinearIssueRef>(
	"LinearIssueRef",
)({
	workspaceId: Schema.String,
	issueId: Schema.String,
	identifier: Schema.String,
}) {}

export class LinearIssueSummary extends Schema.Class<LinearIssueSummary>(
	"LinearIssueSummary",
)({
	workspaceId: Schema.String,
	workspaceName: Schema.String,
	issueId: Schema.String,
	identifier: Schema.String,
	title: Schema.String,
	state: Schema.String,
	stateType: Schema.String,
	stateColor: Schema.NullOr(Schema.String),
	priority: Schema.Number,
	assignee: Schema.NullOr(Schema.String),
	assigneeAvatarUrl: Schema.NullOr(Schema.String),
	labels: Schema.Array(Schema.String),
	updatedAt: Schema.DateFromString,
}) {}

export class LinearContextFile extends Schema.Class<LinearContextFile>(
	"LinearContextFile",
)({
	issue: LinearIssueRef,
	relPath: Schema.String,
	absPath: Schema.String,
}) {}

export class LinearContextWarning extends Schema.Class<LinearContextWarning>(
	"LinearContextWarning",
)({
	issue: LinearIssueRef,
	message: Schema.String,
}) {}

export class LinearIntegrationError extends Schema.TaggedErrorClass<LinearIntegrationError>()(
	"LinearIntegrationError",
	{ reason: Schema.String },
) {}

export const LinearListConnectionsRpc = Rpc.make("linear.listConnections", {
	payload: Schema.Struct({}),
	success: Schema.Array(LinearConnection),
	error: LinearIntegrationError,
});

export const LinearConnectRpc = Rpc.make("linear.connect", {
	payload: Schema.Struct({}),
	success: LinearConnection,
	error: LinearIntegrationError,
});

export const LinearDisconnectRpc = Rpc.make("linear.disconnect", {
	payload: Schema.Struct({ workspaceId: Schema.String }),
	success: Schema.Void,
	error: LinearIntegrationError,
});

export const LinearListIssuesRpc = Rpc.make("linear.listIssues", {
	payload: Schema.Struct({
		query: Schema.optional(Schema.String),
		workspaceIds: Schema.optional(Schema.Array(Schema.String)),
		cursor: Schema.optional(Schema.String),
	}),
	success: Schema.Struct({
		issues: Schema.Array(LinearIssueSummary),
		nextCursor: Schema.NullOr(Schema.String),
	}),
	error: LinearIntegrationError,
});

export const LinearPrepareContextRpc = Rpc.make("linear.prepareContext", {
	payload: Schema.Struct({
		sessionId: SessionId,
		issues: Schema.Array(LinearIssueRef),
		rootPath: Schema.optional(Schema.String),
	}),
	success: Schema.Struct({
		files: Schema.Array(LinearContextFile),
		warnings: Schema.Array(LinearContextWarning),
	}),
	error: LinearIntegrationError,
});
