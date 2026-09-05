import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProviderId } from "@zuse/contracts";

const FALLBACK_SKILL = `---
name: zuse
description: Configure and troubleshoot Zuse projects, repository settings, worktrees, scripts, schemas, and native provider skills.
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
\`--attach\` images, project-relative \`--file\` references, and \`--linear\`
issue context. \`--transcript <session-id>\` and \`--plan <session-id>\` save
and attach Markdown handoff context to create, send, and queue commands. Modes use
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
