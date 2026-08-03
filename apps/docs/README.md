# Zuse documentation

The documentation site is a Next.js application in the repository's Bun
workspace.

## Local development

Install dependencies once from the repository root:

```bash
bun install --frozen-lockfile
```

Then start the docs app:

```bash
bun run --cwd apps/docs dev
```

The local site is available at `http://localhost:3002`.

## Vercel project settings

Create a dedicated Vercel project for the docs site with these settings:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/docs` |
| Framework Preset | Next.js |
| Install Command | `bun install --frozen-lockfile` |
| Build Command | `bun run build` |
| Output Directory | Leave at the framework default |
| Production Domain | `docs.zuse.sh` |

Vercel detects Bun from the root `bun.lock` and the `packageManager` field in
the root `package.json`. The install command runs from Vercel's prepared project
checkout, so it must not include `cd ../..` or any other parent-directory
traversal. Do not set the output directory to `.next`; the Next.js preset
manages the deployment output.

The Vercel project's Root Directory is a dashboard setting and cannot be set
inside `vercel.json`. After changing it, redeploy the latest commit so the new
working directory is applied.

## Production build

Run the same application build locally from the repository root:

```bash
bun run --cwd apps/docs build
```

No separate documentation CI workflow is required. Git-connected preview and
production deployments are handled by the dedicated Vercel project.
