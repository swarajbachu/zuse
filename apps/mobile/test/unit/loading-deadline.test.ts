import { afterEach, describe, expect, it, vi } from "vitest";

import { startLoadingDeadline } from "../../src/lib/loading-deadline";

describe("home loading deadline", () => {
	afterEach(() => vi.useRealTimers());

	it("ends waiting at 30 seconds, only once", () => {
		vi.useFakeTimers();
		const expired = vi.fn();
		startLoadingDeadline(expired);
		vi.advanceTimersByTime(29_999);
		expect(expired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(expired).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_000);
		expect(expired).toHaveBeenCalledTimes(1);
	});

	it("cancels when loading completes or the screen unmounts", () => {
		vi.useFakeTimers();
		const expired = vi.fn();
		const cancel = startLoadingDeadline(expired);
		cancel();
		vi.advanceTimersByTime(30_000);
		expect(expired).not.toHaveBeenCalled();
	});

	it("gives a manual retry a fresh deadline without firing the old one", () => {
		vi.useFakeTimers();
		const expired = vi.fn();
		const cancel = startLoadingDeadline(expired);
		vi.advanceTimersByTime(20_000);
		cancel();
		startLoadingDeadline(expired);
		vi.advanceTimersByTime(10_000);
		expect(expired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(20_000);
		expect(expired).toHaveBeenCalledTimes(1);
	});
});
