import { Effect, Exit } from "effect";

import { SessionStoreLive } from "../auth/layers/session-store.ts";
import { refreshSession } from "../auth/layers/workos.ts";
import {
	type DeviceAuthorizationGrant,
	pollDeviceAuthorization,
	requestDeviceAuthorization,
} from "../auth/layers/workos-device-auth.ts";
import { SessionStore } from "../auth/services/session-store.ts";

export interface ServeDeviceLoginOptions {
	readonly clientId: string;
	readonly onPrompt: (grant: DeviceAuthorizationGrant) => void | Promise<void>;
}

export const ensureServeSession = (
	options: ServeDeviceLoginOptions,
): Effect.Effect<{ readonly email: string }, Error> =>
	Effect.gen(function* () {
		if (options.clientId.trim().length === 0) {
			return yield* Effect.fail(
				new Error(
					"Zuse Serve authentication is unavailable because WORKOS_CLIENT_ID is not configured.",
				),
			);
		}
		const store = yield* SessionStore;
		const existing = yield* store
			.read()
			.pipe(Effect.mapError((cause) => new Error(cause.reason)));
		if (existing !== null) {
			if (existing.expiresAt - Date.now() > 60_000) {
				return { email: existing.user.email };
			}
			const refreshed = yield* Effect.exit(
				refreshSession(options.clientId, existing.refreshToken),
			);
			if (Exit.isSuccess(refreshed)) {
				yield* store
					.write(refreshed.value)
					.pipe(Effect.mapError((cause) => new Error(cause.reason)));
				return { email: refreshed.value.user.email };
			}
			yield* store
				.clear()
				.pipe(Effect.mapError((cause) => new Error(cause.reason)));
		}

		const grant = yield* Effect.tryPromise({
			try: () => requestDeviceAuthorization(options.clientId),
			catch: (cause) =>
				cause instanceof Error ? cause : new Error(String(cause)),
		});
		yield* Effect.tryPromise({
			try: async () => options.onPrompt(grant),
			catch: (cause) =>
				cause instanceof Error ? cause : new Error(String(cause)),
		});
		const session = yield* Effect.tryPromise({
			try: () => pollDeviceAuthorization(options.clientId, grant),
			catch: (cause) =>
				cause instanceof Error ? cause : new Error(String(cause)),
		});
		yield* store
			.write(session)
			.pipe(Effect.mapError((cause) => new Error(cause.reason)));
		return { email: session.user.email };
	}).pipe(Effect.provide(SessionStoreLive));
