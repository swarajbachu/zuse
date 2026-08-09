import { afterEach, describe, expect, it, vi } from "vitest";

import { InteractiveProcessRegistry } from "../../src/account-access/interactive-process-registry.ts";

const process = () => ({ kill: vi.fn() });

afterEach(() => vi.useRealTimers());

describe("InteractiveProcessRegistry", () => {
	it("replaces an older login and ignores its late cleanup", () => {
		const registry = new InteractiveProcessRegistry();
		const first = process();
		const second = process();

		registry.replace("first", first);
		registry.replace("second", second);

		expect(first.kill).toHaveBeenCalledOnce();
		expect(registry.release("first", first)).toBe(false);
		expect(registry.get("second")).toBe(second);
	});

	it("terminates a login that does not finish after code submission", () => {
		vi.useFakeTimers();
		const registry = new InteractiveProcessRegistry();
		const pending = process();
		registry.replace("pending", pending);

		expect(registry.armTimeout("pending", 90_000)).toBe(true);
		vi.advanceTimersByTime(90_000);

		expect(pending.kill).toHaveBeenCalledOnce();
		expect(registry.get("pending")).toBeUndefined();
	});
});
