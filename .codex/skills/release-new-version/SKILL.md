---
name: release-new-version
description: Prepare and publish a new Zuse version with curated release notes, version metadata, a release PR, a version tag, and verified release artifacts.
---

# Release New Version

Run this skill from the Zuse repository root. A release request means carrying the workflow through the tag and release workflow when repository access and checks permit it.

## Release Standard

Release notes are a product summary, not a commit or PR dump. Every note must be supported by the diff, commit body, tests, or PR description.

Use these sections in this order and omit empty sections:

1. `Added` — a capability users can do now that they could not do before.
2. `Changed` — a meaningful change to an existing workflow, behavior, performance characteristic, documentation surface, or compatibility guarantee.
3. `Fixed` — a defect, regression, crash, reliability issue, or incorrect behavior that was corrected.

Quality rules:

- Start with the user-visible outcome; mention implementation detail only when it helps users act.
- Do not paste raw commit titles, conventional-commit prefixes, PR numbers, or repository housekeeping.
- Deduplicate related commits into one accurate product change.
- Give an important new feature a complete explanation of what is available and why or where it matters. Do not reduce it to a PR reference.
- Keep routine bullets to one sentence. An important feature may use two concise sentences in one bullet.
- Exclude refactors, test-only work, dependency churn, and internal tooling unless they materially affect users or operators.
- Use `Fixed`, not `Changed`, merely because a fix altered code.

## Workflow

1. Inspect `git status --short --branch`. Do not mix unrelated dirty work into a release.
2. Fetch `origin`, base the release on current `origin/main`, and confirm the package version tag exists.
3. Build an evidence inventory from `git log`, `git diff --stat`, relevant diffs, and PR bodies between `v<current-version>` and `origin/main`. Inspect details for any important or ambiguous change.
4. Choose the bump:
   - major: breaking compatibility or migration requirements.
   - minor: a meaningful new user-visible capability or workflow.
   - patch: fixes, polish, documentation, or internal changes only.
   - Ask only when the evidence does not support a clear choice and the user did not specify one.
5. Draft a temporary Markdown notes file containing only the curated `### Added`, `### Changed`, and `### Fixed` sections. Show the proposed version and notes before mutation when the request is interactive.
6. Run the helper with the explicit decision and curated notes:

```bash
node scripts/release-new-version.mjs --version=x.y.z --notes-file=/absolute/path/to/release-notes.md --yes
```

Use `--kind=major`, `--kind=minor`, or `--kind=patch` instead of `--version` when appropriate. The helper can generate a categorized fallback, but important releases must use curated notes.

7. Inspect the resulting `CHANGELOG.md`, generated website changelog, commit, and PR. Confirm category accuracy, user-facing explanations, the version, and the exact checks run.
8. Wait for required PR checks, merge using repository policy, update from `origin/main`, and tag the exact merged release commit:

```bash
git fetch --prune origin
git tag vX.Y.Z origin/main
git push origin vX.Y.Z
```

9. Verify the tag-triggered release workflow succeeds and that the expected GitHub Release and artifacts exist. If anything is still running or blocked, report it as pending rather than done.

## What The Helper Does

- Refuses a dirty tree and pulls the latest `origin/main`.
- Determines and validates the next semantic version.
- Moves curated `Unreleased` notes into the new release and cleanly groups fallback notes as `Added`, `Changed`, and `Fixed`.
- Updates `apps/desktop/package.json`, `bun.lock`, `CHANGELOG.md`, and the website changelog data.
- Runs the website content generator and `bun run check-types`.
- Commits, pushes the release branch, and creates a PR whose summary reflects the actual release notes.

## Completion Report

Report release state with explicit outcomes:

- version and bump reason;
- release-note highlights by category;
- validation commands and results;
- PR and merge state;
- tag and release-workflow state;
- published artifacts, or the precise remaining blocker.
