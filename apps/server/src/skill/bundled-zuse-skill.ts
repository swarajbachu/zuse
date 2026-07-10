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
\`https://zuse.dev/schemas/\`.

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
