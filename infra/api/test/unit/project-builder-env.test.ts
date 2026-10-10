import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

const builder = readFileSync(
	new URL("../../../cloud-sandboxes/project-builder.sh", import.meta.url),
	"utf8",
);

// Run the production cleanup and finalization against a real Git checkout.
// Redirect every absolute build path into the disposable fixture.
test.each([
	false,
	true,
])("snapshot preserves tracked environment configuration (unexpected injected secret: %s)", (unexpectedSecret) => {
	const root = mkdtempSync(join(tmpdir(), "zuse-snapshot-env-"));
	try {
		const home = join(root, "home/zuse");
		const repository = join(root, "home/repos/legion-team/legion");
		const status = join(root, "var/lib/zuse/project-build");
		const secrets = join(root, "run/zuse-secrets");
		for (const path of [home, repository, status, secrets]) {
			mkdirSync(path, { recursive: true });
		}
		const write = (path: string, content: string) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		};
		const git = (...args: string[]) => {
			const result = spawnSync("git", ["-C", repository, ...args], {
				encoding: "utf8",
			});
			expect(result.status, result.stderr).toBe(0);
			return result.stdout.trim();
		};
		git("init", "--quiet", "--initial-branch=master");
		const files = [
			"env/.env",
			"env/.env.e2e",
			"env/.env.prod-migration",
			"env/.env.test",
			"env/.env.test-migration",
			".env.analytics.example",
			"apps/web/.env.local",
		];
		for (const filename of files) {
			write(join(repository, filename), "APP_MODE=test\n");
		}
		git("add", ".");
		git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		);
		const commit = git("rev-parse", "HEAD");
		git("update-ref", "refs/remotes/origin/master", commit);
		git("config", "http.https://github.com/.extraheader", "fixture-header");
		write(
			join(status, "repositories.jsonl"),
			`${JSON.stringify({
				projectId: "project_fixture",
				repositoryUrl: "https://github.com/legion-team/legion.git",
				defaultBranch: "master",
				visibility: "private",
				workspacePath: repository,
			})}\n`,
		);
		const injectedFiles = [
			join(secrets, "github-installation-fixture"),
			join(home, ".codex/auth.json"),
			join(home, ".grok/auth.json"),
			join(home, ".zuse-image/provider-secrets.json"),
			join(home, ".zuse/cloud-auth/private.pem"),
			join(home, ".zuse-data/cloud-runtime-identity.json"),
			join(home, ".git-credentials"),
			join(home, ".env"),
		];
		for (const path of injectedFiles)
			write(path, "INJECTED_FIXTURE_DO_NOT_LOG");
		if (unexpectedSecret)
			write(join(secrets, "unexpected-secret"), "INJECTED_FIXTURE_DO_NOT_LOG");
		const isolatedBuilder = builder
			.replaceAll("/tmp/zuse-", join(root, "tmp/zuse-"))
			.replaceAll("/home/zuse", home)
			.replaceAll("/home/repos", join(root, "home/repos"))
			.replaceAll("/var/lib/zuse", join(root, "var/lib/zuse"))
			.replaceAll("/run/zuse-secrets", secrets);
		const script = join(root, "builder.sh");
		writeFileSync(script, isolatedBuilder);
		const cleanup = isolatedBuilder.slice(
			isolatedBuilder.indexOf("\tphase=cleaning-credentials"),
			isolatedBuilder.lastIndexOf("\n}"),
		);
		const result = spawnSync(
			"bash",
			["-c", `source "$1"\n${cleanup}`, "test", script],
			{
				encoding: "utf8",
				env: {
					...process.env,
					ZUSE_TEMPLATE_VERSION: "8",
					ZUSE_CONFIGURATION_DIGEST: "fixture-digest",
					ZUSE_PROVIDER_AUTH_DELIVERY_VERSION: "1",
				},
			},
		);
		expect(result.status, result.stderr).toBe(unexpectedSecret ? 73 : 0);
		expect(result.stdout + result.stderr).not.toContain(
			"INJECTED_FIXTURE_DO_NOT_LOG",
		);
		for (const filename of files) {
			expect(readFileSync(join(repository, filename), "utf8")).toBe(
				"APP_MODE=test\n",
			);
		}
		expect(git("status", "--porcelain")).toBe("");
		expect(git("rev-parse", "HEAD")).toBe(commit);
		expect(existsSync(join(status, "ready"))).toBe(!unexpectedSecret);
		if (unexpectedSecret) {
			expect(readFileSync(join(status, "failure-phase"), "utf8")).toBe(
				"sanitizing-snapshot\n",
			);
		} else {
			for (const path of injectedFiles) expect(existsSync(path)).toBe(false);
			expect(
				readFileSync(join(repository, ".git/config"), "utf8"),
			).not.toContain("fixture-header");
			expect(
				readFileSync(join(status, "repository-commits.tsv"), "utf8"),
			).toContain(commit);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
