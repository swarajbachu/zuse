import { Effect, Stream } from "effect";
import {
  ChildProcess as Command,
  ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";

import { DeployStartError } from "@zuse/contracts";

/**
 * Convex provisioning + code push against the USER'S team (ADR 0022):
 * Management API for project/deploy-key creation (direct, with the user's
 * OAuth token — only the token exchange is proxied), then `npx convex
 * deploy` in the worktree with `CONVEX_DEPLOY_KEY`. The deployment URL is
 * derived from the deployment name rather than parsed out of CLI output.
 */

const MANAGEMENT_API = "https://api.convex.dev/v1";

export interface ConvexProject {
  readonly projectId: string;
  readonly deploymentName: string | null;
  readonly deploymentUrl: string | null;
}

const managementError = (reason: string) =>
  new DeployStartError({ reason: `Convex: ${reason}`, phase: "convex" });

const managementCall = <A>(
  token: string,
  path: string,
  body?: unknown,
): Effect.Effect<A, DeployStartError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${MANAGEMENT_API}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${path} failed (${res.status}): ${text.slice(0, 300)}`);
      }
      return (text === "" ? {} : JSON.parse(text)) as A;
    },
    catch: (cause) =>
      managementError(cause instanceof Error ? cause.message : String(cause)),
  });

const urlForDeployment = (deploymentName: string | null): string | null =>
  deploymentName === null ? null : `https://${deploymentName}.convex.cloud`;

/** Create a project on the user's team. Response fields are parsed
 * defensively — the Platform APIs are beta and field naming has drifted. */
export const createConvexProject = (
  token: string,
  teamId: string,
  name: string,
): Effect.Effect<ConvexProject, DeployStartError> =>
  managementCall<Record<string, unknown>>(
    token,
    `/teams/${encodeURIComponent(teamId)}/create_project`,
    { projectName: name, deploymentType: "prod" },
  ).pipe(
    Effect.flatMap((body) => {
      const projectId = body.projectId ?? body.id;
      if (projectId === undefined || projectId === null) {
        return Effect.fail(managementError("create_project returned no id"));
      }
      const deploymentName =
        body.deploymentName ?? body.prodDeploymentName ?? null;
      const prodUrl = body.prodUrl ?? body.deploymentUrl ?? null;
      const nameStr =
        typeof deploymentName === "string" ? deploymentName : null;
      return Effect.succeed({
        projectId: String(projectId),
        deploymentName: nameStr,
        deploymentUrl:
          typeof prodUrl === "string" ? prodUrl : urlForDeployment(nameStr),
      });
    }),
  );

/** Mint a deploy key for a deployment (the credential `npx convex deploy` uses). */
export const createDeployKey = (
  token: string,
  deploymentName: string,
): Effect.Effect<string, DeployStartError> =>
  managementCall<Record<string, unknown>>(
    token,
    `/deployments/${encodeURIComponent(deploymentName)}/create_deploy_key`,
    { name: "zuse-deploy" },
  ).pipe(
    Effect.flatMap((body) => {
      const key = body.deployKey ?? body.key ?? body.adminKey;
      return typeof key === "string" && key !== ""
        ? Effect.succeed(key)
        : Effect.fail(managementError("create_deploy_key returned no key"));
    }),
  );

const decodeLines = (
  s: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<string, unknown> =>
  s.pipe(Stream.decodeText({ encoding: "utf-8" }), Stream.splitLines);

/**
 * Run `npx convex deploy -y` in the app directory, feeding every output line
 * to `onLine`. Fails fast with the stderr/stdout tail on a non-zero exit.
 */
export const runConvexDeploy = (
  executor: CommandExecutor.ChildProcessSpawner["Service"],
  cwd: string,
  deployKey: string,
  onLine: (line: string) => Effect.Effect<void>,
): Effect.Effect<void, DeployStartError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const cmd = Command.make("npx", ["convex", "deploy", "-y"], {
        cwd,
        env: { CONVEX_DEPLOY_KEY: deployKey, CI: "1" },
      });
      const proc = yield* executor.spawn(cmd);
      const tail: string[] = [];
      const consume = (line: string) =>
        Effect.gen(function* () {
          tail.push(line);
          if (tail.length > 40) tail.shift();
          yield* onLine(line);
        });
      yield* Effect.all(
        [
          Stream.runForEach(decodeLines(proc.stdout), consume),
          Stream.runForEach(decodeLines(proc.stderr), consume),
        ],
        { concurrency: 2 },
      );
      const exitCode = yield* proc.exitCode;
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new DeployStartError({
            reason: `convex deploy exited with ${exitCode}: ${tail.slice(-8).join("\n")}`,
            phase: "convex",
          }),
        );
      }
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "10 minutes",
      orElse: () =>
        Effect.fail(
          new DeployStartError({
            reason: "convex deploy timed out after 10 minutes",
            phase: "convex",
          }),
        ),
    }),
    Effect.catch((err) =>
      err instanceof DeployStartError
        ? Effect.fail(err)
        : Effect.fail(
            new DeployStartError({
              reason: err instanceof Error ? err.message : String(err),
              phase: "convex",
            }),
          ),
    ),
  );
