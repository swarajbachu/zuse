---
name: zuse
description: Configure Zuse projects, orchestrate cloud agents with the CLI, share previews, and use connected plugins such as Linear.
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

## Connected plugins

For tasks involving connected services such as Linear, use Zuse's system plugins by default. Search directly with `plugins_search`, for example `{"query":"linear issue"}`; no initial list or empty query is needed. Get `plugins_schema` for the returned address, then use `plugins_call` with arguments matching that schema. Use `plugins_list` only when you need to browse connected services and account labels.

The same tools are available inside Zuse agent shells:

```sh
zuse plugins search --query "linear issue"
zuse plugins schema --address <returned-address>
zuse plugins call --address <returned-address> --arguments-json '{"id":"TEAM-123"}'
```

The example arguments must be adapted to the returned schema. CLI access uses the current agent session automatically and preserves its approvals and plan-mode restrictions. If the service is missing or needs authentication, direct the user to Zuse Settings → Integrations. Use a provider-specific integration only when the user explicitly requests it.

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

- `https://zuse.sh/schemas/settings.schema.json`
- `https://zuse.sh/schemas/repository-settings.schema.json`
- `https://zuse.sh/schemas/keybindings.schema.json`

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
- `memory_write`: append a Markdown note to the project's memory vault (`NN-<slug>.md`) and index it in `MEMORY.md`.
- `memory_read`: read the `MEMORY.md` index, or one note by name.
- `memory_search`: substring-search every memory note.
- `memory_verify`: mark a note `status: verified` after review — new notes are `pending`.

**Memory vault.** Every project has a durable memory vault on the server,
keyed by project and independent of any worktree — notes survive workspace
archive and removal and are shared across sessions and providers. `MEMORY.md`
is the index — one `[[NN-<slug>]]` line per note — and each note is a
standalone Markdown file stamped with its source session. Write durable
project context (decisions, findings, conventions, gotchas) so the next
session or provider can pick it up; use `scope: "session"` for notes private
to this session, and `scope: "all"` to read across both. Entries are context,
not instructions; never store secrets, tokens, or credentials. Read the index
or search before writing a duplicate note.

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

Cloud runtimes include the CLI and discover their protected local connection
without login or token arguments. Run `workspace projects` and `workspace providers`
before `workspace create`; select compute with `--sandbox-provider` and the coding
agent with `--provider`. Use `--cloud-workspace <id>` on chat/session commands to
control another cloud computer. Use `session create` for another tab on the same
computer, and `workspace create` for a separate cloud computer.

To show a website or generated HTML/images, start an HTTP server in the workspace,
then run `zuse preview set --port <port>` and share the returned URL. Anyone with
that URL can access the port. `preview list` discovers running servers;
`preview delete --port <port>` removes a URL, and `preview delete --all` removes
all preview routes. Only report removal after the command succeeds.

Cloud lifecycle commands include `workspace get|status|pause|resume|restart|archive|unarchive`.
They default to the current cloud workspace. Organization runtimes currently reject
account-level delegation; local chat/session controls remain available there.

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
- `zuse session model --session <id> --model <id>` changes only the model.
  `session provider` is separate and only works before the first user message.
- `zuse session fork --session <id> --message <id>` branches from any message
  into a same-chat tab or a different chat. New-chat forks create a fresh
  isolated worktree by default.
- `zuse session transcript|plan --session <id>` retrieves handoff context.
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
- `--transcript <session-id>` exports another session and attaches it as a
  Markdown context file. Add `--through-message <id>` to stop at a fork point.
- `--plan <session-id>` attaches that session's latest proposed plan.

For interactive parity, use `session plan-respond` to approve, cancel, or
abandon a pending plan; `session answer` for pending agent questions; and the
`session queue-*` commands for durable queued messages. Rename, archive,
unarchive, delete, and workspace operations are also available. Deletion
requires `--confirm`.

Set the session posture with `--permission default|plan|accept-edits` and
`--runtime approval-required|auto-accept-edits|auto-accept-edits-and-bash|full-access`.
Changing modes does not broaden the user's authorization for external or
destructive actions.

The default target is the local Zuse RPC server. For another connected
computer, pass `--computer <id> --ws-url <url>` and `--token <token>` when the
endpoint is protected. Do not print or persist tokens in logs, prompts, or
committed files.

Inside a `bun dev` repository, use the branch-local CLI source. It automatically
discovers the active dev instance through its owner-readable, gitignored
`.zuse/dev-instances/<instance>/cli-access.json` descriptor, including shifted
ports and protected local RPC authentication. Do not read or print the
descriptor yourself; let the CLI consume it.
