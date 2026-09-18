import { describe, expect, test } from "vitest";
import { readBoatEnvironment } from "../../src/boat-environment.ts";
import { resolveSandboxProviderRuntime } from "../../src/sandbox-provider-config.ts";

describe("Boat configuration migration", () => {
	test("uses an existing Box secret with Boat deployment settings", () => {
		const runtime = resolveSandboxProviderRuntime({
			BOAT_ADAPTER_ENABLED: "true",
			BOX_API_KEY: "legacy-secret",
			BOAT_TEMPLATE_SNAPSHOT: "zuse-base-v6",
			BOAT_TEMPLATE_VERSION: "6",
		});
		expect(runtime.configuredProviders).toContainEqual({
			providerId: "box",
			productionReady: true,
			advertised: true,
		});
	});
	test("prefers Boat values without reviving disabled or blank configuration", () => {
		expect(
			readBoatEnvironment({
				BOAT_API_KEY: "new",
				BOX_API_KEY: "old",
				BOAT_ADAPTER_ENABLED: "false",
				BOX_ADAPTER_ENABLED: "true",
				BOAT_TEMPLATE_SNAPSHOT: "",
				BOX_TEMPLATE_SNAPSHOT: "old",
			}),
		).toMatchObject({
			BOAT_API_KEY: "new",
			BOAT_ADAPTER_ENABLED: "false",
			BOAT_TEMPLATE_SNAPSHOT: "",
		});
	});
	test("retains the legacy webhook signing secret", () => {
		expect(
			readBoatEnvironment({ BOX_WEBHOOK_SECRET: "old" }).BOAT_WEBHOOK_SECRET,
		).toBe("old");
		expect(
			readBoatEnvironment({
				BOX_WEBHOOK_SECRET: "old",
				BOAT_WEBHOOK_SECRET: "new",
			}).BOAT_WEBHOOK_SECRET,
		).toBe("new");
	});
});
