import { Effect, Fiber, FileSystem, Layer, PubSub, Ref, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";

import {
  ConvexAuthRequiredError,
  DeployAlreadyRunningError,
  DeployDetectError,
  type DeployDetection,
  DeployLogEvent,
  DeployNotFoundError,
  type DeployPhase,
  DeployStartError,
  DeployStatusChangedEvent,
  type DeployEvent,
  type DeployStatus,
  Deployment,
  DeploymentId,
  FolderId,
  type FrontendFramework,
  WorktreeId,
} from "@zuse/contracts";

import { AuthService } from "../../auth/services/auth-service.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { ConvexAuthService } from "../services/convex-auth-service.ts";
import { DeployService } from "../services/deploy-service.ts";
import {
  createConvexProject,
  createDeployKey,
  runConvexDeploy,
} from "./convex-provision.ts";
import {
  INLINE_THRESHOLD_BYTES,
  collectFiles,
  totalBytes,
  type CollectedFile,
} from "./file-collector.ts";
import {
  makeDeployProxyClient,
  type DeployProxyClient,
  type VercelDeployFile,
} from "./deploy-proxy-client.ts";
import { detectDeployable } from "./framework-detect.ts";

/** Keep at most this much live log in memory (tail-truncated). */
const LOG_CAP = 256 * 1024;
/** Persisted failure log tail. */
const LOG_TAIL_CAP = 8 * 1024;
const POLL_INTERVAL = "3 seconds";
const BUILD_TIMEOUT_MS = 15 * 60_000;

const keyOf = (folderId: FolderId, worktreeId: WorktreeId | null): string =>
  `${folderId}:${worktreeId ?? "main"}`;

interface DeploymentRow {
  readonly id: string;
  readonly project_id: string;
  readonly worktree_id: string | null;
  readonly status: string;
  readonly framework: string;
  readonly url: string | null;
  readonly convex_url: string | null;
  readonly vercel_deployment_id: string | null;
  readonly error_summary: string | null;
  readonly log_tail: string | null;
  readonly failed_phase: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

interface DeployProjectRow {
  readonly project_id: string;
  readonly vercel_project_id: string | null;
  readonly vercel_project_name: string | null;
  readonly subdomain: string | null;
  readonly convex_project_id: string | null;
  readonly convex_deployment_name: string | null;
  readonly convex_url: string | null;
}

const rowToDeployment = (row: DeploymentRow): Deployment =>
  Deployment.make({
    id: DeploymentId.make(row.id),
    projectId: FolderId.make(row.project_id),
    worktreeId:
      row.worktree_id === null ? null : WorktreeId.make(row.worktree_id),
    status: row.status as DeployStatus,
    framework: row.framework as FrontendFramework,
    url: row.url,
    convexUrl: row.convex_url,
    vercelDeploymentId: row.vercel_deployment_id,
    errorSummary: row.error_summary,
    logTail: row.log_tail,
    createdAt: new Date(row.created_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  });

interface ActiveRun {
  readonly deploymentId: DeploymentId;
  readonly log: string;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

interface EventEnvelope {
  readonly key: string;
  readonly event: DeployEvent;
}

/** First line that smells like the actual error, for `errorSummary`. */
const summarize = (reason: string): string => {
  const lines = reason.split("\n").filter((l) => l.trim() !== "");
  const errorLine = lines.find((l) => /error|failed|cannot|missing/i.test(l));
  return (errorLine ?? lines[0] ?? "Deploy failed").slice(0, 500);
};

export const DeployServiceLive = Layer.effect(
  DeployService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const executor = yield* CommandExecutor.ChildProcessSpawner;
    const workspace = yield* WorkspaceService;
    const worktrees = yield* WorktreeService;
    const convexAuth = yield* ConvexAuthService;
    const credentials = yield* CredentialsService;
    const auth = yield* AuthService;
    const proxy: DeployProxyClient = makeDeployProxyClient(auth.getAccessToken);

    const pubsub = yield* PubSub.unbounded<EventEnvelope>();
    const active = yield* Ref.make<ReadonlyMap<string, ActiveRun>>(new Map());

    // Boot sweep: this process just started, so nothing can be running. Any
    // non-terminal row is an interrupted run from a previous session.
    yield* sql`
      UPDATE deployments
      SET status = 'failed',
          error_summary = 'Interrupted by app restart',
          finished_at = ${new Date().toISOString()}
      WHERE status NOT IN ('ready', 'failed', 'canceled')
    `.pipe(Effect.catch(() => Effect.void));

    const publish = (key: string, event: DeployEvent): Effect.Effect<void> =>
      PubSub.publish(pubsub, { key, event }).pipe(Effect.asVoid);

    const loadRow = (
      id: DeploymentId,
    ): Effect.Effect<DeploymentRow | null> =>
      sql<DeploymentRow>`SELECT * FROM deployments WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.catch(() => Effect.succeed(null)),
      );

    /** UPDATE + publish the fresh snapshot. The single write path for status. */
    const patchRow = (
      key: string,
      id: DeploymentId,
      fields: Partial<{
        status: DeployStatus;
        url: string | null;
        convex_url: string | null;
        vercel_deployment_id: string | null;
        error_summary: string | null;
        log_tail: string | null;
        failed_phase: DeployPhase | null;
        finished_at: string | null;
      }>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sets: string[] = [];
        const values: Array<string | null> = [];
        for (const [column, value] of Object.entries(fields)) {
          sets.push(`${column} = ?`);
          values.push(value as string | null);
        }
        if (sets.length === 0) return;
        yield* sql
          .unsafe(
            `UPDATE deployments SET ${sets.join(", ")} WHERE id = ?`,
            [...values, id],
          )
          .pipe(Effect.catch(() => Effect.void));
        const row = yield* loadRow(id);
        if (row !== null) {
          yield* publish(
            key,
            DeployStatusChangedEvent.make({ deployment: rowToDeployment(row) }),
          );
        }
      });

    const appendLog = (
      key: string,
      id: DeploymentId,
      phase: DeployPhase,
      text: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        let full = "";
        yield* Ref.update(active, (map) => {
          const run = map.get(key);
          if (run === undefined || run.deploymentId !== id) return map;
          full = (run.log + text).slice(-LOG_CAP);
          const next = new Map(map);
          next.set(key, { ...run, log: full });
          return next;
        });
        if (full !== "") {
          yield* publish(
            key,
            DeployLogEvent.make({ deploymentId: id, phase, output: full }),
          );
        }
      });

    const currentLog = (key: string): Effect.Effect<string> =>
      Ref.get(active).pipe(Effect.map((map) => map.get(key)?.log ?? ""));

    const loadProjectCache = (
      folderId: FolderId,
    ): Effect.Effect<DeployProjectRow | null> =>
      sql<DeployProjectRow>`
        SELECT * FROM deploy_projects WHERE project_id = ${folderId}
      `.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.catch(() => Effect.succeed(null)),
      );

    const saveProjectCache = (
      folderId: FolderId,
      fields: Partial<Omit<DeployProjectRow, "project_id">>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* loadProjectCache(folderId);
        const merged = {
          vercel_project_id: null,
          vercel_project_name: null,
          subdomain: null,
          convex_project_id: null,
          convex_deployment_name: null,
          convex_url: null,
          ...existing,
          ...fields,
        };
        yield* sql`
          INSERT INTO deploy_projects
            (project_id, vercel_project_id, vercel_project_name, subdomain,
             convex_project_id, convex_deployment_name, convex_url, updated_at)
          VALUES
            (${folderId}, ${merged.vercel_project_id}, ${merged.vercel_project_name},
             ${merged.subdomain}, ${merged.convex_project_id},
             ${merged.convex_deployment_name}, ${merged.convex_url},
             ${new Date().toISOString()})
          ON CONFLICT(project_id) DO UPDATE SET
            vercel_project_id = excluded.vercel_project_id,
            vercel_project_name = excluded.vercel_project_name,
            subdomain = excluded.subdomain,
            convex_project_id = excluded.convex_project_id,
            convex_deployment_name = excluded.convex_deployment_name,
            convex_url = excluded.convex_url,
            updated_at = excluded.updated_at
        `.pipe(Effect.catch(() => Effect.void));
      });

    const resolveCwd = (
      folderId: FolderId,
      worktreeId: WorktreeId | null,
    ): Effect.Effect<
      { cwd: string; appName: string },
      DeployStartError
    > =>
      Effect.gen(function* () {
        const folder = yield* workspace.findById(folderId);
        if (folder === null) {
          return yield* Effect.fail(
            new DeployStartError({
              reason: "Project folder not found.",
              phase: "detect",
            }),
          );
        }
        const appName = folder.path.replace(/\/$/, "").split("/").pop() ?? "app";
        if (worktreeId === null) return { cwd: folder.path, appName };
        const worktree = yield* worktrees.get(worktreeId);
        if (worktree === null) {
          return yield* Effect.fail(
            new DeployStartError({
              reason: "Worktree not found.",
              phase: "detect",
            }),
          );
        }
        return { cwd: worktree.path, appName };
      });

    // -----------------------------------------------------------------------
    // Convex leg: ensure project + deploy key on the USER'S team, then push
    // code from the worktree. Returns the deployment URL for the frontend env.
    // -----------------------------------------------------------------------
    const deployConvex = (
      key: string,
      id: DeploymentId,
      folderId: FolderId,
      appDir: string,
      appName: string,
    ): Effect.Effect<string | null, DeployStartError> =>
      Effect.gen(function* () {
        const token = yield* convexAuth.getToken().pipe(
          Effect.mapError(
            () =>
              new DeployStartError({
                reason: "Convex connection lost — reconnect and retry.",
                phase: "convex",
              }),
          ),
        );
        const connection = yield* convexAuth.status();
        if (connection === null) {
          return yield* Effect.fail(
            new DeployStartError({
              reason: "Convex connection lost — reconnect and retry.",
              phase: "convex",
            }),
          );
        }

        yield* patchRow(key, id, { status: "convex_provisioning" });
        const cache = yield* loadProjectCache(folderId);

        let convexProjectId = cache?.convex_project_id ?? null;
        let deploymentName = cache?.convex_deployment_name ?? null;
        let convexUrl = cache?.convex_url ?? null;

        if (convexProjectId === null || deploymentName === null) {
          yield* appendLog(
            key,
            id,
            "convex",
            `Creating Convex project "${appName}" on team ${connection.teamSlug ?? connection.teamId}…\n`,
          );
          const project = yield* createConvexProject(
            token,
            connection.teamId,
            appName,
          );
          convexProjectId = project.projectId;
          deploymentName = project.deploymentName;
          convexUrl = project.deploymentUrl;
          yield* saveProjectCache(folderId, {
            convex_project_id: convexProjectId,
            convex_deployment_name: deploymentName,
            convex_url: convexUrl,
          });
        }
        if (deploymentName === null) {
          return yield* Effect.fail(
            new DeployStartError({
              reason: "Convex project has no production deployment name.",
              phase: "convex",
            }),
          );
        }

        const keychainSlot = `convex:deployKey:${convexProjectId}`;
        let deployKey = yield* credentials
          .getSecret(keychainSlot)
          .pipe(Effect.catch(() => Effect.succeed<string | null>(null)));
        if (deployKey === null) {
          yield* appendLog(key, id, "convex", "Minting deploy key…\n");
          deployKey = yield* createDeployKey(token, deploymentName);
          yield* credentials
            .setSecret(keychainSlot, deployKey)
            .pipe(Effect.catch(() => Effect.void));
        }

        yield* patchRow(key, id, {
          status: "convex_deploying",
          convex_url: convexUrl,
        });
        const push = (dk: string) =>
          runConvexDeploy(executor, appDir, dk, (line) =>
            appendLog(key, id, "convex", `${line}\n`),
          );
        yield* push(deployKey).pipe(
          Effect.catch((err) =>
            // A cached key may have been revoked — re-mint once and retry.
            /key|unauthorized|401|forbidden/i.test(err.reason)
              ? Effect.gen(function* () {
                  yield* appendLog(
                    key,
                    id,
                    "convex",
                    "Deploy key rejected — minting a fresh one…\n",
                  );
                  const fresh = yield* createDeployKey(token, deploymentName);
                  yield* credentials
                    .setSecret(keychainSlot, fresh)
                    .pipe(Effect.catch(() => Effect.void));
                  yield* push(fresh);
                })
              : Effect.fail(err),
          ),
        );
        return convexUrl;
      });

    // -----------------------------------------------------------------------
    // Vercel leg: collect files → ensure project → upload → create deployment
    // → poll to READY/ERROR. All Vercel calls go through the deploy-proxy.
    // -----------------------------------------------------------------------
    const deployVercel = (
      key: string,
      id: DeploymentId,
      folderId: FolderId,
      cwd: string,
      appName: string,
      detection: DeployDetection,
      convexUrl: string | null,
    ): Effect.Effect<string, DeployStartError> =>
      Effect.gen(function* () {
        yield* patchRow(key, id, { status: "collecting" });
        const files = yield* collectFiles(executor, fs, cwd);
        yield* appendLog(
          key,
          id,
          "collect",
          `Collected ${files.length} files (${Math.round(totalBytes(files) / 1024)}KB).\n`,
        );

        yield* patchRow(key, id, { status: "uploading" });
        const mapProxyError = (phase: DeployPhase) => (err: unknown) =>
          err instanceof DeployStartError
            ? err
            : new DeployStartError({
                reason:
                  typeof err === "object" && err !== null && "reason" in err
                    ? String((err as { reason: unknown }).reason)
                    : String(err),
                phase,
              });

        const ensured = yield* proxy
          .ensureProject({ name: appName, framework: detection.framework })
          .pipe(Effect.mapError(mapProxyError("upload")));
        yield* saveProjectCache(folderId, {
          vercel_project_id: ensured.projectId,
          vercel_project_name: ensured.name,
          subdomain: ensured.subdomain,
        });
        yield* appendLog(
          key,
          id,
          "upload",
          `Vercel project ${ensured.name}${ensured.subdomain === null ? "" : ` → ${ensured.subdomain}`}.\n`,
        );

        const inline = totalBytes(files) < INLINE_THRESHOLD_BYTES;
        let payloadFiles: ReadonlyArray<VercelDeployFile>;
        if (inline) {
          payloadFiles = files.map((f) => ({
            file: f.file,
            data: Buffer.from(f.bytes).toString("base64"),
            encoding: "base64" as const,
          }));
        } else {
          const bySha = new Map<string, CollectedFile>();
          for (const f of files) bySha.set(f.sha, f);
          yield* Effect.forEach(
            [...bySha.values()],
            (f) =>
              proxy
                .uploadFile(f.sha, f.bytes)
                .pipe(Effect.mapError(mapProxyError("upload"))),
            { concurrency: 8 },
          );
          yield* appendLog(
            key,
            id,
            "upload",
            `Uploaded ${bySha.size} unique blobs.\n`,
          );
          payloadFiles = files.map((f) => ({
            file: f.file,
            sha: f.sha,
            size: f.size,
          }));
        }

        const env: Record<string, string> =
          convexUrl === null
            ? {}
            : {
                CONVEX_URL: convexUrl,
                NEXT_PUBLIC_CONVEX_URL: convexUrl,
                VITE_CONVEX_URL: convexUrl,
              };

        const created = yield* proxy
          .createDeployment({
            projectId: ensured.projectId,
            name: ensured.name,
            files: payloadFiles,
            env,
            framework: detection.framework,
            rootDirectory: detection.rootDir,
          })
          .pipe(Effect.mapError(mapProxyError("upload")));
        yield* patchRow(key, id, {
          status: "building",
          vercel_deployment_id: created.deploymentId,
        });
        yield* appendLog(
          key,
          id,
          "vercel_build",
          `Vercel build started (${created.deploymentId}).\n`,
        );

        // Poll until READY/ERROR — Vercel builds server-side.
        const startedAt = Date.now();
        let lastStatus = "";
        while (true) {
          if (Date.now() - startedAt > BUILD_TIMEOUT_MS) {
            return yield* Effect.fail(
              new DeployStartError({
                reason: "Vercel build timed out after 15 minutes.",
                phase: "vercel_build",
              }),
            );
          }
          const poll = yield* proxy
            .getDeployment(created.deploymentId)
            .pipe(Effect.mapError(mapProxyError("vercel_build")));
          if (poll.status !== lastStatus) {
            lastStatus = poll.status;
            yield* appendLog(key, id, "vercel_build", `${poll.status}…\n`);
          }
          if (poll.status === "READY") {
            return (
              ensured.url ??
              (poll.url === null ? "" : `https://${poll.url}`)
            );
          }
          if (poll.status === "ERROR" || poll.status === "CANCELED") {
            if (poll.buildLogTail !== null) {
              yield* appendLog(key, id, "vercel_build", poll.buildLogTail);
            }
            return yield* Effect.fail(
              new DeployStartError({
                reason:
                  poll.buildLogTail === null
                    ? `Vercel build ${poll.status.toLowerCase()}.`
                    : poll.buildLogTail,
                phase: "vercel_build",
              }),
            );
          }
          yield* Effect.sleep(POLL_INTERVAL);
        }
      });

    const pipeline = (
      key: string,
      id: DeploymentId,
      folderId: FolderId,
      cwd: string,
      appName: string,
      detection: DeployDetection,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        let convexUrl: string | null = null;
        if (detection.hasConvex) {
          convexUrl = yield* deployConvex(key, id, folderId, cwd, appName);
        }
        const url = yield* deployVercel(
          key,
          id,
          folderId,
          cwd,
          appName,
          detection,
          convexUrl,
        );
        yield* appendLog(key, id, "vercel_build", `Live at ${url}\n`);
        yield* patchRow(key, id, {
          status: "ready",
          url: url === "" ? null : url,
          convex_url: convexUrl,
          finished_at: new Date().toISOString(),
        });
      }).pipe(
        Effect.catch((err: DeployStartError) =>
          Effect.gen(function* () {
            const log = yield* currentLog(key);
            yield* patchRow(key, id, {
              status: "failed",
              error_summary: summarize(err.reason),
              log_tail: log.slice(-LOG_TAIL_CAP),
              failed_phase: err.phase,
              finished_at: new Date().toISOString(),
            });
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const log = yield* currentLog(key);
            yield* patchRow(key, id, {
              status: "failed",
              error_summary: summarize(String(cause)),
              log_tail: log.slice(-LOG_TAIL_CAP),
              finished_at: new Date().toISOString(),
            });
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const row = yield* loadRow(id);
            if (
              row !== null &&
              !["ready", "failed", "canceled"].includes(row.status)
            ) {
              yield* patchRow(key, id, {
                status: "canceled",
                finished_at: new Date().toISOString(),
              });
            }
          }),
        ),
        Effect.ensuring(
          Ref.update(active, (map) => {
            const run = map.get(key);
            if (run === undefined || run.deploymentId !== id) return map;
            const next = new Map(map);
            next.delete(key);
            return next;
          }),
        ),
      );

    const detect: DeployService["Service"]["detect"] = (folderId, worktreeId) =>
      resolveCwd(folderId, worktreeId).pipe(
        Effect.mapError(
          (err) =>
            new DeployDetectError({ projectId: folderId, reason: err.reason }),
        ),
        Effect.flatMap(({ cwd }) => detectDeployable(fs, cwd)),
      );

    const start: DeployService["Service"]["start"] = (folderId, worktreeId) =>
      Effect.gen(function* () {
        const key = keyOf(folderId, worktreeId);
        const runs = yield* Ref.get(active);
        if (runs.has(key)) {
          return yield* Effect.fail(
            new DeployAlreadyRunningError({ projectId: folderId, worktreeId }),
          );
        }

        const { cwd, appName } = yield* resolveCwd(folderId, worktreeId);
        const detection = yield* detectDeployable(fs, cwd);

        // Fail fast with the CTA error before any row is written.
        if (detection.hasConvex) {
          const connection = yield* convexAuth.status();
          if (connection === null) {
            return yield* Effect.fail(new ConvexAuthRequiredError({}));
          }
        }

        const id = DeploymentId.make(crypto.randomUUID());
        const now = new Date().toISOString();
        yield* sql`
          INSERT INTO deployments
            (id, project_id, worktree_id, status, framework, created_at)
          VALUES
            (${id}, ${folderId}, ${worktreeId}, 'queued', ${detection.framework}, ${now})
        `.pipe(
          Effect.mapError(
            (err) =>
              new DeployStartError({
                reason: `Failed to persist deployment: ${String(err)}`,
                phase: "detect",
              }),
          ),
        );

        yield* Ref.update(active, (map) => {
          const next = new Map(map);
          next.set(key, { deploymentId: id, log: "", fiber: null });
          return next;
        });

        const fiber = yield* Effect.forkDetach(
          pipeline(key, id, folderId, cwd, appName, detection),
        );
        yield* Ref.update(active, (map) => {
          const run = map.get(key);
          if (run === undefined || run.deploymentId !== id) return map;
          const next = new Map(map);
          next.set(key, { ...run, fiber });
          return next;
        });

        const row = yield* loadRow(id);
        const deployment =
          row === null
            ? Deployment.make({
                id,
                projectId: folderId,
                worktreeId,
                status: "queued",
                framework: detection.framework,
                url: null,
                convexUrl: null,
                vercelDeploymentId: null,
                errorSummary: null,
                logTail: null,
                createdAt: new Date(now),
                finishedAt: null,
              })
            : rowToDeployment(row);
        yield* publish(
          key,
          DeployStatusChangedEvent.make({ deployment }),
        );
        return deployment;
      });

    const events: DeployService["Service"]["events"] = (folderId, worktreeId) => {
      const key = keyOf(folderId, worktreeId);
      return Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before seeding so no live event can slip between the
          // snapshot read and the live tail (duplicates are harmless — both
          // event kinds carry full-replace payloads).
          const dequeue = yield* PubSub.subscribe(pubsub);
          const seed: DeployEvent[] = [];
          const rows = yield* sql<DeploymentRow>`
            SELECT * FROM deployments
            WHERE project_id = ${folderId}
              AND worktree_id ${worktreeId === null ? sql`IS NULL` : sql`= ${worktreeId}`}
            ORDER BY created_at DESC LIMIT 1
          `.pipe(Effect.catch(() => Effect.succeed([] as DeploymentRow[])));
          const latest = rows[0];
          if (latest !== undefined) {
            seed.push(
              DeployStatusChangedEvent.make({
                deployment: rowToDeployment(latest),
              }),
            );
          }
          const runs = yield* Ref.get(active);
          const run = runs.get(key);
          if (run !== undefined && run.log !== "") {
            seed.push(
              DeployLogEvent.make({
                deploymentId: run.deploymentId,
                phase: "detect",
                output: run.log,
              }),
            );
          }
          return Stream.concat(
            Stream.fromIterable(seed),
            Stream.fromSubscription(dequeue).pipe(
              Stream.filter((envelope: EventEnvelope) => envelope.key === key),
              Stream.map((envelope: EventEnvelope) => envelope.event),
            ),
          );
        }),
      );
    };

    const cancel: DeployService["Service"]["cancel"] = (deploymentId) =>
      Effect.gen(function* () {
        const runs = yield* Ref.get(active);
        for (const run of runs.values()) {
          if (run.deploymentId === deploymentId) {
            if (run.fiber !== null) {
              yield* Fiber.interrupt(run.fiber);
            }
            return;
          }
        }
        const row = yield* loadRow(deploymentId);
        if (row === null) {
          return yield* Effect.fail(new DeployNotFoundError({ deploymentId }));
        }
        // Stale non-terminal row with no live fiber (shouldn't happen after
        // the boot sweep) — mark canceled directly.
        if (!["ready", "failed", "canceled"].includes(row.status)) {
          yield* patchRow(
            keyOf(
              FolderId.make(row.project_id),
              row.worktree_id === null
                ? null
                : WorktreeId.make(row.worktree_id),
            ),
            deploymentId,
            { status: "canceled", finished_at: new Date().toISOString() },
          );
        }
      });

    const history: DeployService["Service"]["history"] = (folderId, limit) =>
      sql<DeploymentRow>`
        SELECT * FROM deployments
        WHERE project_id = ${folderId}
        ORDER BY created_at DESC
        LIMIT ${limit ?? 20}
      `.pipe(
        Effect.map((rows) => rows.map(rowToDeployment)),
        Effect.catch(() => Effect.succeed([] as Deployment[])),
      );

    const lastFailure: DeployService["Service"]["lastFailure"] = (
      folderId,
      worktreeId,
    ) =>
      sql<DeploymentRow>`
        SELECT * FROM deployments
        WHERE project_id = ${folderId}
          AND worktree_id ${worktreeId === null ? sql`IS NULL` : sql`= ${worktreeId}`}
          AND status = 'failed'
        ORDER BY created_at DESC LIMIT 1
      `.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          if (row === undefined) return null;
          return {
            errorSummary: row.error_summary,
            logTail: row.log_tail,
            phase: (row.failed_phase as DeployPhase | null) ?? null,
            url: row.url,
          };
        }),
        Effect.catch(() => Effect.succeed(null)),
      );

    return DeployService.of({
      detect,
      start,
      events,
      cancel,
      history,
      lastFailure,
    });
  }),
);
