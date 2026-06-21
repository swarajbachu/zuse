import { describe, expect, it } from "bun:test";

import {
  applyClaudeWorktreeEnv,
  claudeWorktreePrompt,
} from "../src/provider/drivers/claude-worktree-prompt.ts";

describe("claudeWorktreePrompt", () => {
  it("pins Claude's location answers to the effective session cwd", () => {
    const cwd = "/Users/whizzy/.memoize/monkit-ea6cdfdd/cherubi";
    const prompt = claudeWorktreePrompt(cwd);
    const forbiddenAppName = ["Con", "ductor"].join("");

    expect(prompt).toContain(cwd);
    expect(prompt).toContain("authoritative location");
    expect(prompt).toContain("If the user asks where you are located");
    expect(prompt).toContain("Do not answer with the repository's main checkout path");
    expect(prompt).toContain("Memoize worktree context");
    expect(prompt).not.toContain(forbiddenAppName);
    expect(prompt).not.toContain(["work", "space"].join(""));
  });

  it("pins Claude's launch environment to the effective session cwd", () => {
    const cwd = "/Users/whizzy/.memoize/monkit-ea6cdfdd/cherubi";
    const env = applyClaudeWorktreeEnv(
      {
        PWD: "/Users/whizzy/Developer/startups/monkit",
        OLDPWD: "/Users/whizzy/Developer/startups",
        INIT_CWD: "/Users/whizzy/Developer/startups/monkit",
        PATH: "/usr/bin",
      },
      cwd,
    );

    expect(env.PWD).toBe(cwd);
    expect(env.MEMOIZE_WORKTREE_CWD).toBe(cwd);
    expect(env[["CON", "DUCTOR_WORKSPACE_CWD"].join("")]).toBeUndefined();
    expect(env.OLDPWD).toBeUndefined();
    expect(env.INIT_CWD).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});
