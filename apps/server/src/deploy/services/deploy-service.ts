import { Context, type Effect, type Stream } from "effect";

import type {
  ConvexAuthRequiredError,
  DeployAlreadyRunningError,
  DeployDetectError,
  DeployDetection,
  DeployEvent,
  Deployment,
  DeploymentId,
  DeployNotFoundError,
  DeployPhase,
  DeployStartError,
  FolderId,
  WorktreeId,
} from "@zuse/contracts";

/**
 * One-click deploy orchestrator (ADR 0022): detect → Convex provision +
 * deploy (user's team) → collect files → deploy-proxy → Vercel build poll.
 * One active run per `(projectId, worktreeId)`; every run persists a
 * `deployments` row and fans events out on `events()`.
 */
export interface DeployServiceShape {
  readonly detect: (
    folderId: FolderId,
    worktreeId: WorktreeId | null,
  ) => Effect.Effect<DeployDetection, DeployDetectError>;
  readonly start: (
    folderId: FolderId,
    worktreeId: WorktreeId | null,
  ) => Effect.Effect<
    Deployment,
    | DeployAlreadyRunningError
    | ConvexAuthRequiredError
    | DeployStartError
    | DeployDetectError
  >;
  /**
   * Long-lived per-(project, worktree) event stream: seeds the latest
   * persisted snapshot (and the live log when a run is active), then stays
   * open across runs. Emits nothing before the first deploy.
   */
  readonly events: (
    folderId: FolderId,
    worktreeId: WorktreeId | null,
  ) => Stream.Stream<DeployEvent>;
  readonly cancel: (
    deploymentId: DeploymentId,
  ) => Effect.Effect<void, DeployNotFoundError>;
  readonly history: (
    folderId: FolderId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<Deployment>>;
  readonly lastFailure: (
    folderId: FolderId,
    worktreeId: WorktreeId | null,
  ) => Effect.Effect<{
    readonly errorSummary: string | null;
    readonly logTail: string | null;
    readonly phase: DeployPhase | null;
    readonly url: string | null;
  } | null>;
}

export class DeployService extends Context.Service<
  DeployService,
  DeployServiceShape
>()("memoize/DeployService") {}
