import { Context, Effect, Layer, Redacted } from "effect";

import { RelayConfiguration } from "./config.ts";
import { type RelayError, serviceUnavailable } from "./errors.ts";

export interface AccountIdentityApi {
	readonly deleteUser: (accountId: string) => Effect.Effect<void, RelayError>;
}

export class AccountIdentity extends Context.Service<
	AccountIdentity,
	AccountIdentityApi
>()("@zuse/relay/AccountIdentity") {}

export const AccountIdentityLive: Layer.Layer<
	AccountIdentity,
	never,
	RelayConfiguration
> = Layer.effect(
	AccountIdentity,
	Effect.gen(function* () {
		const config = yield* RelayConfiguration;
		return AccountIdentity.of({
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
