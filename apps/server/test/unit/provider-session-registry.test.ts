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

	it.each([
		"explicit",
		"unexpected",
	] as const)("invalidates an in-flight generation on %s stop", (kind) => {
		const registry = makeProviderSessionRegistry<string, string>();
		const generation = registry.begin("session-1");

		expect(
			kind === "explicit"
				? registry.invalidate("session-1")
				: registry.invalidateIfCurrent("session-1", generation),
		).toBeUndefined();
		expect(registry.publish("session-1", generation, "late")).toBe(false);
		expect(registry.lookup("session-1")).toBeUndefined();
	});

	it("removes the current crashed handle and permits a later generation", () => {
		const registry = makeProviderSessionRegistry<string, string>();
		const crashedGeneration = registry.begin("session-1");
		expect(registry.publish("session-1", crashedGeneration, "crashed")).toBe(
			true,
		);

		expect(registry.invalidateIfCurrent("session-1", crashedGeneration)).toBe(
			"crashed",
		);
		expect(registry.lookup("session-1")).toBeUndefined();

		const restartedGeneration = registry.begin("session-1");
		expect(
			registry.publish("session-1", restartedGeneration, "restarted"),
		).toBe(true);
		expect(registry.lookup("session-1")).toBe("restarted");
	});

	it("does not let a stale process exit remove its replacement", () => {
		const registry = makeProviderSessionRegistry<string, string>();
		const staleGeneration = registry.begin("session-1");
		expect(registry.publish("session-1", staleGeneration, "stale")).toBe(true);

		registry.invalidate("session-1");
		const replacementGeneration = registry.begin("session-1");
		expect(
			registry.publish("session-1", replacementGeneration, "replacement"),
		).toBe(true);

		expect(
			registry.invalidateIfCurrent("session-1", staleGeneration),
		).toBeUndefined();
		expect(registry.lookup("session-1")).toBe("replacement");
	});
});
