import { describe, expect, test, vi } from "vitest";

import {
	hasCurrentLocalRoute,
	openVerifiedLocalRoute,
} from "../../../src/lib/local-route";

describe("verified local routes", () => {
	test("replaces a stale route when Bonjour republishes the same Mac", () => {
		expect(
			hasCurrentLocalRoute("route-generation-1", [
				{ routeId: "route-generation-2" },
			]),
		).toBe(false);
	});

	test("keeps the verified Bonjour route for app traffic", async () => {
		const verificationProxy = { id: "verify", host: "127.0.0.1", port: 1 };
		const open = vi.fn().mockResolvedValueOnce(verificationProxy);
		const close = vi.fn(async () => {});
		const verify = vi.fn(async () => {});

		const route = await openVerifiedLocalRoute({
			service: { id: "mac" },
			open,
			close,
			verify,
		});

		expect(route).toBe(verificationProxy);
		expect(verify).toHaveBeenCalledWith(verificationProxy);
		expect(close).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
	});

	test("closes the verification proxy when identity checking fails", async () => {
		const proxy = { id: "verify", host: "127.0.0.1", port: 1 };
		const close = vi.fn(async () => {});

		await expect(
			openVerifiedLocalRoute({
				service: { id: "mac" },
				open: vi.fn(async () => proxy),
				close,
				verify: vi.fn(async () => {
					throw new Error("wrong Mac");
				}),
			}),
		).rejects.toThrow("wrong Mac");
		expect(close).toHaveBeenCalledWith(proxy);
	});
});
