import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	GitHubClient,
	type GitHubRepository,
} from "../../src/github-client.ts";
import {
	type GitHubPr,
	GitHubPullRequests,
	prRevisions,
} from "../../src/github-pull-requests.ts";

const repo: GitHubRepository = {
	host: "github.com",
	owner: "acme",
	repo: "app",
	cwd: "/repo",
};
const signal = () => new AbortController().signal;

import { check, pr } from "../github-fixture.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const settle = async <T>(promise: Promise<T>, ms = 510): Promise<T> => {
	const result = promise.then(
		(value) => ({ value, error: undefined }),
		(error) => ({ value: undefined, error }),
	);
	await vi.advanceTimersByTimeAsync(ms);
	const settled = await result;
	if (settled.error) throw settled.error;
	return settled.value as T;
};

function fixture(options: { unsupported?: boolean; changed?: boolean } = {}) {
	let now = 0;
	let current = pr();
	let calls = 0;
	const fetcher = vi.fn(
		async (_url: string | URL | Request, input?: RequestInit) => {
			calls++;
			if (input?.method === "POST") {
				const query = JSON.parse(String(input.body)).query as string;
				const data: Record<string, unknown> = {};
				for (const [, alias] of query.matchAll(/(p\d+):/g))
					data[alias ?? ""] = query.includes("pullRequests(")
						? {
								pullRequests: {
									nodes: [current],
									pageInfo: { hasNextPage: false, endCursor: null },
								},
							}
						: { pullRequest: current };
				data.rateLimit = {
					cost: 1,
					limit: 5000,
					remaining: 5000 - calls,
					resetAt: "2030-01-01T00:00:00Z",
				};
				return new Response(JSON.stringify({ data }));
			}
			if (options.unsupported)
				return new Response(JSON.stringify({ message: "Not Found" }), {
					status: 404,
				});
			const headers = input?.headers as Record<string, string>;
			if (headers["if-none-match"] && !options.changed)
				return new Response(null, { status: 304, headers: { etag: "same" } });
			return new Response(
				JSON.stringify({ head: { sha: current.headRefOid } }),
				{ headers: { etag: "same" } },
			);
		},
	);
	const client = new GitHubClient({
		fetch: fetcher,
		now: () => now,
		resolveCredential: async () => ({ token: "test-token" }),
	});
	const reader = new GitHubPullRequests(client);
	return {
		client,
		reader,
		fetcher,
		setNow: (value: number) => {
			now = value;
		},
		setPr: (value: GitHubPr) => {
			current = value;
		},
		close: () => {
			reader.close();
			client.close();
		},
	};
}

test("batches branch discovery and PR summaries, and coalesces duplicate consumers", async () => {
	const f = fixture();
	expect(
		await settle(
			Promise.all([
				f.reader.discover(repo, "a", signal()),
				f.reader.discover(repo, "b", signal()),
			]),
		),
	).toEqual([1, 1]);
	expect(f.fetcher).toHaveBeenCalledTimes(1);
	const values = await settle(
		Promise.all([
			f.reader.read(repo, 1, signal()),
			f.reader.read(repo, 2, signal()),
			f.reader.read(repo, 1, signal()),
		]),
	);
	expect(values).toHaveLength(3);
	expect(f.fetcher).toHaveBeenCalledTimes(2);
	f.close();
});

test("unchanged background fingerprints skip expensive detail reads", async () => {
	const f = fixture();
	await settle(f.reader.read(repo, 1, signal(), { interactive: false }));
	f.setNow(120_001);
	const next = await settle(
		f.reader.read(repo, 1, signal(), { interactive: false }),
	);
	expect(next.statusCheckRollup).toEqual([check]);
	expect(f.client.metrics.graphql).toBe(2);
	expect(f.client.metrics.rest).toBe(0);
	const query = JSON.parse(String(f.fetcher.mock.calls[1]?.[1]?.body)).query;
	expect(query).not.toContain("detailsUrl");
	f.close();
});

test("pending CI and unknown mergeability reread details even when fingerprints are unchanged", async () => {
	const f = fixture({ unsupported: true });
	f.setPr(
		pr({
			mergeable: "UNKNOWN",
			statusCheckRollup: [
				{ ...check, status: "IN_PROGRESS", conclusion: undefined },
			],
		}),
	);
	await settle(f.reader.read(repo, 1, signal(), { interactive: false }));
	f.setNow(120_001);
	await settle(f.reader.read(repo, 1, signal(), { interactive: false }));
	expect(f.client.metrics.graphql).toBe(3);
	f.close();
});

