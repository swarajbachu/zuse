import { afterEach, describe, expect, test, vi } from "vitest";
import {
	credentialFingerprint,
	GitHubClient,
	type GitHubCredential,
	type GitHubRepository,
	githubApiRoot,
} from "../../src/github-client.ts";
import { GitHubSharedReads } from "../../src/github-shared-read.ts";

const repo: GitHubRepository = {
	host: "github.com",
	owner: "acme",
	repo: "app",
	cwd: "/repo",
};
const signal = () => new AbortController().signal;
const credential: GitHubCredential = {
	host: repo.host,
	token: "test-token",
	fingerprint: credentialFingerprint(repo.host, "test-token"),
	expiresAt: Infinity,
};
const json = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => vi.restoreAllMocks());

describe("GitHub direct transport", () => {
	test("coalesces credential discovery and respects expiry", async () => {
		let now = 0;
		const resolveCredential = vi.fn(async () => ({
			token: "test",
			expiresAt: now + 20_000,
		}));
		const client = new GitHubClient({ now: () => now, resolveCredential });
		const values = await Promise.all([
			client.credential(repo, signal()),
			client.credential(repo, signal()),
		]);
		expect(values[0]).toEqual(values[1]);
		expect(resolveCredential).toHaveBeenCalledTimes(1);
		now = 16_000;
		await client.credential(repo, signal());
		expect(resolveCredential).toHaveBeenCalledTimes(2);
		client.close();
	});
	test("failed discovery is retried and a 401 invalidates cached credentials", async () => {
		const resolveCredential = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue({ token: "test" });
		const client = new GitHubClient({
			resolveCredential,
			fetch: vi.fn(async () => json({}, 401)),
		});
		await expect(client.credential(repo, signal())).rejects.toMatchObject({
			kind: "offline",
		});
		const token = await client.credential(repo, signal());
		await expect(client.rest(token, "user", signal())).rejects.toMatchObject({
			kind: "authentication",
		});
		await client.credential(repo, signal());
		expect(resolveCredential).toHaveBeenCalledTimes(3);
		client.close();
	});
	test("caps concurrency at eight and aborts queued work on shutdown", async () => {
		let active = 0;
		let peak = 0;
		const fetcher = vi.fn(async (_url, init) => {
			active++;
			peak = Math.max(active, peak);
			try {
				await new Promise<void>((_resolve, reject) =>
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					),
				);
			} finally {
				active--;
			}
			return json({});
		}) as typeof fetch;
		const client = new GitHubClient({ fetch: fetcher });
		const requests = Array.from({ length: 12 }, () =>
			client.rest(credential, "user", signal()),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(peak).toBe(8);
		client.close();
		await Promise.allSettled(requests);
		expect(active).toBe(0);
		expect(fetcher).toHaveBeenCalledTimes(8);
	});
	test("preserves the GraphQL reserve for user actions and never replenishes from older observations", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json({
					data: {
						rateLimit: {
							cost: 1,
							limit: 100,
							remaining: 10,
							resetAt: "2030-01-01T00:00:00Z",
						},
					},
				}),
			)
			.mockResolvedValue(
				json({
					data: {
						rateLimit: {
							cost: 1,
							limit: 100,
							remaining: 80,
							resetAt: "2030-01-01T00:00:00Z",
						},
					},
				}),
			);
		const client = new GitHubClient({ fetch: fetcher });
		await client.graphql(
			credential,
			"query { viewer { login } }",
			{},
			signal(),
		);
		await expect(
			client.graphql(
				credential,
				"query { viewer { login } }",
				{},
				signal(),
				false,
			),
		).rejects.toMatchObject({ kind: "rate_limited" });
		await client.graphql(
			credential,
			"query { viewer { login } }",
			{},
			signal(),
			true,
		);
		await expect(
			client.graphql(
				credential,
				"query { viewer { login } }",
				{},
				signal(),
				false,
			),
		).rejects.toMatchObject({ kind: "rate_limited" });
		expect(fetcher).toHaveBeenCalledTimes(2);
		client.close();
	});
	test("recognizes HTTP-200 GraphQL rate errors and pauses both APIs for secondary limits", async () => {
		const fetcher = vi.fn(async () =>
			json(
				{ errors: [{ message: "You have exceeded a secondary rate limit" }] },
				200,
				{ "retry-after": "120" },
			),
		);
		const client = new GitHubClient({ fetch: fetcher, now: () => 1000 });
		await expect(
			client.graphql(credential, "query { viewer { login } }", {}, signal()),
		).rejects.toMatchObject({ kind: "rate_limited", retryAt: 121_000 });
		await expect(
			client.rest(credential, "user", signal()),
		).rejects.toMatchObject({ kind: "rate_limited" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		const another = { ...credential, fingerprint: "other-account" };
		await expect(client.rest(another, "user", signal())).rejects.toMatchObject({
			kind: "rate_limited",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		client.close();
	});
	test("obeys primary reset headers while keeping REST and GraphQL quotas separate", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json({ message: "API rate limit exceeded" }, 403, {
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": "100",
				}),
			)
			.mockResolvedValue(json({ data: {} }));
		const client = new GitHubClient({ fetch: fetcher, now: () => 1000 });
		await expect(
			client.rest(credential, "user", signal()),
		).rejects.toMatchObject({ kind: "rate_limited", retryAt: 100_000 });
		await client.graphql(
			credential,
			"query { viewer { login } }",
			{},
			signal(),
		);
		await expect(
			client.rest(credential, "user", signal()),
		).rejects.toMatchObject({ kind: "rate_limited" });
		expect(fetcher).toHaveBeenCalledTimes(2);
		client.close();
	});
	test("reuses ETags without losing pagination and isolates accounts", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json([1], 200, {
					etag: "v1",
					link: '<https://api.github.com/anything?page=2>; rel="next"',
				}),
			)
			.mockResolvedValueOnce(json([2], 200, { etag: "v2" }))
			.mockResolvedValueOnce(new Response(null, { status: 304 }))
			.mockResolvedValueOnce(new Response(null, { status: 304 }))
			.mockResolvedValue(json([3]));
		const client = new GitHubClient({ fetch: fetcher });
		expect(
			await client.pages(credential, "repos/acme/app/issues", signal()),
		).toEqual([1, 2]);
		expect(
			await client.pages(credential, "repos/acme/app/issues", signal()),
		).toEqual([1, 2]);
		expect(
			await client.pages(
				{ ...credential, fingerprint: "other" },
				"repos/acme/app/issues",
				signal(),
			),
		).toEqual([3]);
		expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
			"if-none-match": "v1",
		});
		expect(fetcher.mock.calls[4]?.[1]?.headers).not.toHaveProperty(
			"if-none-match",
		);
		expect(client.metrics.notModified).toBe(2);
		client.close();
	});
	test("mutations never retry or inject a query-only rateLimit field", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new Error("connection lost after write");
		});
		const client = new GitHubClient({ fetch: fetcher });
		await expect(
			client.graphql(
				credential,
				'mutation { closePullRequest(input:{pullRequestId:"id"}) { pullRequest { id } } }',
				{},
				signal(),
			),
		).rejects.toMatchObject({ kind: "offline" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain("rateLimit");
		client.close();
	});
	test("bounds response bodies and keeps credentials off signed log URLs", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://logs.example.com/signed" },
				}),
			)
			.mockImplementation(async () => new Response("failure logs"));
		const client = new GitHubClient({ fetch: fetcher });
		const log = await client.request({
			credential,
			api: "rest",
			path: "repos/acme/app/actions/jobs/1/logs",
			signal: signal(),
		});
		expect(log.body).toBe("failure logs");
		expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty("headers");
		await expect(
			client.request({
				credential,
				api: "rest",
				path: "user",
				signal: signal(),
				maxBytes: 2,
			}),
		).rejects.toMatchObject({ kind: "unknown" });
		client.close();
	});
	test("supports public, enterprise, and data-residency hosts", () => {
		expect(githubApiRoot("github.com")).toBe("https://api.github.com");
		expect(githubApiRoot("git.acme.com")).toBe("https://git.acme.com/api/v3");
		expect(githubApiRoot("acme.ghe.com")).toBe("https://api.acme.ghe.com");
		expect(() => githubApiRoot("github.com/path")).toThrow(
			"Invalid GitHub host",
		);
	});
});

