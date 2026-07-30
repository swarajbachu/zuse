import { describe, expect, it, vi } from "vitest";

import { installPowerMonitorEventSampling } from "../../src/power-monitor-events.ts";

describe("power monitor event sampling", () => {
	it("samples battery, AC, suspend, resume, and thermal transitions", () => {
		const listeners = new Map<string, () => void>();
		const source = {
			on: vi.fn((event: string, listener: () => void) => {
				listeners.set(event, listener);
			}),
			off: vi.fn((event: string) => {
				listeners.delete(event);
			}),
		};
		const sample = vi.fn();
		const dispose = installPowerMonitorEventSampling({
			source,
			sample,
			includeThermalState: true,
		});

		for (const event of [
			"on-ac",
			"on-battery",
			"suspend",
			"resume",
			"thermal-state-change",
		]) {
			listeners.get(event)?.();
		}
		expect(sample).toHaveBeenCalledTimes(5);

		dispose();
		expect(listeners.size).toBe(0);
		expect(source.off).toHaveBeenCalledTimes(5);
	});
});
