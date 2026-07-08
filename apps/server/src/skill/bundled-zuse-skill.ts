import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProviderId } from "@zuse/wire";

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

When a Zuse-managed chat has autonomy enabled, Zuse exposes a provider-neutral
MCP server named \`zuse-orchestration\`. Use these tools for agent-controlled
parallel work instead of provider-specific built-ins:

**Workspaces vs chat threads.** Zuse's model is project → workspaces (git worktrees) → chat threads. One workspace can host many chat threads; \`worktreeId: null\` means the project's main checkout. \`create_worktree\` makes a new workspace (isolated branch + PR); \`create_thread\` makes a new conversation inside a workspace. To add a thread to an existing workspace, call \`create_thread\` with that \`worktreeId\` — do not create a workspace per thread unless the work needs its own branch/PR. Use \`whoami\` / \`list_threads\` (both return \`worktreeId\`) to see the topology before spawning.

- \`whoami\`: inspect the current Zuse session, chat, project, provider, model, and autonomy level.
- \`list_threads\`: list sibling and spawned Zuse chat threads.
- \`list_models\`: list provider/model choices for \`create_thread\`.
- \`read_thread\`: read recent messages from a Zuse thread.
- \`create_worktree\`: create an isolated Zuse workspace (git worktree) that can host multiple chat threads.
- \`create_thread\`: create a new Zuse chat thread inside an existing workspace (pass \`worktreeId\`) or the main checkout (omit it).
- \`send_to_thread\`: send follow-up instructions to an existing thread.

Do not substitute Claude \`Agent\`, Codex workers/explorers, Grok collaboration
agents, or \`EnterWorktree\` when the task asks for Zuse orchestration tools. The
expected smoke flow is:

1. Call \`whoami\`.
2. Call \`list_threads\`.
3. Call \`list_models\` when you need to pick a provider/model.
4. Call \`create_worktree\` when isolated implementation is needed.
5. Call \`create_thread\`, passing the \`worktreeId\` when using that worktree and optional \`providerId\` / \`model\` from \`list_models\`.
6. Call \`read_thread\` to inspect the spawned thread.

If \`zuse-orchestration\` is not available, report that autonomy tools are not
registered for this session instead of silently using another provider feature.
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
