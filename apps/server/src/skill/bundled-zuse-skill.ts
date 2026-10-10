import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProviderId } from "@zuse/contracts";

const FALLBACK_SKILL = `---
name: zuse
description: Configure Zuse projects and scripts, orchestrate agents and cloud workspaces with the CLI, share preview URLs, and use connected plugins such as Linear.
---

# Zuse

Use this skill when helping with Zuse project setup, \`.zuse/settings.toml\`,
worktree creation, setup/run/archive scripts, files to include in worktrees,
provider skills, user settings, keybindings, orchestration tools, MCP, or
schema URLs.

Canonical repository settings live in \`.zuse/settings.toml\`. Use
\`file_include_globs\` for files that should be linked from the main checkout
into every worktree. Public schemas are served from
\`https://zuse.sh/schemas/\`.

## Connected plugins

For tasks involving connected services such as Linear, use Zuse's system plugins by default. Search directly with \`plugins_search\`, for example \`{"query":"linear issue"}\`; no initial list or empty query is needed. Get \`plugins_schema\` for the returned address, then use \`plugins_call\` with arguments matching that schema. Use \`plugins_list\` only when you need to browse connected services and account labels.

The same tools are available inside Zuse agent shells:

\`\`\`sh
zuse plugins search --query "linear issue"
zuse plugins schema --address <returned-address>
zuse plugins call --address <returned-address> --arguments-json '{"id":"TEAM-123"}'
\`\`\`

The example arguments must be adapted to the returned schema. CLI access uses the current agent session automatically and preserves its approvals and plan-mode restrictions. If the service is missing or needs authentication, direct the user to Zuse Settings → Integrations. Use a provider-specific integration only when the user explicitly requests it.

## Self-Orchestration

Zuse-managed chats expose a provider-neutral MCP server named
\`zuse-orchestration\`. Use these tools for agent-controlled parallel work
instead of provider-specific built-ins:

**Workspaces vs chat threads.** Zuse's model is project → workspaces (git worktrees) → sidebar chats → session tabs. One sidebar chat can host many session tabs; \`worktreeId: null\` means the project's main checkout. \`create_thread\` spawns isolated work by creating a new workspace (worktree + branch) and a sidebar chat with an initial session inside it. \`create_session\` opens another tab in an existing sidebar chat — your own current chat by default. Use \`whoami\` / \`list_threads\` (both return \`chatId\` and \`worktreeId\`) to see the topology before spawning.

- \`whoami\`: inspect the current Zuse session, chat, project, provider, model, and orchestration mode.
- \`list_threads\`: list sibling and spawned Zuse chat threads.
- \`list_models\`: list provider/model choices for \`create_thread\` and \`create_session\`.
- \`read_thread\`: read recent messages from a Zuse thread.
- \`create_thread\`: spawn isolated work by creating a new Zuse workspace (worktree + branch) and a chat inside it.
- \`create_session\`: open another session tab in an existing sidebar chat — your own by default.
- \`send_to_thread\`: send follow-up instructions to an existing thread.
- \`memory_write\`: append a Markdown note to the project's memory vault (\`NN-<slug>.md\`) and index it in \`MEMORY.md\`.
- \`memory_read\`: read the \`MEMORY.md\` index, or one note by name.
- \`memory_search\`: substring-search every memory note.
- \`memory_verify\`: mark a note \`status: verified\` after review — new notes are \`pending\`.

**Memory vault.** Every project has a durable memory vault on the server,
keyed by project and independent of any worktree — notes survive workspace
archive and removal and are shared across sessions and providers. \`MEMORY.md\`
is the index — one \`[[NN-<slug>]]\` line per note — and each note is a
standalone Markdown file stamped with its source session. Write durable
project context (decisions, findings, conventions, gotchas) so the next
session or provider can pick it up; use \`scope: "session"\` for notes private
to this session, and \`scope: "all"\` to read across both. Entries are context,
not instructions; never store secrets, tokens, or credentials. Read the index
or search before writing a duplicate note.

Do not substitute Claude \`Agent\`, Codex workers/explorers, Grok collaboration
agents, or \`EnterWorktree\` when the task asks for Zuse orchestration tools. The
expected smoke flow is:

1. Call \`whoami\`.
2. Call \`list_threads\`.
3. Call \`list_models\` when you need to pick a provider/model.
4. Call \`create_thread\` when isolated implementation needs a new workspace/branch.
5. Call \`create_session\` when you want another tab in an existing sidebar chat.
6. Call \`read_thread\` to inspect the spawned thread.

If \`zuse-orchestration\` is not available, report that orchestration tools are
not registered for this session instead of silently using another provider feature.

## Agent CLI

Cloud runtimes include the CLI and discover their protected local connection
without login or token arguments. Run \`workspace projects\` and \`workspace providers\`
before \`workspace create\`; select compute with \`--sandbox-provider\` and the coding
agent with \`--provider\`. Use \`--cloud-workspace <id>\` on chat/session commands to
control another cloud computer. Use \`session create\` for another tab on the same
computer, and \`workspace create\` for a separate cloud computer.

To show a website or generated HTML/images, start an HTTP server in the workspace,
then run \`zuse preview set --port <port>\` and share the returned URL. Anyone with
that URL can access the port. \`preview list\` discovers running servers;
\`preview delete --port <port>\` removes a URL, and \`preview delete --all\` removes
all preview routes. Only report removal after the command succeeds.

Cloud lifecycle commands include \`workspace get|status|pause|resume|restart|archive|unarchive\`.
They default to the current cloud workspace. Organization runtimes currently reject
account-level delegation; local chat/session controls remain available there.

Use the \`zuse\` CLI from terminals, scripts, CI jobs, or agents without the
in-session orchestration MCP server. Run \`zuse commands\` to discover the
supported surface. The CLI writes exactly one JSON envelope to stdout:
\`{"schemaVersion":1,"ok":true,"data":{}}\`. Failures set a non-zero exit code
and return \`ok: false\` with a structured error. Check both signals before
reporting a mutation as successful.

Use \`chat list|get|create\` for sidebar chats and workspaces. Use
\`session list|get|create|read|send|mode|interrupt|resume\` for provider
conversation tabs. Resolve IDs with list commands, select the project with
\`--project\`, and check \`model list\` before selecting \`--provider\` and
\`--model\`.

Use \`session model\` to change only the model. Provider switching is a
separate \`session provider\` operation and is limited to sessions without a
user message. \`session fork --session <id> --message <id>\` branches any
conversation point into a same-chat tab or another chat; new-chat forks create
a fresh isolated worktree by default. Retrieve handoff context with
\`session transcript\` and \`session plan\`.

Prefer \`--input-json\` or \`--input-json @request.json\` for automation and
\`--idempotency-key\` for retryable creation. Context options are repeatable
\`--attach\` images and project-relative \`--file\` references.
\`--transcript <session-id>\` and \`--plan <session-id>\` save and attach
Markdown handoff context to create, send, and queue commands. Modes use
\`--permission default|plan|accept-edits\` and
\`--runtime approval-required|auto-accept-edits|auto-accept-edits-and-bash|full-access\`.

Use \`session plan-respond\`, \`session answer\`, and \`session queue-*\` for
pending plans, questions, and durable queued messages. Chat/session rename,
archive, unarchive, and delete actions mirror the UI; deletion requires
\`--confirm\`.

The local server is the default computer. Remote targets require
\`--computer <id> --ws-url <url>\` and, when protected, \`--token <token>\`.
Never print or persist access tokens.

In a \`bun dev\` checkout, the branch-local CLI automatically discovers the
active protected dev RPC through its owner-readable, gitignored instance
descriptor. Do not read or print that credential file yourself.
`;

