import { Effect } from "effect";
import { describe, expect, it, type Mock, vi } from "vitest";

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
	it("discovers API keys without decrypting unrelated keychain entries", async () => {
		keytar.findCredentials.mockRejectedValue(
			new Error("would prompt for an unrelated integration credential"),
		);
		const credentialLookup = keytar.getPassword as unknown as Mock<
			(service: string, account: string) => Promise<string | null>
		>;
		credentialLookup.mockImplementation(async (service, account) =>
			service === "zuse" && account === "apiKey:codex" ? "" : null,
		);

		const configured = await Effect.runPromise(
			Effect.gen(function* () {
				const credentials = yield* CredentialsService;
				return yield* credentials.listConfigured();
			}).pipe(Effect.provide(CredentialsServiceLive)),
		);

		expect(configured).toEqual(["codex"]);
		expect(keytar.findCredentials).not.toHaveBeenCalled();
		expect(keytar.getPassword).toHaveBeenCalledWith("zuse", "apiKey:codex");
	});
});
