---
name: release-new-version
description: Release a new memoize version from this repository. Use when the user asks to release, bump versions, add changelogs, update the website changelog, create a release PR, or run the "Release New Version" slash command.
---

# Release New Version

Run this skill from the memoize repository root.

## Workflow

1. Inspect `git status --short --branch`. If the working tree is dirty, explain that release automation needs a clean tree unless the user explicitly wants those changes included.
2. Pull the latest base with `git fetch --prune origin` and `git pull --ff-only origin main`.
3. Compare commits since the current `apps/desktop/package.json` version tag, e.g. `git log --pretty=format:%s v0.5.0..HEAD`.
4. Decide the version bump:
   - major: several breaking or migration-heavy changes.
   - minor: multiple user-visible features or workflow changes.
   - patch: fixes, polish, or small internal changes.
   - If the signal is mixed or ambiguous, ask the user for `major`, `minor`, `patch`, or an explicit semver version.
5. Run the helper script:

```bash
node scripts/release-new-version.mjs --yes
```

Use `--kind=major`, `--kind=minor`, `--kind=patch`, or `--version=x.y.z` when the user gave a specific choice.

## What The Script Does

- Pulls from `origin/main`.
- Updates `apps/desktop/package.json` and `bun.lock`.
- Adds a new `CHANGELOG.md` entry when one is missing.
- Stages changelog, package metadata, the website changelog page, and this skill.
- Runs `bun run check-types`.
- Commits the release changes.
- Pushes the branch.
- Creates a GitHub PR against `main`.

## After The PR Lands

The repository release workflow is tag-driven. Create and push `vX.Y.Z` from `main` after merge to build, notarize, and publish the draft GitHub Release:

```bash
git checkout main
git pull --ff-only origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```
