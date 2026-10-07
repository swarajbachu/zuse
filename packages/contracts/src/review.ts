import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";

const Count = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
);
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Sha = Schema.String.check(
	Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
);

export const ReviewSnapshot = Schema.Struct({
	repositoryId: Positive,
	baseRef: Id,
	baseSha: Sha,
	headSha: Sha,
	mergeBaseSha: Sha,
});
export type ReviewSnapshot = typeof ReviewSnapshot.Type;

export const ReviewLocation = Schema.Struct({
	path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
	startLine: Positive,
	endLine: Positive,
	side: Schema.Literals(["LEFT", "RIGHT"]),
});
export type ReviewLocation = typeof ReviewLocation.Type;
export const ReviewEvidence = Schema.Struct({
	...ReviewLocation.fields,
	quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
});
export type ReviewEvidence = typeof ReviewEvidence.Type;
export const ReviewFinding = Schema.Struct({
	id: Id,
	severity: Schema.Literals(["critical", "high", "medium"]),
	title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
	explanation: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(8000),
	),
	trigger: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	consequence: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(4000),
	),
	location: ReviewLocation,
	evidence: Schema.Array(ReviewEvidence).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(20),
	),
});
export type ReviewFinding = typeof ReviewFinding.Type;
export const ReviewCoverage = Schema.Struct({
	eligibleFiles: Count,
	reviewedFiles: Count,
	excludedFiles: Count,
	unreviewedPaths: Schema.Array(Schema.String),
	contextLimited: Schema.Boolean,
});
export type ReviewCoverage = typeof ReviewCoverage.Type;
export const ReviewResult = Schema.Struct({
	snapshot: ReviewSnapshot,
	status: Schema.Literals(["completed", "partial"]),
	reason: Schema.optional(Schema.String),
	findings: Schema.Array(ReviewFinding),
	coverage: ReviewCoverage,
});
export type ReviewResult = typeof ReviewResult.Type;

export const ReviewWorkerSettings = Schema.Struct({
	provider: Id,
	size: Id,
	maxRuntimeMs: Positive,
	maxCostMicros: Schema.optional(Positive),
});
export type ReviewWorkerSettings = typeof ReviewWorkerSettings.Type;
export const ReviewEnrollment = Schema.Struct({
	id: Id,
	repositoryId: Positive,
	repositoryFullName: Id,
	installationId: Positive,
	kind: Schema.Literals(["personal", "shared"]),
	githubUserId: Schema.optional(Positive),
	ownerId: Id,
	modelConnectionId: Id,
	agentProvider: Id,
	model: Id,
	worker: ReviewWorkerSettings,
	enabled: Schema.Boolean,
	version: Positive,
	createdAtMs: Count,
	updatedAtMs: Count,
});
export type ReviewEnrollment = typeof ReviewEnrollment.Type;
/** Identity, payer and permission proofs are resolved by the server, never accepted here. */
export const ReviewEnrollmentRequest = Schema.Struct({
	repositoryId: Positive,
	kind: Schema.Literals(["personal", "shared"]),
	modelConnectionId: Id,
	agentProvider: Id,
	model: Id,
	worker: ReviewWorkerSettings,
});
export type ReviewEnrollmentRequest = typeof ReviewEnrollmentRequest.Type;
export const ReviewEnrollmentSetup = Schema.Struct({
	authorizationUrl: Schema.String,
});
export const ReviewRunState = Schema.Literals([
	"queued",
	"provisioning",
	"reviewing",
	"publishing",
	"completed",
	"partial",
	"blocked",
	"cancelled",
	"superseded",
	"failed",
]);
export type ReviewRunState = typeof ReviewRunState.Type;
export const ReviewRun = Schema.Struct({
	id: Id,
	repositoryId: Positive,
	repositoryFullName: Id,
	pullNumber: Positive,
	baseRef: Id,
	baseSha: Sha,
	headSha: Sha,
	mergeBaseSha: Schema.optional(Sha),
	enrollmentId: Id,
	enrollmentVersion: Positive,
	ownerId: Id,
	modelConnectionId: Id,
	agentProvider: Id,
	model: Id,
	worker: ReviewWorkerSettings,
	state: ReviewRunState,
	blockedReason: Schema.optional(Schema.String),
	createdAtMs: Count,
	updatedAtMs: Count,
	estimatedCostMicros: Schema.optional(Count),
	settledCostMicros: Schema.optional(Count),
	result: Schema.optional(ReviewResult),
});
export type ReviewRun = typeof ReviewRun.Type;
export const ReviewAvailability = Schema.Struct({
	available: Schema.Boolean,
	reason: Schema.optional(Schema.String),
	providers: Schema.Array(
		Schema.Struct({
			provider: Id,
			available: Schema.Boolean,
			reasons: Schema.Array(Schema.String),
		}),
	),
	enrollments: Schema.Array(ReviewEnrollment),
});
export type ReviewAvailability = typeof ReviewAvailability.Type;
export const ReviewEnrollmentList = Schema.Struct({
	items: Schema.Array(ReviewEnrollment),
});
export const ReviewRunPage = Schema.Struct({
	items: Schema.Array(ReviewRun),
	nextCursor: Schema.optional(Schema.String),
});
export type ReviewRunPage = typeof ReviewRunPage.Type;
/** Deliberately excludes the sponsor, billing details and agent transcript. */
export const ReviewFixContext = Schema.Struct({
	runId: Id,
	repositoryId: Positive,
	repositoryFullName: Id,
	pullNumber: Positive,
	snapshot: ReviewSnapshot,
	findings: Schema.Array(ReviewFinding),
	currentHeadSha: Sha,
});
export type ReviewFixContext = typeof ReviewFixContext.Type;

