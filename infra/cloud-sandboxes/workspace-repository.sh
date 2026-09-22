#!/usr/bin/env bash
set -euo pipefail

workspace="${ZUSE_CLOUD_WORKSPACE_ROOT:?}"
branch="${ZUSE_BRANCH:?}"
base_ref="${ZUSE_BASE_REF:?}"
# Never reset a recovered checkout: it may already contain the user's edits.
git -C "$workspace" rev-parse --git-dir >/dev/null
git check-ref-format --branch "$branch" >/dev/null
if [[ "$(git -C "$workspace" branch --show-current)" != "$branch" ]]; then
  if git -C "$workspace" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$workspace" switch "$branch"
  else
    git -C "$workspace" rev-parse --verify "$base_ref^{commit}" >/dev/null 2>&1 || \
      base_ref="origin/${base_ref#origin/}"
    git -C "$workspace" switch -c "$branch" "$base_ref"
  fi
fi
git -C "$workspace" remote set-url origin "${ZUSE_REPOSITORY_URL:?}"
