import { describe, expect, it } from "vitest";

import { createHostDescriptor } from "../../src/host/descriptor.ts";

describe("desktop host descriptor", () => {
	it("reports Linux desktop capabilities and Wayland", () => {
		const host = createHostDescriptor({
			platform: "linux",
			arch: "x64",
			packaged: true,
			env: { XDG_SESSION_TYPE: "wayland" },
		});

		expect(host).toMatchObject({
			platform: "linux",
			arch: "x64",
			packaged: true,
			displayServer: "wayland",
			capabilities: {
				backgroundService: "available",
				browserCookieImport: "available",
				deepEnergy: "unavailable",
				nearbyDiscovery: "available",
				notchTray: "unavailable",
			},
		});
	});

	it("requires explicit Windows capability states", () => {
		const host = createHostDescriptor({
			platform: "win32",
			arch: "x64",
			packaged: false,
		});

		expect(Object.keys(host.capabilities).sort()).toEqual([
			"backgroundService",
			"browserCookieImport",
			"deepEnergy",
			"nativeCredentialStore",
			"nearbyDiscovery",
			"notchTray",
			"openTargets",
			"powerTelemetry",
			"processInspection",
			"updater",
		]);
		expect(host.capabilities.browserCookieImport).toBe("unavailable");
		expect(host.capabilities.nearbyDiscovery).toBe("unavailable");
	});
});
