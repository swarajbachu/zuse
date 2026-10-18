import {
	type GitHubObservation,
	type GitHubTarget,
	RpcAccessDeniedError,
} from "@zuse/contracts";
import { emptyPr } from "@zuse/git/github-pr-info";
import { afterEach, expect, test, vi } from "vitest";
import {
	GitHubObserver,
	githubTargetFromSummary,
} from "../../src/github-observer.ts";

const target: GitHubTarget = {
	host: "github.com",
	owner: "acme",
	repo: "app",
	branch: "feature",
	headOwner: "alice",
};
const observation: GitHubObservation = {
	pr: {
		...emptyPr("feature"),
		state: "open",
		number: 42,
		observedAt: new Date(1000),
	},
	details: null,
};
afterEach(() => vi.useRealTimers());

test("subscribers share one independent read and continue polling without a runtime", async () => {
	vi.useFakeTimers();
	const read = vi.fn(async () => observation);
	const observer = new GitHubObserver(read);
	const first = observer.subscribe(target, vi.fn());
	const second = observer.subscribe(target, vi.fn());
	await observer.refresh(target);
	expect(read).toHaveBeenCalledTimes(1);
	expect(observer.snapshot(target).value?.pr.number).toBe(42);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(read).toHaveBeenCalledTimes(2);
	first();
	second();
	await vi.advanceTimersByTimeAsync(600_000);
	expect(read).toHaveBeenCalledTimes(2);
	observer.clear();
});

test("transient failures retain the last success, back off, and recover", async () => {
	vi.useFakeTimers();
	const read = vi
		.fn()
		.mockResolvedValueOnce(observation)
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(observation);
	const observer = new GitHubObserver(read);
	const stop = observer.subscribe(target, vi.fn());
	await observer.refresh(target);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(observer.snapshot(target)).toMatchObject({
		error: "offline",
		value: { pr: { number: 42, stale: true } },
	});
	await vi.advanceTimersByTimeAsync(60_000);
	expect(observer.snapshot(target)).toMatchObject({
		error: null,
		value: { pr: { number: 42, stale: false } },
	});
	stop();
	observer.clear();
});

test("an authorization failure clears private data instead of presenting a stale PR", async () => {
	const read = vi
		.fn()
		.mockResolvedValueOnce(observation)
		.mockResolvedValue({
			pr: emptyPr("feature", "authentication"),
			details: null,
		});
	const observer = new GitHubObserver(read);
	await observer.refresh(target);
	await observer.refresh(target, true);
	expect(observer.snapshot(target).value?.pr).toMatchObject({
		state: "none",
		number: null,
		prCapability: "authentication",
	});
	observer.clear();
});

test("account reset fences a late response and cancels its request", async () => {
	let complete: (value: GitHubObservation) => void = () => {};
	let signal: AbortSignal | undefined;
	const observer = new GitHubObserver(async (_input, requestSignal) => {
		signal = requestSignal;
		return new Promise((resolve) => {
			complete = resolve;
		});
	});
	const pending = observer.refresh(target);
	observer.clear();
	expect(signal?.aborted).toBe(true);
	complete(observation);
	await pending;
	expect(observer.snapshot(target).value).toBeNull();
	observer.clear();
});

test("a first failure is actionable rather than an endless empty loading state", async () => {
	const observer = new GitHubObserver(async () => {
		throw new Error("Network unavailable");
	});
	await observer.refresh(target);
	expect(observer.snapshot(target)).toMatchObject({
		error: "Network unavailable",
		value: {
			pr: {
				prCapability: "unknown",
				observationError: "Network unavailable",
				stale: true,
			},
		},
	});
	observer.clear();
});

