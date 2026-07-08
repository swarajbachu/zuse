---
name: zuse
description: Configure and troubleshoot Zuse projects, repository settings, worktrees, scripts, schemas, and native provider skills.
---

# Zuse

Use this skill when helping with Zuse project setup, `.zuse/settings.toml`,
worktree creation, setup/run/archive scripts, files to include in worktrees,
provider skills, user settings, keybindings, orchestration tools, MCP, or
schema URLs.

Zuse is a local-first macOS app for running coding agents against registered
projects and git worktrees. Repository-shared configuration lives in
`.zuse/settings.toml` and should be committed when it is intended for the
team.

## Repository Settings

Canonical repository settings file:

```toml
# Zuse repository settings. Commit this file to share setup with your team.
# Add files below that should be linked from the main checkout into every Zuse worktree.
schemaVersion = 1
autoCreateWorktree = false
archiveRemoveWorktree = false

file_include_globs = [
  ".env",
  ".env.local",
  ".env.*.local",
]

[scripts]
setup = "bun install"
run = "bun run dev"
archive = ""
auto_run_after_setup = false

[environment_variables]
NODE_ENV = "development"
```

Important fields:

- `file_include_globs`: file patterns linked from the main checkout into every
  worktree. Existing files in the worktree are never overwritten.
- `[scripts].setup`: runs after a worktree is created.
- `[scripts].run`: runs when the user starts the repository run script.
- `[scripts].archive`: runs before archiving a worktree-backed chat.
- `[environment_variables]`: key/value pairs passed to setup, run, and archive
  scripts.

Legacy `.zuse/settings.json` and `.worktreeinclude` may be read for backward
compatibility, but `.zuse/settings.toml` is the shared format to create or edit.

## Worktree Includes

Prefer explicit `file_include_globs` entries in `.zuse/settings.toml` for local
files that every worktree needs. Typical entries are `.env`,
`.env.local`, `.env.*.local`, app-specific env files, local certificates, or
private config files. Do not commit secrets themselves.

## Schemas

Public schemas are served by the Zuse website:

- `https://zuse.dev/schemas/settings.schema.json`
- `https://zuse.dev/schemas/repository-settings.schema.json`
- `https://zuse.dev/schemas/keybindings.schema.json`

Use these URLs in editor configuration and documentation examples.

## Self-Orchestration

When a Zuse-managed chat has autonomy enabled, Zuse exposes a provider-neutral
MCP server named `zuse-orchestration`. Use these tools for agent-controlled
parallel work instead of provider-specific built-ins:

- `whoami`: inspect the current Zuse session, chat, project, and autonomy level.
- `list_threads`: list sibling and spawned Zuse chat threads.
- `read_thread`: read recent messages from a Zuse thread.
- `create_worktree`: create an isolated Zuse git worktree.
- `create_thread`: create a new Zuse chat thread, optionally in a worktree.
- `send_to_thread`: send follow-up instructions to an existing thread.

Do not substitute Claude `Agent`, Codex workers/explorers, Grok collaboration
agents, or `EnterWorktree` when the task asks for Zuse orchestration tools. The
expected smoke flow is:

1. Call `whoami`.
2. Call `list_threads`.
3. Call `create_worktree` when isolated implementation is needed.
4. Call `create_thread`, passing the `worktreeId` when using that worktree.
5. Call `read_thread` to inspect the spawned thread.

If `zuse-orchestration` is not available, report that autonomy tools are not
registered for this session instead of silently using another provider feature.
