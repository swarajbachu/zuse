import type { FileSystem } from "@effect/platform";
import { Effect } from "effect";

import {
  DeployDetection,
  type FrontendFramework,
  type PackageManager,
} from "@zuse/wire";

/**
 * Pure detection over the worktree: which frontend framework, whether a
 * Convex backend is present, and (for monorepos) which subdirectory is the
 * deployable app. Read-only FileSystem probing — failures fold to `unknown`
 * with a warning rather than failing the deploy before it starts.
 */

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly workspaces?: unknown;
}

const readPackageJson = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<PackageJson | null> =>
  fs.readFileString(`${dir}/package.json`).pipe(
    Effect.map((raw) => {
      try {
        return JSON.parse(raw) as PackageJson;
      } catch {
        return null;
      }
    }),
    Effect.catchAll(() => Effect.succeed(null)),
  );

const frameworkOf = (pkg: PackageJson): FrontendFramework => {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["next"] !== undefined) return "nextjs";
  if (deps["astro"] !== undefined) return "astro";
  if (deps["vite"] !== undefined) return "vite";
  return "unknown";
};

const exists = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean> =>
  fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)));

const detectPackageManager = (
  fs: FileSystem.FileSystem,
  root: string,
): Effect.Effect<PackageManager> =>
  Effect.gen(function* () {
    if (yield* exists(fs, `${root}/bun.lock`)) return "bun";
    if (yield* exists(fs, `${root}/bun.lockb`)) return "bun";
    if (yield* exists(fs, `${root}/pnpm-lock.yaml`)) return "pnpm";
    if (yield* exists(fs, `${root}/yarn.lock`)) return "yarn";
    return "npm";
  });

const detectConvex = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (yield* exists(fs, `${dir}/convex`)) return true;
    return yield* exists(fs, `${dir}/convex.json`);
  });

/** One level of `apps/*` / `packages/*` — enough for the common layouts. */
const monorepoCandidates = (
  fs: FileSystem.FileSystem,
  root: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const out: string[] = [];
    for (const group of ["apps", "packages"]) {
      const entries = yield* fs
        .readDirectory(`${root}/${group}`)
        .pipe(Effect.catchAll(() => Effect.succeed([] as string[])));
      for (const entry of entries) out.push(`${group}/${entry}`);
    }
    return out;
  });

export const detectDeployable = (
  fs: FileSystem.FileSystem,
  root: string,
): Effect.Effect<DeployDetection> =>
  Effect.gen(function* () {
    const warnings: string[] = [];
    const packageManager = yield* detectPackageManager(fs, root);
    const rootPkg = yield* readPackageJson(fs, root);

    if (rootPkg === null) {
      warnings.push("No package.json found — framework detection skipped.");
      return DeployDetection.make({
        framework: "unknown",
        hasConvex: yield* detectConvex(fs, root),
        rootDir: "",
        packageManager,
        warnings,
      });
    }

    let framework = frameworkOf(rootPkg);
    let rootDir = "";
    let hasConvex = yield* detectConvex(fs, root);

    // Monorepo: the root rarely is the app. Scan one level for the first
    // frontend workspace and deploy that (documented v1 non-goal: no picker).
    if (framework === "unknown" && rootPkg.workspaces !== undefined) {
      for (const candidate of yield* monorepoCandidates(fs, root)) {
        const pkg = yield* readPackageJson(fs, `${root}/${candidate}`);
        if (pkg === null) continue;
        const found = frameworkOf(pkg);
        if (found !== "unknown") {
          framework = found;
          rootDir = candidate;
          warnings.push(`Monorepo detected — deploying ${candidate}.`);
          if (!hasConvex) {
            hasConvex = yield* detectConvex(fs, `${root}/${candidate}`);
          }
          break;
        }
      }
    }

    if (framework === "unknown") {
      warnings.push(
        "No supported framework detected (Next.js / Vite / Astro) — Vercel will auto-detect at build time.",
      );
    }

    return DeployDetection.make({
      framework,
      hasConvex,
      rootDir,
      packageManager,
      warnings,
    });
  });
