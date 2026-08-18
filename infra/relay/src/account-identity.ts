import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { RelayConfiguration } from "./config.ts";
import { type RelayError, serviceUnavailable } from "./errors.ts";

export interface AccountIdentityApi {
	readonly deleteUser: (accountId: string) => Effect.Effect<void, RelayError>;
	readonly verifiedEmail: (
		accountId: string,
	) => Effect.Effect<string | null, RelayError>;
}

export class AccountIdentity extends Context.Service<
	AccountIdentity,
	AccountIdentityApi
>()("@zuse/relay/AccountIdentity") {}

const WorkosUser = Schema.Struct({
	email: Schema.String,
	email_verified: Schema.Boolean,
});

export const AccountIdentityLive: Layer.Layer<
	AccountIdentity,
	never,
	RelayConfiguration
> = Layer.effect(
	AccountIdentity,
	Effect.gen(function* () {
		const config = yield* RelayConfiguration;
		const workosUser = Effect.fn("AccountIdentity.workosUser")(function* (
			accountId: string,
		) {
			const apiKey = config.workosApiKey;
			if (apiKey === undefined) {
				return yield* Effect.fail(
					serviceUnavailable("account_identity_unavailable"),
				);
			}
			const body = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(
						`https://api.workos.com/user_management/users/${encodeURIComponent(accountId)}`,
						{ headers: { authorization: `Bearer ${Redacted.value(apiKey)}` } },
					);
					if (!response.ok) throw new Error(`identity_get_${response.status}`);
					return response.json();
				},
				catch: (cause) =>
					serviceUnavailable(
						"account_identity_failed",
						cause instanceof Error ? cause.message : String(cause),
					),
			});
			return yield* Schema.decodeUnknownEffect(WorkosUser)(body).pipe(
				Effect.mapError((cause) =>
					serviceUnavailable("account_identity_failed", String(cause)),
				),
			);
		});
		return AccountIdentity.of({
			verifiedEmail: (accountId) =>
				workosUser(accountId).pipe(
					Effect.map((user) =>
						user.email_verified ? user.email.trim().toLowerCase() : null,
					),
				),
			deleteUser: (accountId) => {
				const apiKey = config.workosApiKey;
				if (apiKey === undefined) {
					return Effect.fail(
						serviceUnavailable("account_deletion_unavailable"),
					);
				}
				return Effect.tryPromise({
					try: async () => {
						const response = await fetch(
							`https://api.workos.com/user_management/users/${encodeURIComponent(accountId)}`,
							{
								method: "DELETE",
								headers: {
									authorization: `Bearer ${Redacted.value(apiKey)}`,
								},
							},
						);
						// A missing identity means a previous deletion already completed.
						if (!response.ok && response.status !== 404) {
							throw new Error(`identity_delete_${response.status}`);
						}
					},
					catch: (cause) =>
						serviceUnavailable(
							"account_deletion_failed",
							cause instanceof Error ? cause.message : String(cause),
						),
				});
			},
		});
	}),
);
