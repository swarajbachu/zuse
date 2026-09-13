import { describe, expect, it, vi } from "vitest";

import { fetchSiteFavicon } from "../../src/site-favicon.js";

describe("fetchSiteFavicon", () => {
	it("returns image bytes with safe cache headers", async () => {
		const bytes = new Uint8Array([137, 80, 78, 71]);
		const fetchImage = vi.fn(
			async () =>
				new Response(bytes, {
					headers: {
						"content-type": "image/png",
						"content-encoding": "gzip",
						"content-length": "123",
						"set-cookie": "upstream=1",
					},
				}),
		);
		const response = await fetchSiteFavicon("github.com", fetchImage);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-control")).toContain("max-age=86400");
		for (const header of ["content-encoding", "content-length", "set-cookie"]) {
			expect(response.headers.has(header)).toBe(false);
		}
		expect(fetchImage).toHaveBeenCalledWith(
			"https://www.google.com/s2/favicons?domain=github.com&sz=64",
			{ signal: expect.any(AbortSignal) },
		);
	});

	it.each([
		"%",
		"",
		"example.com%2Fsecret",
		"example.com%3Fx=1",
		"a".repeat(254),
	])("rejects invalid host input %s without fetching", async (hostname) => {
		const fetchImage = vi.fn();
		expect((await fetchSiteFavicon(hostname, fetchImage)).status).toBe(400);
		expect(fetchImage).not.toHaveBeenCalled();
	});

	it.each([404, 500])("handles upstream status %s", async (status) => {
		const response = await fetchSiteFavicon(
			"example.com",
			async () => new Response(null, { status }),
		);
		expect(response.status).toBe(404);
		expect(response.headers.has("cache-control")).toBe(false);
	});

	it("rejects non-image responses", async () => {
		const response = await fetchSiteFavicon(
			"example.com",
			async () =>
				new Response("<html>unavailable</html>", {
					headers: { "content-type": "text/html" },
				}),
		);
		expect(response.status).toBe(404);
	});

	it("handles offline requests", async () => {
		const response = await fetchSiteFavicon("example.com", async () => {
			throw new TypeError("network unavailable");
		});
		expect(response.status).toBe(404);
	});

	it("handles interrupted image bodies", async () => {
		const response = await fetchSiteFavicon(
			"example.com",
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("connection reset"));
						},
					}),
					{ headers: { "content-type": "image/png" } },
				),
		);
		expect(response.status).toBe(404);
	});

	it("aborts stalled downloads", async () => {
		const response = await fetchSiteFavicon(
			"example.com",
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		expect(response.status).toBe(404);
	}, 7_000);
});
