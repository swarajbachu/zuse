import { Schema } from "effect";

/** One agent started by a native workflow script, as last reported. */
export const WorkflowAgentProgress = Schema.Struct({
	index: Schema.Number,
	label: Schema.String,
	phaseIndex: Schema.optional(Schema.Number),
	phaseTitle: Schema.optional(Schema.String),
	state: Schema.Literals(["queued", "running", "done", "failed"]),
	model: Schema.optional(Schema.String),
	startedAt: Schema.optional(Schema.Number),
	durationMs: Schema.optional(Schema.Number),
	promptPreview: Schema.optional(Schema.String),
	resultPreview: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});
export type WorkflowAgentProgress = typeof WorkflowAgentProgress.Type;

/**
 * Latest phase and agent snapshot of a native workflow run. Carried on the
 * workflow's tool input under {@link WORKFLOW_PROGRESS_KEY} so each update
 * replaces the previous one instead of appending transcript rows.
 */
export const WorkflowProgress = Schema.Struct({
	phases: Schema.Array(
		Schema.Struct({ index: Schema.Number, title: Schema.String }),
	),
	agents: Schema.Array(WorkflowAgentProgress),
});
export type WorkflowProgress = typeof WorkflowProgress.Type;

export const WORKFLOW_PROGRESS_KEY = "workflow_progress";