test("REST validators reuse checks and unsupported endpoints stop being probed", async () => {
	const f = fixture();
	await settle(f.reader.read(repo, 1, signal()));
	f.setNow(60_000);
	await settle(f.reader.read(repo, 1, signal())); // seed validators and reread
	f.setNow(119_000);
	await settle(f.reader.read(repo, 1, signal()));
	expect(f.client.metrics.graphql).toBe(2);
	expect(f.client.metrics.notModified).toBe(3);
	f.close();
	const unsupported = fixture({ unsupported: true });
	await settle(unsupported.reader.read(repo, 1, signal()));
	await settle(unsupported.reader.read(repo, 1, signal()));
	await settle(unsupported.reader.read(repo, 1, signal()));
	expect(unsupported.client.metrics.rest).toBe(1);
	unsupported.close();
});

test("head movement clears validators and triggers an authoritative reread", async () => {
	const f = fixture({ changed: true });
	await settle(f.reader.read(repo, 1, signal()));
	await settle(f.reader.read(repo, 1, signal()));
	f.setPr(
		pr({
			headRefOid: "sha2",
			commits: {
				nodes: [
					{
						commit: {
							...pr().commits.nodes[0]?.commit,
							oid: "sha2",
							statusCheckRollup:
								pr().commits.nodes[0]?.commit.statusCheckRollup ?? null,
						},
					},
				],
			},
		}),
	);
	const next = await settle(f.reader.read(repo, 1, signal()));
	expect(next.headRefOid).toBe("sha2");
	const before = f.fetcher.mock.calls.length;
	await settle(f.reader.read(repo, 1, signal()));
	const firstRest = f.fetcher.mock.calls[before]?.[1]?.headers as Record<
		string,
		string
	>;
	expect(firstRest).not.toHaveProperty("if-none-match");
	f.close();
});

test("fingerprints notice edited comments without needing changed comment counts", () => {
	const original = pr();
	const edited = pr({
		comments: {
			...original.comments,
			nodes: [{ lastEditedAt: "2026-10-07T12:00:00Z" }],
		},
	});
	expect(prRevisions(original).statusRevision).toBe(
		prRevisions(edited).statusRevision,
	);
	expect(prRevisions(original).remarksRevision).not.toBe(
		prRevisions(edited).remarksRevision,
	);
});

test("incomplete checks pagination cannot imply success", async () => {
	const f = fixture();
	const broken = pr();
	const contexts = broken.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
	if (contexts) contexts.pageInfo = { hasNextPage: true, endCursor: null };
	f.setPr(broken);
	await expect(settle(f.reader.read(repo, 1, signal()))).rejects.toThrow(
		"pagination is incomplete",
	);
	f.close();
});

test("one-hour stable background trace cuts GraphQL usage by more than 75%", async () => {
	const f = fixture();
	for (let minute = 0; minute < 60; minute += 2) {
		f.setNow(minute * 60_000);
		await settle(f.reader.discover(repo, "feature", signal(), false));
		await settle(f.reader.read(repo, 1, signal(), { interactive: false }));
	}
	const oldGraphqlRequests = Math.ceil(3_600_000 / 7_000);
	expect(f.client.metrics.graphql).toBe(60);
	expect(1 - f.client.metrics.graphql / oldGraphqlRequests).toBeGreaterThan(
		0.75,
	);
	expect(f.client.metrics.rest).toBe(0);
	f.close();
});

for (const changedHead of [false, true])
	test(`paginates beyond 100 checks and fences a ${changedHead ? "changed" : "stable"} head`, async () => {
		const current = pr();
		const contexts =
			current.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
		if (!contexts) throw new Error("missing fixture contexts");
		contexts.nodes = Array.from({ length: 100 }, (_, index) => ({
			...check,
			name: `check-${index}`,
		}));
		contexts.checkRunCountsByState = [{ state: "COMPLETED", count: 101 }];
		contexts.pageInfo = { hasNextPage: true, endCursor: "page-2" };
		const client = new GitHubClient({
			resolveCredential: async () => ({ token: "pagination" }),
			fetch: async (_url, input) => {
				const query = JSON.parse(String(input?.body)).query;
				const data = query.includes("object(oid:")
					? {
							repository: {
								pullRequest: { headRefOid: changedHead ? "sha2" : "sha1" },
								object: {
									statusCheckRollup: {
										contexts: {
											nodes: [{ ...check, name: "check-100" }],
											pageInfo: { hasNextPage: false, endCursor: null },
										},
									},
								},
							},
						}
					: { p0: { pullRequest: current } };
				return new Response(JSON.stringify({ data }));
			},
		});
		const reader = new GitHubPullRequests(client);
		try {
			const request = settle(reader.read(repo, 1, signal()));
			if (changedHead) await expect(request).rejects.toThrow("head changed");
			else {
				const result = await request;
				expect(result.statusCheckRollup).toHaveLength(101);
				expect(result.checksComplete).toBe(true);
			}
		} finally {
			reader.close();
			client.close();
		}
	});

