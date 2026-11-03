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
import {
	GitHubClient,
	GitHubClientService,
	GitHubRequestScope,
} from "../../src/github-client.ts";
import { RepositoryLocator } from "../../src/repository-locator.ts";
import { pr } from "../github-fixture.ts";

const folder = FolderId.make("github-api-test");

test.each([
	false,
	true,
])("direct API status preserves identity and head checks with failed branch cleanup: %s", async (deleteBranch) => {
	const cwd = mkdtempSync(join(tmpdir(), "zuse-github-api-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	let offline = false;
	let unavailable = false;
	let token = "account-a";
	let head = "";
	const mutations: Record<string, unknown>[] = [];
	const discoveryQueries: string[] = [];
	const client = new GitHubClient({
		resolveCredential: async () => ({ token }),
		fetch: async (_url, init) => {
			if (offline) throw new TypeError("offline");
			if (unavailable)
				return Response.json(
					{ message: "Service Unavailable" },
					{ status: 503 },
				);
			if (init?.method === "DELETE")
				return Response.json({ message: "Branch protected" }, { status: 403 });
			const { query, variables } = JSON.parse(String(init?.body));
			if (query.includes("pullRequests(")) discoveryQueries.push(query);
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
				const nativeScope = {
					key: "actor-with-unavailable-native-helper",
					body: "{}",
					resolveEnv: async () => {
						throw new Error("Native Git helper unavailable");
					},
				};
				const context = yield* service
					.githubContext(folder, null)
					.pipe(Effect.provideService(GitHubRequestScope, nativeScope));
				expect(context).toEqual({
					host: "github.com",
					owner: "acme",
					repo: "app",
					branch: "feature",
					headOwner: "acme",
					headSha: head,
				});
				expect(client.metrics.graphql).toBe(0);
				git("config", "branch.feature.remote", "origin");
				git("config", "branch.feature.merge", "refs/heads/fix/remote-feature");
				expect(yield* service.githubContext(folder, null)).toMatchObject({
					branch: "fix/remote-feature",
					headOwner: "acme",
				});
				expect(
					yield* service.prState(folder, null, { force: true }),
				).toMatchObject({
					state: "open",
					stale: false,
				});
				expect(discoveryQueries.at(-1)).toContain(
					'headRefName:"fix/remote-feature"',
				);
				git("config", "--unset", "branch.feature.remote");
				git("config", "--unset", "branch.feature.merge");
				git("remote", "set-url", "origin", "https://github.com/alice/app.git");
				git("remote", "add", "upstream", "https://github.com/acme/app.git");
				expect(yield* service.githubContext(folder, null)).toMatchObject({
					owner: "acme",
					repo: "app",
					headOwner: "alice",
					branch: "feature",
				});
				git("remote", "remove", "upstream");
				git("remote", "set-url", "origin", "https://github.com/acme/app.git");
				const initial = yield* service
					.prState(folder, null, { force: true })
					.pipe(Effect.provideService(GitHubRequestScope, nativeScope));
				expect(initial).toMatchObject({
					state: "open",
					branch: "feature",
					stale: false,
					checksComplete: true,
					headSha: head,
				});
				// Network Git must still fail closed when the actor helper is unavailable.
				const push = yield* Effect.result(
					service
						.push(folder, null)
						.pipe(Effect.provideService(GitHubRequestScope, nativeScope)),
				);
				expect(push._tag).toBe("Failure");
				// Establish a separate desktop snapshot for the remaining recovery checks.
				yield* service.prState(folder, null, { force: true });
				writeFileSync(join(cwd, "untracked.txt"), "keep local changes");
				const merged = yield* service.mergePr(
					folder,
					"merge",
					"squash",
					deleteBranch,
					null,
				);
				expect(merged.output).toBe(
					deleteBranch
						? "Pull request merged; the remote branch could not be deleted."
						: "Pull request merged.",
				);
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
					observationError: "Could not reach GitHub.",
				});
				offline = false;
				unavailable = true;
				const unavailableStatus = yield* service.prState(folder, null, {
					force: true,
				});
				expect(unavailableStatus).toMatchObject({
					state: "open",
					stale: true,
					prCapability: "unknown",
					observationError: "Service Unavailable",
				});
				unavailable = false;
				const recovered = yield* service.prState(folder, null, { force: true });
				expect(recovered.stale).toBe(false);
				expect(recovered.observationError).toBeUndefined();
				offline = true;
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
