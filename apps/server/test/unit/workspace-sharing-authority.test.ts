import { AuthTokenId } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { expect, it } from "vitest";
import { AuthTokenError } from "../../src/auth/errors.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import {
	WorkspaceSharingAuthority,
	WorkspaceSharingAuthorityLive,
} from "../../src/collaboration/services/workspace-sharing-authority.ts";
import { ConnectionIdentity } from "../../src/lan-auth/services/connection-identity.ts";

it("requires both a matching actor and authorization to use the current host account", async () => {
	let accountAllowed = true;
	let accountChecks = 0;
	const runtime = ManagedRuntime.make(
		WorkspaceSharingAuthorityLive.pipe(
			Layer.provide(
				Layer.succeed(AuthService, {
					getSession: () => Effect.succeed({ _tag: "SignedOut" }),
					signIn: () => Effect.succeed({ _tag: "SignedOut" }),
					signOut: () => Effect.void,
					sessionChanges: () => Stream.empty,
					getAccessToken: () =>
						Effect.suspend(() => {
							accountChecks++;
							return accountAllowed
								? Effect.succeed("never-return-this-token")
								: Effect.fail(
										new AuthTokenError({ reason: "Account changed" }),
									);
						}),
				}),
			),
		),
	);
	const authorize = Effect.flatMap(WorkspaceSharingAuthority, (authority) =>
		authority.authorize("owner"),
	);
	const connected = (subject: string, expiresAt = Date.now() + 60_000) =>
		authorize.pipe(
			Effect.provideService(ConnectionIdentity, {
				kind: "account",
				subject,
				expiresAt,
			}),
		);
	try {
		await expect(
			runtime.runPromise(
				authorize.pipe(
					Effect.provideService(ConnectionIdentity, {
						kind: "paired",
						tokenId: AuthTokenId.make("paired-device"),
						deviceId: null,
					}),
				),
			),
		).rejects.toMatchObject({ reason: "host_authorization_required" });
		await expect(runtime.runPromise(authorize)).rejects.toMatchObject({
			reason: "host_authorization_required",
		});
		await expect(
			runtime.runPromise(connected("teammate")),
		).rejects.toMatchObject({ reason: "host_authorization_required" });
		await expect(
			runtime.runPromise(connected("owner", Date.now() - 1)),
		).rejects.toMatchObject({ reason: "host_authorization_required" });
		expect(accountChecks).toBe(0);
		await expect(
			runtime.runPromise(connected("owner")),
		).resolves.toBeUndefined();
		expect(accountChecks).toBe(1);
		accountAllowed = false;
		await expect(runtime.runPromise(connected("owner"))).rejects.toMatchObject({
			reason: "host_authorization_required",
		});
		expect(accountChecks).toBe(2);
		await expect(
			runtime.runPromise(
				authorize.pipe(
					Effect.provideService(ConnectionIdentity, { kind: "local" }),
				),
			),
		).resolves.toBeUndefined();
		expect(accountChecks).toBe(2);
	} finally {
		await runtime.dispose();
	}
});
