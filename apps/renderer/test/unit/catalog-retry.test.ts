import { describe, expect, it, vi } from "vitest";

import {
	catalogRetryDelayMs,
	createCatalogRetryController,
} from "../../src/lib/catalog-retry.ts";

describe("catalogRetryDelayMs", () => {
	it("backs off quickly and stays capped at one minute", () => {
		expect([0, 1, 2, 3, 8].map(catalogRetryDelayMs)).toEqual([
			5_000, 15_000, 30_000, 60_000, 60_000,
		]);
	});
});

describe("createCatalogRetryController", () => {
	it("deduplicates timers and resets after a successful connection", () => {
		const scheduled: Array<{ delay: number; run: () => void }> = [];
		const cancel = vi.fn();
		const retry = vi.fn();
		const controller = createCatalogRetryController((delay, run) => {
			scheduled.push({ delay, run });
			return cancel;
		});

		controller.schedule("tailnet:one", retry);
		controller.schedule("tailnet:one", retry);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.delay).toBe(5_000);
		scheduled[0]?.run();
		expect(retry).toHaveBeenCalledTimes(1);

		controller.schedule("tailnet:one", retry);
		expect(scheduled[1]?.delay).toBe(15_000);
		controller.succeeded("tailnet:one");
		expect(cancel).toHaveBeenCalledTimes(1);

		controller.schedule("tailnet:one", retry);
		expect(scheduled[2]?.delay).toBe(5_000);
	});

	it("stops automatic recovery until a manual retry re-enables it", () => {
		const scheduled: Array<{ delay: number; run: () => void }> = [];
		const controller = createCatalogRetryController((delay, run) => {
			scheduled.push({ delay, run });
			return vi.fn();
		});
		const retry = vi.fn();

		controller.stop("ssh:one");
		controller.schedule("ssh:one", retry);
		expect(scheduled).toHaveLength(0);
		controller.prepareManualRetry("ssh:one");
		controller.schedule("ssh:one", retry);
		expect(scheduled).toHaveLength(1);
	});
});
