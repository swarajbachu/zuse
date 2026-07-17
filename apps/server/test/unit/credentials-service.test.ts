import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const keytar = vi.hoisted(() => ({
	deletePassword: vi.fn(async () => false),
	findCredentials: vi.fn(async () => []),
	getPassword: vi.fn(async () => null),
	setPassword: vi.fn(async () => undefined),
}));

vi.mock("keytar", () => ({ default: keytar }));

import { CredentialsServiceLive } from "../../src/provider/layers/credentials-service.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

describe("CredentialsService", () => {
	it("does not enumerate legacy keychain entries during startup discovery", async () => {
		const configured = await Effect.runPromise(
			Effect.gen(function* () {
				const credentials = yield* CredentialsService;
				return yield* credentials.listConfigured();
			}).pipe(Effect.provide(CredentialsServiceLive)),
		);

		expect(configured).toEqual([]);
		expect(keytar.findCredentials).toHaveBeenCalledTimes(1);
		expect(keytar.findCredentials).toHaveBeenCalledWith("zuse");
	});
});
