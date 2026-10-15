import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	loadPricingTable,
	resetPricingCache,
} from "../../src/pricing/litellm.ts";

const directories: string[] = [];
afterEach(() => {
	resetPricingCache();
	vi.unstubAllGlobals();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

it("prices usage immediately while a slow pricing download runs in the background", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "usage-pricing-"));
	directories.push(cacheDir);
	let finish!: (response: Response) => void;
	const download = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	const fetcher = vi.fn(() => download);
	vi.stubGlobal("fetch", fetcher);
	let loaded = false;
	const pending = loadPricingTable({ cacheDir, preferCached: true }).then(
		(table) => {
			loaded = true;
			return table;
		},
	);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	try {
		expect(loaded).toBe(true);
		expect((await pending).size).toBeGreaterThan(0);
		const other = await loadPricingTable({ cacheDir, preferCached: true });
		expect(other.size).toBeGreaterThan(0);
		expect(fetcher).toHaveBeenCalledTimes(1);
	} finally {
		finish(
			new Response(
				JSON.stringify({ "test-model": { input_cost_per_token: 0.01 } }),
			),
		);
		await pending;
		await loadPricingTable({ cacheDir });
	}
	expect(
		(await loadPricingTable({ cacheDir, preferCached: true })).get("test-model")
			?.input_cost_per_token,
	).toBe(0.01);
});

it("refreshes expired in-memory prices after 24 hours", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "usage-pricing-expiry-"));
	directories.push(cacheDir);
	const firstTime = Date.now();
	const later = firstTime + 24 * 60 * 60 * 1000 + 1;
	const response = (price: number) =>
		new Response(
			JSON.stringify({ "test-model": { input_cost_per_token: price } }),
		);
	let finish!: (response: Response) => void;
	const download = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(response(0.01))
		.mockReturnValueOnce(download);
	vi.stubGlobal("fetch", fetcher);
	await loadPricingTable({ cacheDir, now: firstTime });
	utimesSync(
		join(cacheDir, "litellm-prices.json"),
		new Date(firstTime),
		new Date(firstTime),
	);
	try {
		expect(
			(
				await loadPricingTable({ cacheDir, now: later, preferCached: true })
			).get("test-model")?.input_cost_per_token,
		).toBe(0.01);
		expect(fetcher).toHaveBeenCalledTimes(2);
	} finally {
		finish(response(0.02));
		await loadPricingTable({ cacheDir, now: later });
	}
	expect(
		(await loadPricingTable({ cacheDir, now: later })).get("test-model")
			?.input_cost_per_token,
	).toBe(0.02);
});
