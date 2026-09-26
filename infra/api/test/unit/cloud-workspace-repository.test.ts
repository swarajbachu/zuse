import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const script = new URL(
	"../../../cloud-sandboxes/workspace-repository.sh",
	import.meta.url,
);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-cloud-branch-"));
	roots.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(root, "file"), "original");
	git("add", ".");
	git("commit", "-m", "initial");
	git("remote", "add", "origin", "https://example.com/repo.git");
	const run = (base = "main", repositoryUrl = "https://example.com/repo.git") =>
		execFileSync("bash", [script.pathname], {
			env: {
				...process.env,
				ZUSE_CLOUD_WORKSPACE_ROOT: root,
				ZUSE_BRANCH: "vileplume",
				ZUSE_BASE_REF: base,
				ZUSE_REPOSITORY_URL: repositoryUrl,
			},
			stdio: "pipe",
		});
	return { root, git, run };
};
describe("cloud workspace branch initialization", () => {
	test("creates the requested branch and preserves edits across recovery retries", () => {
		const { root, git, run } = fixture();
		writeFileSync(join(root, "file"), "user edits");
		writeFileSync(join(root, "untracked"), "keep");
		run();
		run();
		expect(git("branch", "--show-current")).toBe("vileplume");
		expect(readFileSync(join(root, "file"), "utf8")).toBe("user edits");
		expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
	});
	test("does not reset existing branch commits", () => {
		const { root, git, run } = fixture();
		run();
		writeFileSync(join(root, "file"), "committed work");
		git("commit", "-am", "work");
		const head = git("rev-parse", "HEAD");
		run();
		expect(git("rev-parse", "HEAD")).toBe(head);
	});
	test("fails when the base is missing instead of starting on main", () => {
		const { git, run } = fixture();
		expect(() => run("missing")).toThrow();
		expect(git("branch", "--show-current")).toBe("main");
	});
	test("fetches a fork PR head and preserves the checkout on retry", () => {
		const { root, git, run } = fixture();
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
		writeFileSync(join(root, "file"), "fork PR commit\n");
		git("commit", "-am", "fork PR");
		const prHead = git("rev-parse", "HEAD");
		git("push", remote, "HEAD:refs/pull/656/head");
		git("reset", "--hard", "HEAD~1");

		run("refs/pull/656/head", remote);
		expect(git("rev-parse", "HEAD")).toBe(prHead);
		expect(() => git("config", "--get", "branch.vileplume.remote")).toThrow();
		expect(readFileSync(join(root, "file"), "utf8")).toBe("fork PR commit\n");
		writeFileSync(join(root, "file"), "local work\n");
		run("refs/pull/656/head", remote);
		expect(git("rev-parse", "HEAD")).toBe(prHead);
		expect(readFileSync(join(root, "file"), "utf8")).toBe("local work\n");
	});
	test("fails when a fork PR head no longer exists", () => {
		const { root, git, run } = fixture();
		const remote = join(root, "remote.git");
		execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
		expect(() => run("refs/pull/656/head", remote)).toThrow();
		expect(git("branch", "--show-current")).toBe("main");
	});
	test("recovers the target branch with conflicting edits intact", () => {
		const { root, git, run } = fixture();
		run();
		writeFileSync(join(root, "file"), "target branch work\n");
		git("commit", "-am", "target work");
		const target = git("rev-parse", "HEAD");
		git("switch", "main");
		writeFileSync(join(root, "file"), "local edits\n");
		writeFileSync(join(root, "untracked"), "keep");
		git("remote", "set-url", "origin", "https://example.com/old.git");
		run();
		run();
		expect(git("branch", "--show-current")).toBe("vileplume");
		expect(git("rev-parse", "HEAD")).toBe(target);
		const content = readFileSync(join(root, "file"), "utf8");
		expect(content).toContain("<<<<<<<");
		expect(content).toContain("target branch work");
		expect(content).toContain("local edits");
		expect(git("ls-files", "--unmerged")).not.toBe("");
		expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
		expect(git("remote", "get-url", "origin")).toBe(
			"https://example.com/repo.git",
		);
	});
	test("does not discard staged edits when switching would conflict", () => {
		const { root, git, run } = fixture();
		run();
		writeFileSync(join(root, "file"), "target work\n");
		git("commit", "-am", "target work");
		git("switch", "main");
		writeFileSync(join(root, "file"), "staged work\n");
		git("add", "file");
		const index = git("diff", "--cached");
		expect(() => run()).toThrow();
		expect(git("branch", "--show-current")).toBe("main");
		expect(git("diff", "--cached")).toBe(index);
		expect(readFileSync(join(root, "file"), "utf8")).toBe("staged work\n");
	});
});
