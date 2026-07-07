import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as Path from "node:path";

import {
  isEnvFileName,
  linkEnvFiles,
  linkIncludedFiles,
} from "../src/worktree/layers/env-files.ts";

describe("isEnvFileName", () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".dev.vars", true],
    [".dev.vars.prod", true],
    [".env.example", false],
    [".env.sample", false],
    [".env.template", false],
    [".env.dist", false],
    [".envrc", false],
    ["env", false],
    ["package.json", false],
  ];
  for (const [name, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(isEnvFileName(name)).toBe(expected);
    });
  }
});

describe("linkEnvFiles", () => {
  let repo: string;
  let worktree: string;

  const write = async (root: string, rel: string, content: string) => {
    const abs = Path.join(root, rel);
    await fs.mkdir(Path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  };

  beforeEach(async () => {
    const base = await fs.mkdtemp(Path.join(os.tmpdir(), "env-files-"));
    repo = Path.join(base, "repo");
    worktree = Path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(Path.dirname(repo), { recursive: true, force: true });
  });

  it("symlinks root, nested, and Cloudflare env files; skips templates and pruned dirs", async () => {
    await write(repo, ".env", "ROOT=1");
    await write(repo, ".env.local", "ROOT_LOCAL=1");
    await write(repo, "apps/web/.env.production", "WEB=1");
    await write(repo, "apps/api/.dev.vars", "API=1");
    await write(repo, ".env.example", "EXAMPLE=1");
    await write(repo, "node_modules/.env", "DEP=1");

    const output = await linkEnvFiles(repo, worktree);

    const expectLinked = async (rel: string, expectedContent: string) => {
      const target = Path.join(worktree, rel);
      const stat = await fs.lstat(target);
      expect(stat.isSymbolicLink()).toBe(true);
      expect(await fs.readlink(target)).toBe(Path.join(repo, rel));
      expect(await fs.readFile(target, "utf8")).toBe(expectedContent);
    };

    await expectLinked(".env", "ROOT=1");
    await expectLinked(".env.local", "ROOT_LOCAL=1");
    await expectLinked("apps/web/.env.production", "WEB=1");
    await expectLinked("apps/api/.dev.vars", "API=1");

    expect(fsSync.existsSync(Path.join(worktree, ".env.example"))).toBe(false);
    expect(fsSync.existsSync(Path.join(worktree, "node_modules"))).toBe(false);

    expect(output).toContain("linked .env ");
    expect(output).toContain("linked apps/web/.env.production ");
    expect(output).toContain("linked apps/api/.dev.vars ");
  });

  it("reflects edits to the source through the symlink (one source of truth)", async () => {
    await write(repo, ".env", "V=1");
    await linkEnvFiles(repo, worktree);
    await fs.writeFile(Path.join(repo, ".env"), "V=2");
    expect(await fs.readFile(Path.join(worktree, ".env"), "utf8")).toBe("V=2");
  });

  it("leaves an existing target untouched (non-clobber)", async () => {
    await write(repo, ".env", "FROM_REPO=1");
    await write(worktree, ".env", "ALREADY_HERE=1");

    await linkEnvFiles(repo, worktree);

    const stat = await fs.lstat(Path.join(worktree, ".env"));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(Path.join(worktree, ".env"), "utf8")).toBe(
      "ALREADY_HERE=1",
    );
  });

  it("does not descend into nested repos / submodules", async () => {
    await write(repo, "vendored/.git", "gitdir: ../.git/modules/vendored");
    await write(repo, "vendored/.env", "NESTED=1");

    await linkEnvFiles(repo, worktree);

    expect(fsSync.existsSync(Path.join(worktree, "vendored/.env"))).toBe(false);
  });

  it("links configured include globs instead of only env files", async () => {
    await write(repo, ".env.local", "ENV=1");
    await write(repo, "certs/dev.pem", "CERT=1");
    await write(repo, "apps/web/.env.preview", "WEB=1");

    const output = await linkIncludedFiles(
      repo,
      worktree,
      ".env.local\ncerts/*.pem\napps/web/.env.*\n",
    );

    expect(await fs.readlink(Path.join(worktree, ".env.local"))).toBe(
      Path.join(repo, ".env.local"),
    );
    expect(await fs.readlink(Path.join(worktree, "certs/dev.pem"))).toBe(
      Path.join(repo, "certs/dev.pem"),
    );
    expect(
      await fs.readlink(Path.join(worktree, "apps/web/.env.preview")),
    ).toBe(Path.join(repo, "apps/web/.env.preview"));
    expect(output).toContain("linked certs/dev.pem ");
  });

  it("leaves existing configured include targets untouched", async () => {
    await write(repo, "certs/dev.pem", "FROM_REPO=1");
    await write(worktree, "certs/dev.pem", "LOCAL=1");

    await linkIncludedFiles(repo, worktree, "certs/*.pem\n");

    const stat = await fs.lstat(Path.join(worktree, "certs/dev.pem"));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(
      await fs.readFile(Path.join(worktree, "certs/dev.pem"), "utf8"),
    ).toBe("LOCAL=1");
  });
});
