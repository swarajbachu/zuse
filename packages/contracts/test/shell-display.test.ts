import { describe, expect, it } from "vitest";

import {
  isRedundantShellDescription,
  unwrapShellCommand,
} from "../src/shell-display.ts";

describe("unwrapShellCommand", () => {
  it("unwraps the real Codex /bin/zsh -lc fixture", () => {
    expect(
      unwrapShellCommand(`/bin/zsh -lc "sed -n '1,220p' package.json"`),
    ).toBe("sed -n '1,220p' package.json");
  });

  it("handles escaped nested double quotes", () => {
    expect(unwrapShellCommand(`bash -c "echo \\"hi\\""`)).toBe('echo "hi"');
    expect(unwrapShellCommand(`/usr/bin/bash -lc "foo \\"bar\\" baz"`)).toBe(
      'foo "bar" baz',
    );
  });

  it("handles single-quoted commands and '\\'' splices", () => {
    expect(unwrapShellCommand(`bash -lc 'echo hi'`)).toBe("echo hi");
    expect(unwrapShellCommand(`zsh -c 'it'\\''s fine'`)).toBe("it's fine");
  });

  it("accepts a bare remainder after -c", () => {
    expect(unwrapShellCommand("sh -c echo hi")).toBe("echo hi");
    expect(unwrapShellCommand("dash -c ls -la")).toBe("ls -la");
  });

  it("accepts flag clusters that contain c (-lc, -cl)", () => {
    expect(unwrapShellCommand(`/bin/zsh -lc "git status"`)).toBe("git status");
    expect(unwrapShellCommand(`fish -cl "pwd"`)).toBe("pwd");
  });

  it("bails when there is no -c flag", () => {
    const raw = "/bin/zsh -l git status";
    expect(unwrapShellCommand(raw)).toBe(raw);
    expect(unwrapShellCommand("bash git status")).toBe("bash git status");
  });

  it("bails on trailing args after a quoted string", () => {
    const raw = `bash -c "echo hi" --extra`;
    expect(unwrapShellCommand(raw)).toBe(raw);
  });

  it("bails on empty inner command", () => {
    expect(unwrapShellCommand(`bash -c ""`)).toBe(`bash -c ""`);
    expect(unwrapShellCommand(`bash -c ''`)).toBe(`bash -c ''`);
  });

  it("bails on long options before -c", () => {
    const raw = `bash --norc -c "echo hi"`;
    expect(unwrapShellCommand(raw)).toBe(raw);
  });

  it("unwraps once, not recursively", () => {
    expect(unwrapShellCommand(`/bin/zsh -lc "bash -c 'inner'"`)).toBe(
      "bash -c 'inner'",
    );
  });

  it("preserves && chains and multiline inners", () => {
    expect(
      unwrapShellCommand(`/bin/zsh -lc "git status --short && git branch"`),
    ).toBe("git status --short && git branch");
    expect(unwrapShellCommand(`/bin/zsh -lc "echo one\necho two"`)).toBe(
      "echo one\necho two",
    );
  });

  it("returns non-shell strings unchanged", () => {
    expect(unwrapShellCommand("git status")).toBe("git status");
    expect(unwrapShellCommand("")).toBe("");
  });
});

describe("isRedundantShellDescription", () => {
  it("treats empty / whitespace-only as redundant", () => {
    expect(isRedundantShellDescription("", "git status")).toBe(true);
    expect(isRedundantShellDescription("   ", "git status")).toBe(true);
  });

  it("matches exact command and collapsed whitespace", () => {
    expect(isRedundantShellDescription("git status", "git status")).toBe(true);
    expect(isRedundantShellDescription("git   status", "git status")).toBe(
      true,
    );
  });

  it("matches first line of a multiline command", () => {
    expect(isRedundantShellDescription("echo one", "echo one\necho two")).toBe(
      true,
    );
  });

  it("matches the unwrapped command and its first line", () => {
    const wrapped = `/bin/zsh -lc "sed -n '1,220p' package.json"`;
    expect(
      isRedundantShellDescription("sed -n '1,220p' package.json", wrapped),
    ).toBe(true);
    expect(isRedundantShellDescription(wrapped, wrapped)).toBe(true);
  });

  it("treats truncated-prefix titles as redundant", () => {
    expect(
      isRedundantShellDescription(
        "git status --short && git bran",
        "git status --short && git branch",
      ),
    ).toBe(true);
    expect(
      isRedundantShellDescription(
        "sed -n",
        `/bin/zsh -lc "sed -n '1,220p' package.json"`,
      ),
    ).toBe(true);
  });

  it("keeps genuine human summaries", () => {
    expect(
      isRedundantShellDescription("Show working tree status", "git status"),
    ).toBe(false);
    expect(isRedundantShellDescription("List files", "ls -la")).toBe(false);
  });
});
