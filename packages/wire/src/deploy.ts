import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { DeploymentId, FolderId, WorktreeId } from "./ids.ts";

export const FrontendFramework = Schema.Literal(
  "nextjs",
  "vite",
  "astro",
  "unknown",
);
export type FrontendFramework = typeof FrontendFramework.Type;

export const PackageManager = Schema.Literal("bun", "npm", "pnpm", "yarn");
export type PackageManager = typeof PackageManager.Type;

export const DeployStatus = Schema.Literal(
  "queued",
  "detecting",
  "convex_provisioning",
  "convex_deploying",
  "collecting",
  "uploading",
  "building",
  "ready",
  "failed",
  "canceled",
);
export type DeployStatus = typeof DeployStatus.Type;

/** Coarse phase attached to log lines + failures so the agent knows where a
 * deploy died without parsing the log. */
export const DeployPhase = Schema.Literal(
  "detect",
  "convex",
  "collect",
  "upload",
  "vercel_build",
);
export type DeployPhase = typeof DeployPhase.Type;

/** What `deploy.detect` found in the worktree. `rootDir` is the repo-relative
 * directory of the deployable app (`""` = repo root; set for monorepos). */
export class DeployDetection extends Schema.Class<DeployDetection>(
  "DeployDetection",
)({
  framework: FrontendFramework,
  hasConvex: Schema.Boolean,
  rootDir: Schema.String,
  packageManager: PackageManager,
  warnings: Schema.Array(Schema.String),
}) {}

/**
 * One deploy run, persisted per project. `url` is the managed frontend URL
 * (`https://<slug>.zuse.app`); `convexUrl` the user's Convex deployment.
 * `errorSummary`/`logTail` are set on terminal failure so the agent can fix
 * and redeploy without re-running anything.
 */
export class Deployment extends Schema.Class<Deployment>("Deployment")({
  id: DeploymentId,
  projectId: FolderId,
  worktreeId: Schema.NullOr(WorktreeId),
  status: DeployStatus,
  framework: FrontendFramework,
  url: Schema.NullOr(Schema.String),
  convexUrl: Schema.NullOr(Schema.String),
  vercelDeploymentId: Schema.NullOr(Schema.String),
  errorSummary: Schema.NullOr(Schema.String),
  logTail: Schema.NullOr(Schema.String),
  createdAt: Schema.DateFromString,
  finishedAt: Schema.NullOr(Schema.DateFromString),
}) {}

/** The user's Convex platform-OAuth connection (team-scoped). */
export class ConvexConnection extends Schema.Class<ConvexConnection>(
  "ConvexConnection",
)({
  teamId: Schema.String,
  teamSlug: Schema.NullOr(Schema.String),
  connectedAt: Schema.DateFromString,
}) {}

/**
 * Live deploy events. `log` carries the FULL accumulated (already-truncated)
 * output so the renderer can replace its buffer wholesale — same contract as
 * `WorktreeSetupChunk`. `status` carries every `Deployment` snapshot
 * transition. The stream stays open across runs (long-lived per panel).
 */
export const DeployLogEvent = Schema.TaggedStruct("log", {
  deploymentId: DeploymentId,
  phase: DeployPhase,
  output: Schema.String,
});

export const DeployStatusChangedEvent = Schema.TaggedStruct("status", {
  deployment: Deployment,
});

export const DeployEvent = Schema.Union(
  DeployLogEvent,
  DeployStatusChangedEvent,
);
export type DeployEvent = typeof DeployEvent.Type;

export class DeployDetectError extends Schema.TaggedError<DeployDetectError>()(
  "DeployDetectError",
  { projectId: FolderId, reason: Schema.String },
) {}

export class DeployAlreadyRunningError extends Schema.TaggedError<DeployAlreadyRunningError>()(
  "DeployAlreadyRunningError",
  { projectId: FolderId, worktreeId: Schema.NullOr(WorktreeId) },
) {}

export class DeployNotFoundError extends Schema.TaggedError<DeployNotFoundError>()(
  "DeployNotFoundError",
  { deploymentId: DeploymentId },
) {}

/** No (valid) Convex connection while the project needs one — the renderer
 * maps this to the "Connect Convex" CTA rather than a toast. */
export class ConvexAuthRequiredError extends Schema.TaggedError<ConvexAuthRequiredError>()(
  "ConvexAuthRequiredError",
  {},
) {}

export class ConvexAuthError extends Schema.TaggedError<ConvexAuthError>()(
  "ConvexAuthError",
  { reason: Schema.String },
) {}

/** A deploy-proxy call failed. `quotaExceeded` distinguishes 429s so the
 * renderer can show a quota-specific message. */
export class DeployProxyError extends Schema.TaggedError<DeployProxyError>()(
  "DeployProxyError",
  {
    status: Schema.Number,
    reason: Schema.String,
    quotaExceeded: Schema.Boolean,
  },
) {}

export class DeployStartError extends Schema.TaggedError<DeployStartError>()(
  "DeployStartError",
  { reason: Schema.String, phase: DeployPhase },
) {}

const DeployStartErrors = Schema.Union(
  DeployAlreadyRunningError,
  ConvexAuthRequiredError,
  DeployStartError,
  DeployDetectError,
);

export const DeployDetectRpc = Rpc.make("deploy.detect", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.NullOr(WorktreeId),
  }),
  success: DeployDetection,
  error: DeployDetectError,
});

export const DeployStartRpc = Rpc.make("deploy.start", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.NullOr(WorktreeId),
  }),
  success: Deployment,
  error: DeployStartErrors,
});

/**
 * Subscribe to a (project, worktree)'s deploy events. Seeds the latest
 * persisted `Deployment` snapshot (if any) plus the accumulated log of an
 * active run on subscribe, then streams live events. Emits nothing before
 * the first deploy; stays open across runs.
 */
export const DeployEventsRpc = Rpc.make("deploy.events", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.NullOr(WorktreeId),
  }),
  success: DeployEvent,
  stream: true,
});

export const DeployCancelRpc = Rpc.make("deploy.cancel", {
  payload: Schema.Struct({ deploymentId: DeploymentId }),
  success: Schema.Void,
  error: DeployNotFoundError,
});

export const DeployHistoryRpc = Rpc.make("deploy.history", {
  payload: Schema.Struct({
    folderId: FolderId,
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.Array(Deployment),
});

/** Structured last-failure record for agent consumption ("fix and redeploy"). */
export const DeployLastFailureRpc = Rpc.make("deploy.lastFailure", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.NullOr(WorktreeId),
  }),
  success: Schema.NullOr(
    Schema.Struct({
      errorSummary: Schema.NullOr(Schema.String),
      logTail: Schema.NullOr(Schema.String),
      phase: Schema.NullOr(DeployPhase),
      url: Schema.NullOr(Schema.String),
    }),
  ),
});

export const DeployConvexStatusRpc = Rpc.make("deploy.convexStatus", {
  payload: Schema.Struct({}),
  success: Schema.NullOr(ConvexConnection),
});

export const DeployConnectConvexRpc = Rpc.make("deploy.connectConvex", {
  payload: Schema.Struct({}),
  success: ConvexConnection,
  error: ConvexAuthError,
});

export const DeployDisconnectConvexRpc = Rpc.make("deploy.disconnectConvex", {
  payload: Schema.Struct({}),
  success: Schema.Void,
});
