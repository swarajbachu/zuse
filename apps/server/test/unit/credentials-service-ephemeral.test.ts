import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CredentialsServiceEphemeral } from "../../src/provider/layers/credentials-service.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

const run = <A>(effect: Effect.Effect<A, unknown, CredentialsService>) =>
	Effect.runPromise(effect.pipe(Effect.provide(CredentialsServiceEphemeral)));

describe("ephemeral credentials", () => {
	it("keeps provider, browser, and auth values process-local", async () => {
		const stored = await run(
			Effect.gen(function* () {
				const credentials = yield* CredentialsService;
				yield* credentials.set("gemini", "test-key");
				yield* credentials.setBrowser(
					"https://example.test/login",
					"tester",
					"secret",
				);
				yield* credentials.setWorkosSession("session-bundle");
				return {
					provider: yield* credentials.get("gemini"),
					browser: yield* credentials.getBrowser("https://example.test/other"),
					auth: yield* credentials.getWorkosSession(),
				};
			}),
		);
		expect(stored).toEqual({
			provider: "test-key",
			browser: { username: "tester", password: "secret" },
			auth: "session-bundle",
		});

		const fresh = await run(
			Effect.flatMap(CredentialsService, (credentials) =>
				Effect.all({
					provider: credentials.get("gemini"),
					browser: credentials.listBrowser(),
					auth: credentials.getWorkosSession(),
				}),
			),
		);
		expect(fresh).toEqual({ provider: null, browser: [], auth: null });
	});
});
