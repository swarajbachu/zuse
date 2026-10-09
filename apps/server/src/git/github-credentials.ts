import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	desktopGitHubCredential,
	type GitHubCredentialResolver,
	GitHubFailure,
} from "@zuse/git/github-client";

/** Same broker and immutable actor context as the cloud Git/gh auth helper. */
export const runtimeGitHubCredential: GitHubCredentialResolver = async (
	host,
	cwd,
	signal,
	scope,
) => {
	const directory = process.env.ZUSE_USER_DATA;
	const cloud = Boolean(
		scope ||
			process.env.ZUSE_CLOUD_WORKSPACE_ID ||
			process.env.ZUSE_GITHUB_CONTEXT_DIR,
	);
	if (!directory) {
		if (cloud)
			throw new GitHubFailure(
				"authentication",
				"Cloud GitHub credentials are not ready.",
			);
		return desktopGitHubCredential(host, cwd, signal);
	}
	if (!cloud) {
		try {
			await readFile(join(directory, "github-broker.json"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return desktopGitHubCredential(host, cwd, signal);
			throw new GitHubFailure(
				"authentication",
				"Cloud GitHub credentials are unavailable.",
			);
		}
	}
	if (host !== "github.com")
		throw new GitHubFailure(
			"access",
			"This cloud credential is scoped to GitHub.com.",
		);
	try {
		const [config, credential, context] = await Promise.all([
			readFile(join(directory, "github-broker.json"), "utf8"),
			readFile(join(directory, "cloud-runtime-credential"), "utf8"),
			scope
				? Promise.resolve(scope.body)
				: process.env.ZUSE_GITHUB_CONTEXT_DIR
					? readFile(
							join(process.env.ZUSE_GITHUB_CONTEXT_DIR, "request.json"),
							"utf8",
						)
					: Promise.resolve("{}"),
		]);
		const broker = JSON.parse(config) as { credentialUrl?: string };
		if (!broker.credentialUrl) throw new Error("Missing broker endpoint");
		const response = await fetch(broker.credentialUrl, {
			method: "POST",
			signal,
			headers: {
				authorization: `Bearer ${credential.trim()}`,
				"content-type": "application/json",
			},
			body: context,
		});
		if (!response.ok)
			throw new GitHubFailure(
				response.status >= 500 ? "offline" : "authentication",
				"Cloud GitHub access could not be renewed.",
			);
		const value = (await response.json()) as {
			token?: string;
			expiresAtMs?: number;
		};
		if (
			!value.token ||
			!Number.isFinite(value.expiresAtMs) ||
			(value.expiresAtMs ?? 0) <= Date.now()
		)
			throw new GitHubFailure(
				"authentication",
				"Cloud GitHub credential has expired.",
			);
		return { token: value.token, expiresAt: value.expiresAtMs };
	} catch (error) {
		if (error instanceof GitHubFailure) throw error;
		if (signal.aborted) throw signal.reason;
		throw new GitHubFailure(
			"offline",
			"Cloud GitHub credential broker is unavailable.",
		);
	}
};
