---
name: release-new-version
description: Prepare and publish Zuse releases with curated notes and verified artifacts. Use for release requests; default to Preview unless the user explicitly requests Stable or promotion.
---

# Release New Version

Run from the Zuse repository root. **Release as Preview by default.** A bare
"release", "release everything", bump kind, or version number selects Preview;
a number such as `0.22.0` is its target Stable version. Publish Stable only when
the user explicitly requests Stable or promotion. Keep an explicitly selected
channel for the current release; subsequent unspecified releases default to Preview.

Read [the desktop release guide](../../../docs/desktop-release-channels.md) for
workflow inputs, compatibility gates, bootstrap behavior, and recovery. Use the
existing release workflow and shared version tooling as the source of truth.

## Prepare

1. Inspect the worktree and fetch current `origin/main` and tags. When the request
   includes branch work, create its PR and land it after validation before
   releasing. Resolve the exact main commit to ship; do not release unmerged work.
2. Read GitHub's latest Stable release and published Preview releases. Packaged
   versions can advance without a version-bump commit, so `package.json` alone
   does not identify the last release.
3. Inventory changes since the previous release on the chosen channel, falling
   back to Stable for the first Preview. Read relevant diffs and tests for every
   material release note. "All current stuff" includes all merged changes since
   that baseline, not just the current PR.
4. For Preview, reuse an unreleased target version already being previewed when
   appropriate; otherwise choose the next minor version for new capabilities or
   the next patch for fixes. Honor an explicit target. The workflow allocates the
   increasing `-preview.N` suffix from tags and releases, including reservations.
5. Write curated Markdown notes to a temporary file and show the selected channel,
   target, source commit, and notes. An existing request to release authorizes
   publication; another confirmation is unnecessary unless a material decision
   remains unresolved.

## Release notes

Use `### Added`, `### Changed`, and `### Fixed` in that order; omit empty sections.
Every bullet must be supported by the diff, tests, commit body, or PR description.
Describe what users can do, where behavior changes, and which defects are fixed.
Give important capabilities enough detail to explain their use. Deduplicate related
changes and omit internal housekeeping unless it affects users or operators.

## Publish Preview (default)

After the selected changes are merged and applicable checks pass, dispatch:

```bash
gh workflow run release.yml --ref main \
  -f channel=preview \
  -f "ref=$release_sha" \
  -f "version=$target_version" \
  -F "notes=@$notes_file"
```

Preview is a GitHub prerelease and must leave the latest Stable release unchanged.
Run compatibility verification against the current Stable checkout. If a gate
fails, fix the cause or report the specific blocker; publishing Stable is not a
fallback for a failed Preview. Follow the release guide for the first Preview
when existing Stable installations do not yet expose the channel selector.

## Publish Stable (explicit request only)

Normally promote a published Preview tag. Use curated notes covering **all changes
since the previous Stable release**, not just the latest Preview increment:

```bash
gh workflow run release.yml --ref main \
  -f channel=stable \
  -f "preview_tag=$preview_tag" \
  -F "notes=@$notes_file"
```

The workflow rebuilds that Preview's exact source commit with its final version.
For an explicitly requested Stable fix that is not a promotion, the existing
`scripts/release-new-version.mjs` helper prepares the release PR and changelog;
merge it after validation and tag the exact merged commit. This helper is
Stable-only and is not the entrypoint for default release requests.

## Verify completion

Locate the dispatched run using the workflow, branch, dispatch time, and resolved
commit; wait for all required jobs. Read back the public release's tag, title,
body, prerelease status, and assets. Confirm the platform archives and updater
manifests exist, notes match the curated file, and a Preview did not change Latest.
A running workflow, draft, failed upload, missing artifact, or empty release body
is pending or blocked, not a completed release.

Report the PR/merge URL, released version and channel, release URL, validation,
and any remaining blocker. Retry failed jobs using the documented recovery flow;
never overwrite a published version.