export const ReviewRequest = Schema.Struct({
	repositoryId: Positive,
	pullNumber: Positive,
});
export type ReviewRequest = typeof ReviewRequest.Type;
export const ReviewCoverageRpc = Rpc.make("review.coverage", {
	payload: Schema.Void,
	success: ReviewAvailability,
	error: CloudWorkspaceOpError,
});
export const ReviewEnrollmentsRpc = Rpc.make("review.enrollments", {
	payload: Schema.Void,
	success: ReviewEnrollmentList,
	error: CloudWorkspaceOpError,
});
export const ReviewEnrollRpc = Rpc.make("review.enroll", {
	payload: ReviewEnrollmentRequest,
	success: ReviewEnrollmentSetup,
	error: CloudWorkspaceOpError,
});
export const ReviewDisableRpc = Rpc.make("review.disable", {
	payload: Schema.Struct({ id: Id }),
	success: ReviewEnrollment,
	error: CloudWorkspaceOpError,
});
export const ReviewRunsRpc = Rpc.make("review.runs", {
	payload: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
	success: ReviewRunPage,
	error: CloudWorkspaceOpError,
});
export const ReviewGetRpc = Rpc.make("review.get", {
	payload: Schema.Struct({ id: Id }),
	success: ReviewRun,
	error: CloudWorkspaceOpError,
});
export const ReviewRequestRpc = Rpc.make("review.request", {
	payload: ReviewRequest,
	success: ReviewRun,
	error: CloudWorkspaceOpError,
});
export const ReviewCancelRpc = Rpc.make("review.cancel", {
	payload: Schema.Struct({ id: Id }),
	success: ReviewRun,
	error: CloudWorkspaceOpError,
});
export const ReviewRetryRpc = Rpc.make("review.retry", {
	payload: Schema.Struct({ id: Id }),
	success: ReviewRun,
	error: CloudWorkspaceOpError,
});
export const ReviewFixContextRpc = Rpc.make("review.fixContext", {
	payload: Schema.Struct({ id: Id }),
	success: ReviewFixContext,
	error: CloudWorkspaceOpError,
});
