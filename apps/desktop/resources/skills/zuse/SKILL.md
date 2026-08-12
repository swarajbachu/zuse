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

**Workspaces vs chat threads.** Zuse's model is project → workspaces (git worktrees) → sidebar chats → session tabs. One sidebar chat can host many session tabs; `worktreeId: null` means the project's main checkout. `create_thread` spawns isolated work by creating a new workspace (worktree + branch) and a sidebar chat with an initial session inside it. `create_session` opens another tab in an existing sidebar chat — your own current chat by default. Use `whoami` / `list_threads` (both return `chatId` and `worktreeId`) to see the topology before spawning.

- `whoami`: inspect the current Zuse session, chat, project, provider, model, and autonomy level.
- `list_threads`: list sibling and spawned Zuse chat threads.
- `list_models`: list provider/model choices for `create_thread` and `create_session`.
- `read_thread`: read recent messages from a Zuse thread.
- `create_thread`: spawn isolated work by creating a new Zuse workspace (worktree + branch) and a chat inside it.
- `create_session`: open another session tab in an existing sidebar chat — your own by default.
- `send_to_thread`: send follow-up instructions to an existing thread.

Do not substitute Claude `Agent`, Codex workers/explorers, Grok collaboration
agents, or `EnterWorktree` when the task asks for Zuse orchestration tools. The
expected smoke flow is:

1. Call `whoami`.
2. Call `list_threads`.
3. Call `list_models` when you need to pick a provider/model.
4. Call `create_thread` when isolated implementation needs a new workspace/branch.
5. Call `create_session` when you want another tab in an existing sidebar chat.
6. Call `read_thread` to inspect the spawned thread.

If `zuse-orchestration` is not available, report that autonomy tools are not
registered for this session instead of silently using another provider feature.

## Agent CLI

Use the `zuse` CLI when orchestration must run from a terminal, script, CI job,
or an agent that does not have the in-session `zuse-orchestration` MCP server.
The CLI emits exactly one JSON envelope on stdout, including failures. Discover
the supported surface before automating it:

```bash
zuse commands
zuse computer list
zuse project list
zuse model list
```

The object shape is stable and machine-readable:

```json
{"schemaVersion":1,"ok":true,"data":{}}
```

Failures set a non-zero exit code and return `ok: false` with an error `code`,
`message`, and optional `details`. Check both the exit code and `ok`; never treat
the presence of JSON as proof that a mutation succeeded.

Zuse's CLI uses the same project → workspace → chat → session model as MCP:

- `zuse chat create` creates a sidebar chat and selects `--workspace fresh`,
  `main`, or an existing worktree ID.
- `zuse session create --chat <id>` adds a session tab to an existing chat.
- `zuse session send|read|mode|interrupt|resume --session <id>` operates on a
  specific provider conversation.
- `zuse thread create` aliases `chat create`; other `thread` actions alias the
  corresponding `session` action.

Resolve IDs with `chat list` and `session list` instead of guessing. Select a
project by ID, exact name, or path with `--project`; it is only inferred when
the current directory identifies exactly one registered project. Use
`--provider` and `--model` after checking `model list`.

For agent-safe input, prefer `--input-json '<object>'` or
`--input-json @request.json`. Use `--prompt-file -` to read a prompt from stdin.
Creation commands accept `--idempotency-key` so retrying after an uncertain
transport result does not intentionally create duplicate work.

Context can be attached while creating a chat or session, or while sending:

- `--attach <path>` uploads an image; repeat it for multiple images.
- `--file <project-relative-path>` adds a file or directory reference.
- `--linear <issue-id>` adds prepared issue context; use
  `--linear-workspace <id>` when needed to disambiguate the workspace.

Set the session posture with `--permission default|plan|accept-edits` and
`--runtime approval-required|auto-accept-edits|auto-accept-edits-and-bash|full-access`.
Changing modes does not broaden the user's authorization for external or
destructive actions.

The default target is the local Zuse RPC server. For another connected
computer, pass `--computer <id> --ws-url <url>` and `--token <token>` when the
endpoint is protected. Do not print or persist tokens in logs, prompts, or
committed files.
