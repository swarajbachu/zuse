import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundledZuseSkillPath,
  ensureBundledZuseSkillInstalled,
} from "../src/skill/bundled-zuse-skill.ts";

describe("bundled Zuse skill installer", () => {
  it("installs Claude and Codex native skill files idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "zuse-skill-"));
    try {
      const claudePath = ensureBundledZuseSkillInstalled("claude", home);
      const codexPath = ensureBundledZuseSkillInstalled("codex", home);

      expect(claudePath).toBe(
        join(home, ".claude", "skills", "zuse", "SKILL.md"),
      );
      expect(codexPath).toBe(
        join(home, ".codex", "skills", "zuse", "SKILL.md"),
      );
      expect(existsSync(claudePath!)).toBe(true);
      expect(existsSync(codexPath!)).toBe(true);

      writeFileSync(claudePath!, "stale", "utf8");
      ensureBundledZuseSkillInstalled("claude", home);
      const installedClaudeSkill = readFileSync(claudePath!, "utf8");
      const installedCodexSkill = readFileSync(codexPath!, "utf8");
      expect(installedClaudeSkill).toContain("name: zuse");
      expect(installedClaudeSkill).toContain("zuse-orchestration");
      expect(installedClaudeSkill).toContain("Workspaces vs chat threads");
      expect(installedClaudeSkill).toContain("whoami");
      expect(installedClaudeSkill).toContain("list_models");
      expect(installedClaudeSkill).toContain("create_thread");
      expect(installedCodexSkill).toContain("zuse-orchestration");
      expect(installedCodexSkill).toContain("Do not substitute");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not install unsupported provider skill files", () => {
    const home = mkdtempSync(join(tmpdir(), "zuse-skill-"));
    try {
      expect(bundledZuseSkillPath("grok", home)).toBeNull();
      expect(ensureBundledZuseSkillInstalled("grok", home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