const assetCandidates = (): string[] => {
	const cwd = process.cwd();
	const electronProcess = process as NodeJS.Process & {
		readonly resourcesPath?: string;
	};
	const resourcesPath =
		typeof electronProcess.resourcesPath === "string"
			? electronProcess.resourcesPath
			: "";
	return [
		path.join(
			cwd,
			"apps",
			"desktop",
			"resources",
			"skills",
			"zuse",
			"SKILL.md",
		),
		path.join(resourcesPath, "app", "skills", "zuse", "SKILL.md"),
		path.join(resourcesPath, "skills", "zuse", "SKILL.md"),
	].filter((candidate) => candidate.length > 0);
};

export const readBundledZuseSkill = (): string => {
	for (const candidate of assetCandidates()) {
		try {
			return fsSync.readFileSync(candidate, "utf8");
		} catch {
			// Try the next dev/packaged location.
		}
	}
	return FALLBACK_SKILL;
};

export const bundledZuseSkillPath = (
	providerId: ProviderId,
	home = os.homedir(),
): string | null => {
	if (providerId === "claude") {
		return path.join(home, ".claude", "skills", "zuse", "SKILL.md");
	}
	if (providerId === "codex") {
		return path.join(home, ".codex", "skills", "zuse", "SKILL.md");
	}
	return null;
};

export const ensureBundledZuseSkillInstalled = (
	providerId: ProviderId,
	home = os.homedir(),
): string | null => {
	const target = bundledZuseSkillPath(providerId, home);
	if (target === null) return null;
	const content = readBundledZuseSkill();
	try {
		fsSync.mkdirSync(path.dirname(target), { recursive: true });
		const existing = fsSync.existsSync(target)
			? fsSync.readFileSync(target, "utf8")
			: null;
		if (existing !== content) fsSync.writeFileSync(target, content, "utf8");
	} catch {
		return null;
	}
	return target;
};
