import { describe, expect, it } from "vitest";

import {
	attachmentUrl,
	rendererPlatformCapabilities,
} from "../../src/lib/platform-capabilities.ts";

describe("renderer platform capabilities", () => {
	it("uses authenticated HTTP attachments and disables native surfaces in browsers", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {},
		});
		expect(rendererPlatformCapabilities()).toMatchObject({
			desktop: false,
			integratedBrowser: false,
			updater: false,
		});
		expect(attachmentUrl("image one")).toBe("/assets/attachments/image%20one");
	});

	it("retains privileged attachment URLs in Electron", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { zuse: { rpc: {}, browser: {}, updates: {} } },
		});
		expect(rendererPlatformCapabilities()).toMatchObject({
			desktop: true,
			integratedBrowser: true,
			updater: true,
		});
		expect(attachmentUrl("image-one")).toBe("zuse://attachments/image-one");
	});
});
