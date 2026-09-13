import { describe, expect, it } from "vitest";

import { rendererProxy } from "../../vite-proxy.ts";

describe("rendererProxy", () => {
	it.each([false, true])("proxies favicon images (hosted=%s)", (hosted) => {
		expect(rendererProxy(hosted, "http://127.0.0.1:8788")).toHaveProperty(
			"/assets/site-favicon",
			{ target: "http://127.0.0.1:8788" },
		);
	});

	it("keeps hosted authentication callbacks in the renderer", () => {
		expect(rendererProxy(true, "http://127.0.0.1:8788")).not.toHaveProperty(
			"/auth",
		);
	});

	it("preserves the authentication proxy for direct browser access", () => {
		expect(rendererProxy(false, "http://127.0.0.1:8788")).toHaveProperty(
			"/auth",
		);
	});
});