test("cancelling one shared consumer does not cancel another; the final consumer stops work", async () => {
	const reads = new GitHubSharedReads();
	const first = new AbortController();
	const second = new AbortController();
	let aborted = false;
	const read = vi.fn(
		(sharedSignal: AbortSignal) =>
			new Promise<string>((_resolve, reject) =>
				sharedSignal.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				}),
			),
	);
	const a = reads.run("same", first.signal, read);
	const b = reads.run("same", second.signal, read);
	await Promise.resolve();
	first.abort();
	await expect(a).rejects.toBeDefined();
	expect(aborted).toBe(false);
	second.abort();
	await expect(b).rejects.toBeDefined();
	expect(aborted).toBe(true);
	expect(read).toHaveBeenCalledTimes(1);
});

test("enforces a 30-second dispatch deadline and releases the permit", async () => {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
		const controller = new AbortController();
		setTimeout(
			() => controller.abort(new DOMException("Timed out", "TimeoutError")),
			milliseconds,
		);
		return controller.signal;
	});
	const client = new GitHubClient({
		fetch: async (_url, input) =>
			new Promise<Response>((_resolve, reject) =>
				input?.signal?.addEventListener(
					"abort",
					() => reject(input.signal?.reason),
					{ once: true },
				),
			),
	});
	try {
		const request = client
			.request({ credential, api: "rest", path: "user", signal: signal() })
			.catch((error) => error);
		await vi.advanceTimersByTimeAsync(30_001);
		expect(await request).toMatchObject({ kind: "timeout" });
	} finally {
		client.close();
		vi.useRealTimers();
	}
});

test("actor scopes cannot reuse another member's credential lookup", async () => {
	const resolver = vi.fn(
		async (
			_host: string,
			_cwd: string,
			_signal: AbortSignal,
			scope?: { key: string },
		) => ({ token: scope?.key ?? "default" }),
	);
	const client = new GitHubClient({ resolveCredential: resolver });
	try {
		const a = await client.credential(
			{ ...repo, credentialScope: { key: "actor-a", body: "{}" } },
			signal(),
		);
		const b = await client.credential(
			{ ...repo, credentialScope: { key: "actor-b", body: "{}" } },
			signal(),
		);
		expect(a.fingerprint).not.toBe(b.fingerprint);
		expect(resolver).toHaveBeenCalledTimes(2);
	} finally {
		client.close();
	}
});
