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
provider skills, user settings, keybindings, or schema URLs.

Canonical repository settings live in \`.zuse/settings.toml\`. Use
\`file_include_globs\` for files that should be linked from the main checkout
into every worktree. Public schemas are served from
\`https://zuse.dev/schemas/\`.
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