test("retained identity works for paused workspaces, and branch/fork changes have separate observations", async () => {
	expect(
		githubTargetFromSummary({
			repositoryIdentity: "github.com/acme/app",
			branch: "feature",
		}),
	).toMatchObject({
		host: "github.com",
		owner: "acme",
		repo: "app",
		branch: "feature",
	});
	expect(
		githubTargetFromSummary({
			repositoryIdentity: "../../",
			branch: "feature",
		}),
	).toBeNull();
	const observer = new GitHubObserver(
		async () => observation,
		() => observation,
	);
	expect(observer.snapshot(target).value?.pr.stale).toBe(true);
	expect(observer.key(target)).not.toEqual(
		observer.key({ ...target, headOwner: "bob" }),
	);
	expect(observer.key(target)).not.toEqual(
		observer.key({ ...target, branch: "other" }),
	);
	observer.clear();
});

test("a transport that never settles cannot leave observation pending forever", async () => {
	vi.useFakeTimers();
	const observer = new GitHubObserver(() => new Promise(() => {}));
	const stop = observer.subscribe(target, vi.fn());
	const pending = observer.refresh(target);
	await vi.advanceTimersByTimeAsync(30_000);
	await pending;
	expect(observer.snapshot(target)).toMatchObject({
		error: "GitHub request timed out.",
		value: { pr: { stale: true, prCapability: "timeout" } },
	});
	stop();
	observer.clear();
});

test("automatic polling respects GitHub's retry deadline", async () => {
	vi.useFakeTimers();
	const read = vi.fn(async () => ({
		pr: {
			...emptyPr("feature", "rate_limited"),
			retryAt: new Date(Date.now() + 180_000),
		},
		details: null,
	}));
	const observer = new GitHubObserver(read);
	const stop = observer.subscribe(target, vi.fn());
	await observer.refresh(target);
	await vi.advanceTimersByTimeAsync(179_999);
	expect(read).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(2);
	stop();
	observer.clear();
});

test("cache-only subscribers receive updates without starting another poll", async () => {
	const read = vi.fn(async () => observation);
	const observer = new GitHubObserver(read);
	const listener = vi.fn();
	const stop = observer.subscribe(target, listener, false);
	expect(read).not.toHaveBeenCalled();
	await observer.refresh(target);
	expect(listener).toHaveBeenCalled();
	expect(observer.snapshot(target).value?.pr.number).toBe(42);
	stop();
	observer.clear();
});

test("PR details are shared with cache-only surfaces and survive status refreshes", async () => {
	const { emptyDetails } = await import("@zuse/git/github-observations");
	const details = {
		...emptyDetails,
		state: "open" as const,
		number: 42,
		title: "Shared details",
	};
	const read = vi.fn(async (input: { details?: boolean }) => ({
		...observation,
		details: input.details ? details : null,
	}));
	const observer = new GitHubObserver(read);
	await observer.refresh(target);
	await Promise.all([
		observer.details(target, new AbortController().signal),
		observer.details(target, new AbortController().signal),
	]);
	expect(read).toHaveBeenCalledTimes(2);
	expect(observer.snapshot(target).value?.details?.title).toBe(
		"Shared details",
	);
	await observer.refresh(target);
	expect(observer.snapshot(target).value?.details?.title).toBe(
		"Shared details",
	);
	observer.clear();
	expect(observer.snapshot(target).value).toBeNull();
	observer.clear();
});

for (const cached of [false, true]) {
	for (const code of ["access-denied", "credential-expired"] as const) {
		test(`RPC ${code} is classified and clears private data with cached=${cached}`, async () => {
			const observer = new GitHubObserver(
				async () => {
					throw new RpcAccessDeniedError({ code });
				},
				cached ? () => observation : undefined,
			);
			await observer.refresh(target);
			expect(observer.snapshot(target).value).toMatchObject({
				pr: {
					prCapability: code === "access-denied" ? "access" : "authentication",
					state: "none",
					number: null,
					stale: true,
				},
				details: null,
			});
			observer.clear();
		});
	}
}

test("an unclassified failure replaces an outdated offline classification", async () => {
	const observer = new GitHubObserver(
		async () => {
			throw new Error("Unexpected response");
		},
		() => ({
			...observation,
			pr: { ...observation.pr, prCapability: "offline" },
		}),
	);
	await observer.refresh(target);
	expect(observer.snapshot(target).value?.pr).toMatchObject({
		number: 42,
		prCapability: "unknown",
		stale: true,
	});
	observer.clear();
});
