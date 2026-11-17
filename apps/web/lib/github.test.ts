import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getGitHubStars } from "./github";

afterEach(() => vi.unstubAllGlobals());

it("fetches the active repository with a five-minute cache lifetime", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify({ stargazers_count: 33 })));
	vi.stubGlobal("fetch", fetch);
	expect(await getGitHubStars()).toBe(33);
	expect(fetch).toHaveBeenCalledWith(
		"https://api.github.com/repos/opcodehq/zuse",
		expect.objectContaining({ next: { revalidate: 300 } }),
	);
});

it("uses refreshed upstream counts rather than a fixed display value", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ stargazers_count: 2 })),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ stargazers_count: 33 })),
			),
	);
	expect(await getGitHubStars()).toBe(2);
	expect(await getGitHubStars()).toBe(33);
});

it.each([
	new Response("rate limited", { status: 403 }),
	new Response("{}"),
])("omits unavailable counts", async (response) => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
	expect(await getGitHubStars()).toBeNull();
});
