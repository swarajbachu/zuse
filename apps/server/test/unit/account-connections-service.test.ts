import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSession, type AuthState, AuthUser } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { accountModelConnections } from "../../src/harness/account-connections-service.ts";
import { RuntimeModelConnections } from "../../src/harness/account-vault.ts";
import { makeFileCredentialsService } from "../../src/provider/layers/file-credentials-service.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
it("reads account model connections without registering or linking the desktop", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-unpublished-account-"));
	directories.push(directory);
	vi.stubEnv("ZUSE_API_URL", "https://api-staging.zuse.sh");
	const session: AuthState = {
		_tag: "SignedIn",
		session: AuthSession.make({
			user: AuthUser.make({
				id: "account-a",
				email: "a@example.test",
				firstName: null,
				lastName: null,
				profilePictureUrl: null,
			}),
			organizationId: null,
			expiresAt: Date.now() + 60000,
		}),
	};
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			return Response.json({
				value:
					body.action === "acquire" ? true : body.action === "list" ? [] : null,
			});
		});
	const layer = Layer.mergeAll(
		makeFileCredentialsService(directory),
		Layer.succeed(RuntimeModelConnections, { current: null }),
		Layer.succeed(AuthService, {
			getSession: () => Effect.succeed(session),
			getAccessToken: () => Effect.succeed("account-token"),
			signIn: () => Effect.succeed(session),
			signOut: () => Effect.void,
			sessionChanges: () => Stream.empty,
		}),
	);
	const status = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const credentials = yield* CredentialsService;
				const account = yield* accountModelConnections(
					credentials,
					directory,
					false,
				);
				const service = yield* account();
				if (service === null)
					throw new Error(
						"Account connections require an unnecessary desktop registration",
					);
				return yield* service.service.status();
			}),
		).pipe(Effect.provide(layer)),
	);
	expect(status.connections).toEqual([]);
	expect(fetch).toHaveBeenCalled();
	for (const [url, init] of fetch.mock.calls) {
		expect(url).toBe(
			"https://api-staging.zuse.sh/v1/model-connections/storage",
		);
		expect(init?.headers).toMatchObject({
			authorization: "Bearer account-token",
		});
	}
});
