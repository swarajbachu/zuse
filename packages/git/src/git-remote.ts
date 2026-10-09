import { GitOriginInfo } from "@zuse/contracts";
import { Effect } from "effect";
import { type GitHubRepository, GitHubRequestScope } from "./github-client.ts";

const safeCloneUrl = (raw: string): string | null => {
	const trimmed = raw.trim();
	if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(trimmed)) return trimmed;
	try {
		const parsed = new URL(trimmed);
		if (
			!(
				parsed.protocol === "http:" ||
				parsed.protocol === "https:" ||
				parsed.protocol === "ssh:"
			)
		)
			return null;
		parsed.password = "";
		if (parsed.protocol !== "ssh:") parsed.username = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return null;
	}
};

export const parseRemoteUrl = (url: string): GitOriginInfo | null => {
	const cloneUrl = safeCloneUrl(url);
	const cleaned = (cloneUrl ?? url).replace(/\.git\/?$/, "");
	const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
	if (scp) {
		const [, host, owner, repo] = scp;
		if (host !== undefined && owner !== undefined && repo !== undefined) {
			return GitOriginInfo.make({
				host,
				owner,
				repo,
				cloneUrl: cloneUrl ?? undefined,
			});
		}
	}
	const proto =
		/^(?:https?|ssh):\/\/(?:[\w.-]+@)?([\w.-]+)\/([\w.-]+)\/([\w.-]+)$/.exec(
			cleaned,
		);
	if (proto) {
		const [, host, owner, repo] = proto;
		if (host !== undefined && owner !== undefined && repo !== undefined) {
			return GitOriginInfo.make({
				host,
				owner,
				repo,
				cloneUrl: cloneUrl ?? undefined,
			});
		}
	}
	return null;
};

/** Keep API discovery and PR checkout on the same repository selection rules. */
export const resolveGitHubRepository = <E>(
	cwd: string,
	git: (args: readonly string[]) => Effect.Effect<string, E>,
): Effect.Effect<GitHubRepository | null, E> =>
	Effect.gen(function* () {
		const credentialScope = (yield* GitHubRequestScope) ?? undefined;
		const configured = process.env.GH_REPO;
		if (configured) {
			const parts = configured.split("/");
			const [host, owner, repo] =
				parts.length === 2
					? [process.env.GH_HOST ?? "github.com", ...parts]
					: parts;
			if (host && owner && repo && (parts.length === 2 || parts.length === 3))
				return { host, owner, repo, cwd, credentialScope };
		}
		const remotes = (yield* git(["remote"])).trim().split("\n").filter(Boolean);
		const defaults = yield* git([
			"config",
			"--get-regexp",
			"^remote\\..*\\.gh-resolved$",
		]).pipe(Effect.catch(() => Effect.succeed("")));
		const marks = [
			...defaults.matchAll(/^remote\.(.+)\.gh-resolved\s+(\S+)$/gm),
		];
		if (marks.length > 1) return null;
		const pinned = marks[0]?.[1];
		const ordered = [
			...new Set(
				[pinned, "upstream", "github", "origin", ...remotes].filter(
					(name): name is string => !!name && remotes.includes(name),
				),
			),
		];
		for (const remote of ordered) {
			const url = yield* git(["remote", "get-url", remote]).pipe(
				Effect.catch(() => Effect.succeed("")),
			);
			const info = parseRemoteUrl(url.trim());
			if (info && (!process.env.GH_HOST || info.host === process.env.GH_HOST)) {
				const resolved = remote === pinned ? marks[0]?.[2] : undefined;
				if (resolved && resolved !== "base") {
					const parts = resolved.split("/");
					if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
					return {
						host: info.host,
						owner: parts[0],
						repo: parts[1],
						cwd,
						credentialScope,
					};
				}
				return { ...info, cwd, credentialScope };
			}
		}
		return null;
	});
