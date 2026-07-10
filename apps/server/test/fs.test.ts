import { describe, expect, it } from "vitest";
import * as path from "node:path";

import { ensureUnderCwd, isUnderCwd } from "../src/provider/drivers/acp/fs.ts";

const cwd = "/work/repo";

describe("isUnderCwd", () => {
  it("accepts the cwd itself and nested paths", () => {
    expect(isUnderCwd("/work/repo", cwd)).toBe(true);
    expect(isUnderCwd("/work/repo/src/a.ts", cwd)).toBe(true);
    expect(isUnderCwd("/work/repo/deep/nested/file", cwd)).toBe(true);
  });

  it("rejects parent traversal that escapes the cwd", () => {
    expect(isUnderCwd("/work/repo/../secret", cwd)).toBe(false);
    expect(isUnderCwd("/work/repo/../../etc/passwd", cwd)).toBe(false);
  });

  it("rejects sibling directories with a shared prefix", () => {
    // `/work/repo-evil` shares the `/work/repo` string prefix but is NOT under cwd.
    expect(isUnderCwd("/work/repo-evil/file", cwd)).toBe(false);
  });

  it("rejects unrelated absolute paths", () => {
    expect(isUnderCwd("/etc/passwd", cwd)).toBe(false);
  });

  it("resolves relative paths against process cwd before comparing", () => {
    // A traversal that normalizes back under cwd is accepted.
    expect(isUnderCwd("/work/repo/src/../src/a.ts", cwd)).toBe(true);
  });
});

describe("ensureUnderCwd", () => {
  it("returns the resolved absolute path for in-workspace targets", () => {
    expect(ensureUnderCwd("/work/repo/src/a.ts", cwd)).toBe(
      path.resolve("/work/repo/src/a.ts"),
    );
  });

  it("throws when the path escapes the workspace", () => {
    expect(() => ensureUnderCwd("/work/repo/../secret", cwd)).toThrow(
      /escapes workspace/,
    );
    expect(() => ensureUnderCwd("/etc/passwd", cwd)).toThrow(
      /escapes workspace/,
    );
  });
});
