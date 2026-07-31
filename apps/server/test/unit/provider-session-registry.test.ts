import { describe, expect, it } from "vitest";
import { makeProviderSessionRegistry } from "../../src/provider/provider-session-registry.ts";

describe("provider session registry", () => {
	it("rejects a provider that finishes after a newer selection", () => {
		const registry = makeProviderSessionRegistry<string, string>();
		const oldGeneration = registry.begin("session-1");

		registry.invalidate("session-1");
		const currentGeneration = registry.begin("session-1");

		expect(registry.publish("session-1", currentGeneration, "grok")).toBe(true);
		expect(registry.publish("session-1", oldGeneration, "codex")).toBe(false);
		expect(registry.lookup("session-1")).toBe("grok");
	});

	it("invalidates an in-flight generation even without a published handle", () => {
		const registry = makeProviderSessionRegistry<string, string>();
		const generation = registry.begin("session-1");

		expect(registry.invalidate("session-1")).toBeUndefined();
		expect(registry.publish("session-1", generation, "late")).toBe(false);
		expect(registry.lookup("session-1")).toBeUndefined();
	});
});
