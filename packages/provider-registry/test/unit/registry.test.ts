import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { makeProviderRegistry } from "../../src/index.ts";

describe("provider registry", () => {
	test("rejects unsafe configurations", async () => {
		const duplicate = await Effect.runPromise(
			makeProviderRegistry({
				adapters: [{ providerId: "one" }, { providerId: "one" }],
				defaultProviderId: "one",
			}).pipe(Effect.flip),
		);
		const invalid = await Effect.runPromise(
			makeProviderRegistry({
				adapters: [{ providerId: "Not Valid" }],
				defaultProviderId: "Not Valid",
			}).pipe(Effect.flip),
		);
		const missingDefault = await Effect.runPromise(
			makeProviderRegistry({
				adapters: [{ providerId: "one" }],
				defaultProviderId: "two",
			}).pipe(Effect.flip),
		);

		expect(duplicate.code).toBe("duplicate-provider-id");
		expect(invalid.code).toBe("invalid-provider-id");
		expect(missingDefault.code).toBe("default-provider-not-registered");
	});
});