test("one-hour CI-active and multi-worktree traces remain bounded", async () => {
	const ci = fixture();
	ci.setPr(
		pr({
			statusCheckRollup: [
				{ ...check, status: "IN_PROGRESS", conclusion: undefined },
			],
			commits: {
				nodes: [
					{
						commit: {
							oid: "sha1",
							statusCheckRollup: {
								contexts: {
									nodes: [
										{ ...check, status: "IN_PROGRESS", conclusion: undefined },
									],
									checkRunCountsByState: [{ state: "IN_PROGRESS", count: 1 }],
									statusContextCountsByState: [],
									pageInfo: { hasNextPage: false, endCursor: null },
								},
							},
						},
					},
				],
			},
		}),
	);
	for (let second = 0; second < 3600; second += 45) {
		ci.setNow(second * 1000);
		await settle(ci.reader.discover(repo, "feature", signal()));
		await settle(ci.reader.read(repo, 1, signal()));
	}
	expect(ci.client.metrics.graphql).toBe(107);
	expect(ci.client.metrics.rest).toBe(0);
	expect(1 - ci.client.metrics.graphql / 720).toBeGreaterThan(0.75);
	ci.close();
	const multi = fixture();
	for (let minute = 0; minute < 60; minute += 2) {
		multi.setNow(minute * 60_000);
		await settle(
			Promise.all(
				Array.from({ length: 10 }, (_, index) =>
					multi.reader.discover(repo, `feature-${index}`, signal(), false),
				),
			),
		);
		await settle(
			Promise.all(
				Array.from({ length: 10 }, (_, index) =>
					multi.reader.read(repo, index + 1, signal(), { interactive: false }),
				),
			),
		);
	}
	expect(multi.client.metrics.graphql).toBe(60);
	expect(multi.client.metrics.rest).toBe(0);
	multi.close();
});

test("discovery falls back to REST only for compatible read failures", async () => {
	const client = new GitHubClient({
		resolveCredential: async () => ({ token: "fallback" }),
		fetch: async (_url, input) =>
			input?.method === "POST"
				? new Response(
						JSON.stringify({
							errors: [{ message: "Field headRefOid doesn't exist" }],
						}),
					)
				: new Response(
						JSON.stringify([
							{
								number: 3,
								state: "open",
								merged_at: null,
								head: { ref: "feature", user: { login: "acme" } },
							},
						]),
					),
	});
	const reader = new GitHubPullRequests(client);
	try {
		expect(await settle(reader.discover(repo, "feature", signal()))).toBe(3);
		expect(client.metrics).toMatchObject({ rest: 1, graphql: 1 });
	} finally {
		reader.close();
		client.close();
	}
});

test("discovery respects interactive/background batch limits and coalesces duplicates", async () => {
	for (const [interactive, size] of [
		[true, 50],
		[false, 25],
	] as const) {
		const f = fixture();
		try {
			const branches = Array.from(
				{ length: size + 1 },
				(_, index) => `batch-${index}`,
			);
			await settle(
				Promise.all(
					[...branches, branches[0]].map((branch) =>
						f.reader.discover(repo, branch ?? "", signal(), interactive),
					),
				),
			);
			expect(f.fetcher).toHaveBeenCalledTimes(2);
			const queries = f.fetcher.mock.calls.map(
				(call) => JSON.parse(String(call[1]?.body)).query,
			);
			expect(
				queries.map((query) => [...query.matchAll(/p\d+:/g)].length),
			).toEqual([size, 1]);
		} finally {
			f.close();
		}
	}
});

test("cancelling all queued consumers dispatches no API requests", async () => {
	const f = fixture();
	const controller = new AbortController();
	try {
		const pending = f.reader
			.discover(repo, "feature", controller.signal)
			.catch((error) => error);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		await settle(pending);
		expect(f.fetcher).not.toHaveBeenCalled();
	} finally {
		f.close();
	}
});

test("waiting checks use the shared pending classification and keep detail reads active", async () => {
	const f = fixture({ unsupported: true });
	const waiting = { ...check, status: "WAITING", conclusion: undefined };
	const current = pr();
	const contexts = current.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
	if (!contexts) throw new Error("missing contexts");
	contexts.nodes = [waiting];
	contexts.checkRunCountsByState = [{ state: "WAITING", count: 1 }];
	f.setPr({ ...current, statusCheckRollup: [waiting] });
	try {
		await settle(f.reader.read(repo, 1, signal(), { interactive: false }));
		f.setNow(120_001);
		await settle(f.reader.read(repo, 1, signal(), { interactive: false }));
		expect(f.client.metrics.graphql).toBe(3);
	} finally {
		f.close();
	}
});
