import { describe, expect, test, vi } from "vitest";

import { scrollListToLatest } from "../../../src/lib/legend-list-scroll";

describe("scrollListToLatest", () => {
	test("prepares the virtual destination before finishing on the native keyboard-aware range", async () => {
		const calls: string[] = [];
		const nativeScrollToEnd = vi.fn(() => {
			calls.push("native");
		});
		const list = {
			getNativeScrollRef: () => ({ scrollToEnd: nativeScrollToEnd }),
			scrollToEnd: vi.fn(async () => {
				calls.push("virtual");
			}),
		};

		await scrollListToLatest(list, {
			animated: false,
			afterVirtualLayout: async () => {
				calls.push("layout");
			},
		});

		expect(calls).toEqual(["virtual", "layout", "native"]);
		expect(nativeScrollToEnd).toHaveBeenCalledWith({ animated: false });
	});

	test("still succeeds when a native scroll ref is unavailable", async () => {
		const list = {
			getNativeScrollRef: () => null,
			scrollToEnd: vi.fn(async () => undefined),
		};

		await expect(
			scrollListToLatest(list, {
				animated: true,
				afterVirtualLayout: async () => undefined,
			}),
		).resolves.toBeUndefined();
	});
});
