# Feature: Git history

> **Deprecated.** This feature shipped in Phase 1 and is removed from the v1 UI in Phase 3 (chat-first MVP). The `git.*` RPCs in `@zuse/contracts` and `GitService` in `apps/server` remain, but they are no longer wired into any UI. We may bring this back as a right-pane tab post-1.0 if there's demand. See [phases/03-chat-mvp.md](../phases/03-chat-mvp.md) for the new layout.

Always-visible feed of recent commits for the active folder, plus a status summary.

## What we show in Phase 1

- Branch name + dirty file count at top
- List of last 50 commits: short SHA, subject, author, relative time
- Click commit → copy SHA (Phase 1); diff viewer (Phase 4)

## How we get the data

Spawn `git` directly:

```
git -C <folder> log -50 --pretty=format:%H%x00%h%x00%s%x00%an%x00%aI%x00%P
git -C <folder> status --porcelain=v2 --branch
```

Parse with simple split on `\x00` and `\n`. No `simple-git` or libgit2.

## Live updates

Poll `git rev-parse HEAD` every 2s on the active folder. If SHA changes, refetch log + status.

## Failure modes

- Folder isn't a git repo: pane shows "Not a git repository" with a "Run `git init`?" button
- `git` not on PATH: pane shows "Install git to use this feature" with link
- Repo is in detached HEAD / rebase / merge: status pane shows the state explicitly
