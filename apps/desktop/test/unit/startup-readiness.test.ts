import { describe, expect, it, vi } from "vitest";

import { startOptionalServicesAfterCritical } from "../../src/startup-readiness.ts";

describe("desktop startup readiness", () => {
	it("launches the critical runtime before optional services", () => {
		const order: string[] = [];
		const never = new Promise<void>(() => {});
		const result = startOptionalServicesAfterCritical(
			() => {
				order.push("runtime");
				return "runtime-handle";
			},
			{
				ssh: () => {
					order.push("ssh");
					return never;
				},
				tailnet: () => {
					order.push("tailnet");
					return never;
				},
				browserCookies: () => {
					order.push("cookies");
					return never;
				},
			},
		);

		expect(result.critical).toBe("runtime-handle");
		expect(order).toEqual(["runtime", "ssh", "tailnet", "cookies"]);
	});

	it("keeps readiness failures observable without blocking other services", async () => {
		const onFailure = vi.fn();
		const result = startOptionalServicesAfterCritical(
			() => "runtime-handle",
			{
				ssh: async () => {
					throw new Error("ssh load failed");
				},
				tailnet: async () => {},
				browserCookies: async () => {},
			},
			onFailure,
		);

		await expect(result.readiness.ssh).rejects.toThrow("ssh load failed");
		await expect(result.readiness.tailnet).resolves.toBeUndefined();
		expect(onFailure).toHaveBeenCalledWith("ssh", expect.any(Error));
	});
});
