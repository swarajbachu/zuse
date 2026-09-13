import { ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";

it("keeps managed cloud environments outside the hosted computer allowance", async () => {
	const runtime = ManagedRuntime.make(ApiStoreMemory);
	try {
		const store = await runtime.runPromise(ApiStore);
		const register = (
			id: string,
			kind: "cloud" | "desktop" | "ssh",
			limit: number | null,
		) =>
			runtime.runPromise(
				store.registerEnvironment(
					{
						environmentId: id,
						accountId: "account",
						providerKind: kind,
						environmentPublicKey: id,
						httpBaseUrl: "https://example.test",
						wsBaseUrl: "wss://example.test",
						linkedAtMs: 0,
					},
					limit,
					"preserve-identity",
				),
			);
		for (let i = 0; i < 9; i++)
			expect(await register(`cloud-${i}`, "cloud", null)).toBe(true);
		for (let i = 0; i < 5; i++)
			expect(
				await register(`computer-${i}`, i === 0 ? "ssh" : "desktop", 5),
			).toBe(true);
		expect(await register("extra-desktop", "desktop", 5)).toBe(false);
		expect(await register("computer-1", "desktop", 5)).toBe(true);
		expect(await register("another-cloud", "cloud", null)).toBe(true);
	} finally {
		await runtime.dispose();
	}
});
