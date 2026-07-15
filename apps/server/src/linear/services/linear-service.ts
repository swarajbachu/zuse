import type {
	AttachmentRef,
	LinearConnection,
	LinearContextFile,
	LinearContextWarning,
	LinearIntegrationError,
	LinearIssueRef,
	LinearIssueSummary,
	SessionId,
} from "@zuse/contracts";
import { Context, type Effect } from "effect";

export interface LinearToolIssueUpdate {
	readonly workspaceId?: string;
	readonly issue: string;
	readonly title?: string;
	readonly description?: string;
	readonly status?: string;
	readonly priority?: number;
	readonly assignee?: string | null;
	readonly labels?: ReadonlyArray<string>;
	readonly project?: string | null;
}

export interface LinearServiceShape {
	readonly listConnections: () => Effect.Effect<
		ReadonlyArray<LinearConnection>,
		LinearIntegrationError
	>;
	readonly connect: () => Effect.Effect<
		LinearConnection,
		LinearIntegrationError
	>;
	readonly disconnect: (
		workspaceId: string,
	) => Effect.Effect<void, LinearIntegrationError>;
	readonly listIssues: (input: {
		readonly query?: string;
		readonly workspaceIds?: ReadonlyArray<string>;
		readonly cursor?: string;
	}) => Effect.Effect<
		{
			readonly issues: ReadonlyArray<LinearIssueSummary>;
			readonly nextCursor: string | null;
		},
		LinearIntegrationError
	>;
	readonly prepareContext: (input: {
		readonly sessionId: SessionId;
		readonly issues: ReadonlyArray<LinearIssueRef>;
		readonly rootPath?: string;
	}) => Effect.Effect<
		{
			readonly files: ReadonlyArray<LinearContextFile>;
			readonly attachments: ReadonlyArray<AttachmentRef>;
			readonly warnings: ReadonlyArray<LinearContextWarning>;
		},
		LinearIntegrationError
	>;
	readonly getIssueForTool: (
		workspaceId: string | undefined,
		issue: string,
	) => Effect.Effect<unknown, LinearIntegrationError>;
	readonly addComment: (
		workspaceId: string | undefined,
		issue: string,
		body: string,
	) => Effect.Effect<unknown, LinearIntegrationError>;
	readonly updateIssue: (
		input: LinearToolIssueUpdate,
	) => Effect.Effect<unknown, LinearIntegrationError>;
}

export class LinearService extends Context.Service<
	LinearService,
	LinearServiceShape
>()("@zuse/server/linear/LinearService") {}
