import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { configureCloudGitIdentity } from "../../src/api/cloud-git-identity.ts";

test("fresh and resumed workspaces commit as the connected user, preserving repository overrides", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cloud-git-"));
	const repository = join(directory, "repo");
	await mkdir(repository);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: directory,
		GIT_CONFIG_GLOBAL: join(directory, ".gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	for (const key of [
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	])
		delete env[key];
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repository,
			env,
			encoding: "utf8",
		}).trim();
	try {
		git("init", "-q");
		git("config", "--global", "user.name", "Prior identity");
		git("config", "--global", "user.email", "prior@example.com");
		const identity = {
			name: 'Octo "Cat" \\ User',
			email: "123+octocat@users.noreply.github.com",
		};
		await configureCloudGitIdentity(directory, identity, env);
		await configureCloudGitIdentity(directory, identity, env);
		expect(
			git("config", "--global", "--get-all", "include.path").split("\n"),
		).toHaveLength(1);
		git("commit", "--allow-empty", "-qm", "Personal commit");
		expect(git("log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(
			`${identity.name}|${identity.email}|${identity.name}|${identity.email}`,
		);
		git("config", "user.name", "Repository author");
		expect(git("config", "user.name")).toBe("Repository author");
		git("config", "--unset", "user.name");
		await configureCloudGitIdentity(directory, undefined, env);
		expect(git("config", "user.name")).toBe("Prior identity");
		expect(git("config", "user.email")).toBe("prior@example.com");
		await expect(
			configureCloudGitIdentity(
				directory,
				{ name: "bad\n[credential]", email: "bad" },
				env,
			),
		).rejects.toThrow("invalid_cloud_git_identity");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
