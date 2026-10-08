import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { FolderId } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { GitService } from "../../src/git-service.ts";
import { GitServiceLive } from "../../src/git-service-live.ts";
import { GitHubClient, GitHubClientService } from "../../src/github-client.ts";
import { RepositoryLocator } from "../../src/repository-locator.ts";
import { pr } from "../github-fixture.ts";

const folder = FolderId.make("github-api-test");

test("direct API status preserves same-account state, revokes changed branch/account, and binds mutations to the local head", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "zuse-github-api-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	let offline = false;
	let token = "account-a";
	let head = "";
	const mutations: Record<string, unknown>[] = [];
	const client = new GitHubClient({
		resolveCredential: async () => ({ token }),
		fetch: async (_url, init) => {
			if (offline) throw new TypeError("offline");
			const { query, variables } = JSON.parse(String(init?.body));
			if (query.startsWith("mutation")) {
				mutations.push(variables.input);
				return new Response(
					JSON.stringify({
						data: { mergePullRequest: { pullRequest: { id: "PR_1" } } },
					}),
				);
			}
			const current = pr({
				headRefOid: head,
				commits: {
					nodes: [
						{
							commit: {
								...pr().commits.nodes[0]?.commit,
								oid: head,
								statusCheckRollup:
									pr().commits.nodes[0]?.commit.statusCheckRollup ?? null,
							},
						},
					],
				},
			});
			const data: Record<string, unknown> = {};
			for (const [, alias] of query.matchAll(/(p\d+):/g))
				data[alias] = query.includes("pullRequests(")
					? {
							pullRequests: {
								nodes: [current],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						}
					: { pullRequest: current };
			return new Response(JSON.stringify({ data }));
		},
	});
	try {
		git("init", "--initial-branch=main");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.com");
		writeFileSync(join(cwd, "README.md"), "test\n");
		git("add", ".");
		git("commit", "-m", "initial");
		git("switch", "-c", "feature");
		git("remote", "add", "origin", "https://github.com/acme/app.git");
		head = git("rev-parse", "HEAD");
		const layer = GitServiceLive.pipe(
			Layer.provide(
				Layer.succeed(RepositoryLocator, {
					root: () => Effect.succeed(cwd),
					worktreePath: () => Effect.succeed(null),
					resolve: () => Effect.succeed(cwd),
				}),
			),
			Layer.provide(Layer.succeed(GitHubClientService, client)),
			Layer.provide(NodeServices.layer),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* GitService;
				const initial = yield* service.prState(folder, null, { force: true });
				expect(initial).toMatchObject({
					state: "open",
					branch: "feature",
					stale: false,
					checksComplete: true,
					headSha: head,
				});
				yield* service.mergePr(folder, "merge", "squash", false, null);
				expect(mutations).toEqual([
					{
						pullRequestId: "PR_1",
						mergeMethod: "SQUASH",
						expectedHeadOid: head,
					},
				]);
				head = "different-head";
				const rejected = yield* Effect.result(
					service.mergePr(folder, "merge", "merge", false, null),
				);
				expect(rejected._tag).toBe("Failure");
				expect(mutations).toHaveLength(1);
				offline = true;
				const stale = yield* service.prState(folder, null, { force: true });
				expect(stale).toMatchObject({
					state: "open",
					stale: true,
					prCapability: "offline",
				});
				git("switch", "-c", "other");
				const changed = yield* service.prState(folder, null, { force: true });
				expect(changed).toMatchObject({
					state: "none",
					branch: "other",
					stale: true,
				});
				git("switch", "feature");
				client.invalidate();
				token = "account-b";
				const account = yield* service.prState(folder, null, { force: true });
				expect(account).toMatchObject({ state: "none", stale: true });
			}).pipe(Effect.provide(layer)),
		);
	} finally {
		client.close();
		rmSync(cwd, { recursive: true, force: true });
	}
}, 20_000);
