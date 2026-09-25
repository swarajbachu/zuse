#!/usr/bin/env bash
set -euo pipefail

workspace="${ZUSE_CLOUD_WORKSPACE_ROOT:?}"
branch="${ZUSE_BRANCH:?}"
base_ref="${ZUSE_BASE_REF:?}"
# Never reset a recovered checkout: it may already contain the user's edits.
git -C "$workspace" rev-parse --git-dir >/dev/null
git check-ref-format --branch "$branch" >/dev/null
git -C "$workspace" remote set-url origin "${ZUSE_REPOSITORY_URL:?}"
if [[ "$(git -C "$workspace" branch --show-current)" != "$branch" ]]; then
  if git -C "$workspace" show-ref --verify --quiet "refs/heads/$branch"; then
    # --merge preserves overlapping unstaged edits as conflicts, but can lose
    # staged changes. Keep Git's normal safety checks when the index is dirty.
    if git -C "$workspace" diff --cached --quiet; then
      git -C "$workspace" switch --merge "$branch"
    else
      git -C "$workspace" switch "$branch"
    fi
  else
    if [[ "$base_ref" =~ ^refs/pull/([1-9][0-9]*)/head$ ]]; then
      # GitHub does not include fork heads in a normal clone. Fetch the PR ref
      # from the connected base repository only when creating the branch.
      # FETCH_HEAD does not make the new branch track GitHub's read-only PR ref.
      git -C "$workspace" fetch --no-tags origin "$base_ref"
      base_ref=FETCH_HEAD
    fi
    git -C "$workspace" rev-parse --verify "$base_ref^{commit}" >/dev/null 2>&1 || \
      base_ref="origin/${base_ref#origin/}"
    git -C "$workspace" switch -c "$branch" "$base_ref"
  fi
fi
